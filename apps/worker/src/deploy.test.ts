/**
 * Regression tests for the deployment hardening in deploy/ (security review SEC-07..SEC-10):
 * pinned images, internal-only GPU services, resource limits, and per-container env files with the
 * deploy/check-env.sh guard that deploy/compose.sh runs before every compose command.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@etsy-agents/core/config/env.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const compose = read('deploy/docker-compose.yml');

/** Top-level service blocks of docker-compose.yml (2-space indented keys under `services:`), as raw text. */
function serviceBlocks(): Map<string, string> {
  const body = compose.slice(compose.indexOf('\nservices:\n'), compose.indexOf('\nnetworks:\n'));
  const out = new Map<string, string>();
  const re = /^ {2}([a-z][a-z0-9-]*):\n((?:(?: {4}.*)?\n)*)/gm;
  for (const m of body.matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}

const DIGEST = /@sha256:[0-9a-f]{64}$/;

describe('deploy: image provenance (SEC-07)', () => {
  it('pins every third-party image by version and digest', () => {
    const images = [...compose.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
    expect(images.length).toBeGreaterThan(5);
    for (const image of images) {
      if (image === '*ollama-image' || /^etsy-agents\/[a-z-]+:local$/.test(image)) continue;
      expect(image, image).toMatch(DIGEST);
      expect(image, image).not.toMatch(/:latest@/);
    }
    const ollama = /^x-ollama-image: &ollama-image \$\{OLLAMA_IMAGE:-(\S+)\}$/m.exec(compose);
    expect(ollama?.[1]).toMatch(/^ollama\/ollama:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    for (const file of ['deploy/Dockerfile.worker', 'apps/desk/Dockerfile.desk']) {
      expect(read(file)).toMatch(/^ARG NODE_IMAGE=node:22\.\d+\.\d+-slim@sha256:[0-9a-f]{64}$/m);
    }
    expect(read('apps/imagegen/Dockerfile')).toMatch(/^ARG CUDA_IMAGE=\S+@sha256:[0-9a-f]{64}$/m);
  });
});

describe('deploy: network exposure and limits (SEC-08, SEC-09)', () => {
  const services = serviceBlocks();

  it('parses every service of the compose file', () => {
    expect([...services.keys()].sort()).toEqual(
      ['desk', 'imagegen', 'imagegen-download', 'init-volumes', 'migrate', 'ollama', 'ollama-pull', 'postgres', 'worker'],
    );
  });

  it('keeps ollama, imagegen and postgres off the internet; only the setup one-shots get egress', () => {
    for (const name of ['ollama', 'imagegen', 'postgres', 'migrate']) {
      expect(services.get(name), name).toMatch(/^ {4}networks: \[backend\]$/m);
    }
    for (const name of ['ollama-pull', 'imagegen-download']) {
      expect(services.get(name), name).toMatch(/^ {4}profiles: \[setup\]$/m);
    }
    expect(services.get('imagegen')).toMatch(/HF_HUB_OFFLINE: \$\{IMAGEGEN_HF_OFFLINE:-1\}/);
    expect(compose).toMatch(/^ {2}backend:\n {4}internal: true$/m);
  });

  it('runs the GPU services only in their own profiles, so a cloud-only host needs no GPU', () => {
    expect(services.get('ollama')).toMatch(/^ {4}profiles: \[ollama\]$/m);
    expect(services.get('imagegen')).toMatch(/^ {4}profiles: \[imagegen\]$/m);
    // The worker waits for Ollama only when it runs.
    expect(services.get('worker')).toMatch(/ {6}ollama:\n {8}condition: service_started\n {8}required: false\n/);
    // Interpolation covers inactive services too, so the token must not be `:?`-required (check-env.sh does it).
    expect(compose).not.toMatch(/IMAGEGEN_TOKEN:\?/);
    expect(read('deploy/compose.sh')).toMatch(/COMPOSE_PROFILES="\$\("\$ROOT\/deploy\/profiles\.sh"/);
  });

  it('runs every service with a read-only root filesystem, and long-running ones with memory and PID limits', () => {
    for (const [name, block] of services) {
      expect(block, name).toMatch(/^ {4}read_only: true$/m);
      if (/^ {4}restart: unless-stopped$/m.test(block)) {
        expect(block, name).toMatch(/^ {4}mem_limit: \S+$/m);
        expect(block, name).toMatch(/^ {4}pids_limit: \d+$/m);
      }
    }
  });
});

describe('deploy: secrets scoped per container (SEC-10)', () => {
  const services = serviceBlocks();
  const envFiles = (name: string) => [...(services.get(name) ?? '').matchAll(/- path: \.\.\/(\.env[a-z.]*)/g)].map((m) => m[1]);

  it('gives each app container only its own env files', () => {
    // migrate needs only DATABASE_URL, MODE and LOG_LEVEL: it loads no env file, so no API key reaches it.
    expect(envFiles('migrate')).toEqual([]);
    expect(services.get('migrate')).not.toMatch(/env_file:/);
    expect(envFiles('worker')).toEqual(['.env', '.env.worker']);
    expect(envFiles('desk')).toEqual(['.env', '.env.desk']);
    expect(envFiles('imagegen-download')).toEqual(['.env.imagegen']);
    for (const name of ['postgres', 'ollama', 'imagegen', 'ollama-pull', 'init-volumes']) expect(envFiles(name), name).toEqual([]);
    expect(compose).not.toMatch(/HF_TOKEN:/); // never interpolated into a long-running service
  });

  it('keeps worker and desk secrets out of the shared .env template', () => {
    const shared = read('.env.example');
    for (const key of ['IMAGEGEN_TOKEN', 'MARKER_API_PASSWORD', 'ANTHROPIC_API_KEY', 'NOUS_API_KEY', 'FAL_KEY', 'HF_TOKEN', 'DESK_SESSION_SECRET', 'DESK_PASSWORD_HASH']) {
      expect(shared, key).not.toMatch(new RegExp(`^#?\\s*${key}=`, 'm'));
    }
    expect(read('.env.worker.example')).toMatch(/^IMAGEGEN_TOKEN=$/m);
    expect(read('.env.desk.example')).toMatch(/^# DESK_SESSION_SECRET=$/m);
    expect(read('deploy/compose.sh')).toContain('deploy/check-env.sh');
  });
});

describe.skipIf(process.platform !== 'linux')('deploy/check-env.sh', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(files: Record<string, string>, mode = 0o600) {
    dir = mkdtempSync(path.join(tmpdir(), 'check-env-'));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), body);
      chmodSync(path.join(dir, name), mode);
    }
  }
  function run(env: Record<string, string> = {}) {
    const res = spawnSync('bash', [path.join(ROOT, 'deploy/check-env.sh'), dir], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    });
    return { code: res.status, err: res.stderr };
  }

  const good = {
    '.env': 'MODE=mock\nPOSTGRES_PASSWORD=abc123\nETSY_API_KEY=k\n# MARKER_API_PASSWORD=\n',
    '.env.worker': `IMAGEGEN_TOKEN=${'a'.repeat(40)}\nMARKER_API_PASSWORD=m\nLLM_ROUTES='{"analyst":"anthropic"}'\n`,
    '.env.desk': "DESK_SESSION_SECRET='s'\nDESK_ORIGIN=https://desk.example.ts.net\n",
    '.env.imagegen': 'HF_TOKEN=hf_x\n',
  };

  it('accepts correctly scoped files', () => {
    setup(good);
    expect(run()).toEqual({ code: 0, err: '' });
  });

  it('refuses misplaced secrets and names the keys, never the values', () => {
    setup({
      '.env': `${good['.env']}MARKER_API_PASSWORD=leaked-marker-pw\nexport IMAGEGEN_TOKEN=leaked-token\nDESK_PASSWORD_HASH='scrypt$x'\n`,
      '.env.worker': `${good['.env.worker']}HF_TOKEN=hf_leaked\nDESK_SESSION_SECRET=leaked-session\n`,
      '.env.desk': `${good['.env.desk']}ANTHROPIC_API_KEY=sk-leaked\n`,
      '.env.imagegen': 'HF_TOKEN=hf_x\nPRINTIFY_API_TOKEN=leaked-printify\n',
    });
    const { code, err } = run();
    expect(code).toBe(1);
    for (const key of ['MARKER_API_PASSWORD', 'IMAGEGEN_TOKEN', 'DESK_PASSWORD_HASH', 'HF_TOKEN', 'DESK_SESSION_SECRET', 'ANTHROPIC_API_KEY', 'PRINTIFY_API_TOKEN']) {
      expect(err).toContain(key);
    }
    expect(err).toContain('7 problem(s)');
    expect(err).not.toMatch(/leaked/);
  });

  it('requires .env and .env.worker with mode 600', () => {
    setup({ '.env': good['.env'] }, 0o644);
    const { code, err } = run();
    expect(code).toBe(1);
    expect(err).toContain('.env.worker not found');
    expect(err).toContain('readable by group/others (mode 644)');
  });

  it('keeps the cloud keys (Nous, fal) in .env.worker', () => {
    setup({ ...good, '.env': `${good['.env']}NOUS_API_KEY=leaked-nous\nFAL_KEY=leaked-fal\n` });
    const { code, err } = run();
    expect(code).toBe(1);
    expect(err).toContain('NOUS_API_KEY belongs in .env.worker');
    expect(err).toContain('FAL_KEY belongs in .env.worker');
    expect(err).not.toMatch(/leaked/);
  });

  it('requires IMAGEGEN_TOKEN only when the local imagegen sidecar runs', () => {
    setup({ ...good, '.env.worker': 'MARKER_API_PASSWORD=m\n' });
    expect(run().err).toContain('IMAGEGEN_TOKEN in .env.worker is missing');
    rmSync(dir, { recursive: true, force: true });
    setup({ ...good, '.env.worker': 'MARKER_API_PASSWORD=m\nLLM_DEFAULT_PROVIDER=nous\nIMAGEGEN_PROVIDER=fal\nNOUS_API_KEY=n\nFAL_KEY=f\n' });
    expect(run()).toEqual({ code: 0, err: '' });
  });

  it('reads file modes with BSD stat too (macOS: no `stat -c`)', () => {
    setup({ ...good }, 0o644);
    // A stand-in for macOS stat: rejects -c, answers `stat -f %Lp FILE` with the octal mode.
    const bin = mkdtempSync(path.join(tmpdir(), 'bsd-stat-'));
    const real = spawnSync('bash', ['-c', 'command -v stat'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(
      path.join(bin, 'stat'),
      `#!/bin/sh\nif [ "$1" = -c ]; then echo "stat: illegal option -- c" >&2; exit 1; fi\nif [ "$1" = -f ] && [ "$2" = %Lp ]; then exec ${real} -c %a "$3"; fi\nexit 2\n`,
    );
    chmodSync(path.join(bin, 'stat'), 0o755);
    try {
      const { code, err } = run({ PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` });
      expect(code).toBe(1);
      expect(err).toContain('readable by group/others (mode 644)');
      expect(err).not.toContain('illegal option');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refuses an OLLAMA_IMAGE override without a digest (env file or shell)', () => {
    setup({ ...good, '.env': `${good['.env']}OLLAMA_IMAGE='ollama/ollama:latest'\n` });
    expect(run().err).toContain('OLLAMA_IMAGE (.env) must be pinned by digest');
    rmSync(dir, { recursive: true, force: true });
    setup({ ...good, '.env': `${good['.env']}OLLAMA_IMAGE=ollama/ollama:0.35.1@sha256:${'0'.repeat(64)}\n` });
    expect(run().code).toBe(0);
    expect(run({ OLLAMA_IMAGE: 'ollama/ollama:0.35.1' }).err).toContain('OLLAMA_IMAGE (shell environment)');
  });
});

describe.skipIf(process.platform !== 'linux')('deploy/profiles.sh', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function profiles(env: string, worker: string): string {
    dir = mkdtempSync(path.join(tmpdir(), 'profiles-'));
    writeFileSync(path.join(dir, '.env'), env);
    writeFileSync(path.join(dir, '.env.worker'), worker);
    const res = spawnSync('bash', [path.join(ROOT, 'deploy/profiles.sh'), dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    expect(res.status).toBe(0);
    return res.stdout.trim();
  }

  it('starts both GPU services for the default, all-local setup', () => {
    expect(profiles('MODE=mock\n', `IMAGEGEN_TOKEN=${'a'.repeat(40)}\n`)).toBe('ollama,imagegen');
  });

  it('starts nothing on the GPU for Nous + fal', () => {
    expect(profiles('', 'LLM_DEFAULT_PROVIDER=nous\nIMAGEGEN_PROVIDER="fal"\n# LLM_DEFAULT_PROVIDER=ollama\n')).toBe('');
  });

  it('starts only what a mixed setup uses', () => {
    expect(profiles('', `LLM_DEFAULT_PROVIDER=nous\nLLM_ROUTES='{"analyst":"ollama"}'\nIMAGEGEN_PROVIDER=fal\n`)).toBe('ollama');
    expect(profiles('', 'LLM_DEFAULT_PROVIDER=anthropic\nIMAGEGEN_PROVIDER=local\n')).toBe('imagegen');
    expect(profiles('', `LLM_DEFAULT_PROVIDER=nous\nIMAGEGEN_PROVIDER=recraft\nIMAGEGEN_TOKEN=${'a'.repeat(40)}\n`)).toBe('imagegen');
    expect(profiles('', 'LLM_DEFAULT_PROVIDER=nous\nIMAGEGEN_PROVIDER=recraft\n')).toBe('');
  });

  it('lets .env.worker override .env', () => {
    expect(profiles('IMAGEGEN_PROVIDER=local\nLLM_DEFAULT_PROVIDER=ollama\n', 'IMAGEGEN_PROVIDER=fal\nLLM_DEFAULT_PROVIDER=nous\n')).toBe('');
  });
});

describe.skipIf(process.platform !== 'linux')('deploy/init-env.sh', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A scratch "repository": the templates and the deploy scripts, so the script's ROOT is the scratch directory.
  function init(args: string[], env: Record<string, string> = {}) {
    dir = mkdtempSync(path.join(tmpdir(), 'init-env-'));
    mkdirSync(path.join(dir, 'deploy'));
    for (const f of ['.env.example', '.env.worker.example', '.env.desk.example']) copyFileSync(path.join(ROOT, f), path.join(dir, f));
    for (const f of ['init-env.sh', 'check-env.sh', 'profiles.sh']) copyFileSync(path.join(ROOT, 'deploy', f), path.join(dir, 'deploy', f));
    const res = spawnSync('bash', [path.join(dir, 'deploy/init-env.sh'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
    return { code: res.status, out: res.stdout, err: res.stderr };
  }
  const file = (name: string) => readFileSync(path.join(dir, name), 'utf8');
  /** KEY=VALUE lines the way compose reads them (comments skipped, one level of surrounding quotes removed). */
  function parse(...names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) {
      for (const line of file(name).split('\n')) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (m) out[m[1]!] = m[2]!.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
      }
    }
    return out;
  }
  const checkEnv = () => spawnSync('bash', [path.join(dir, 'deploy/check-env.sh'), dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });

  it('--cloud: Nous DeepSeek preset + fal, mode 600, passes check-env, no GPU profile, loads as a valid config', () => {
    const { code, out } = init(['--cloud']);
    expect(code).toBe(0);
    for (const f of ['.env', '.env.worker', '.env.desk']) expect(statSync(path.join(dir, f)).mode & 0o777, f).toBe(0o600);
    const env = parse('.env', '.env.worker', '.env.desk');
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(env.DESK_SESSION_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(env.DESK_ORIGIN).toBe('http://localhost:3000');
    expect(env).toMatchObject({
      LLM_DEFAULT_PROVIDER: 'nous',
      NOUS_MODEL_LARGE: 'deepseek/deepseek-v4-pro',
      NOUS_MODEL_SMALL: 'deepseek/deepseek-v4-flash',
      LLM_TIERS: '{"trend_scout":"small","listing_writer":"small"}',
      IMAGEGEN_PROVIDER: 'fal',
    });
    expect(env.IMAGEGEN_TOKEN).toBeUndefined();
    expect(file('.env.worker')).toMatch(/^# IMAGEGEN_TOKEN=$/m);
    expect(out).toContain('Still to do: NOUS_API_KEY');
    expect(checkEnv().status).toBe(0);
    expect(spawnSync('bash', [path.join(dir, 'deploy/profiles.sh'), dir], { encoding: 'utf8' }).stdout.trim()).toBe('');
    const loaded = loadEnv({ ...env, NOUS_API_KEY: 'n', FAL_KEY: 'f' });
    expect(loaded.LLM_TIERS).toEqual({ trend_scout: 'small', listing_writer: 'small' });
  });

  it('takes model and origin overrides, and the local setup gets an IMAGEGEN_TOKEN', () => {
    expect(init(['--cloud', '--desk-origin', 'https://mac.example.ts.net'], { NOUS_MODEL_VISION: 'vendor/vision', NOUS_MODEL_SMALL: 'vendor/small' }).code).toBe(0);
    expect(parse('.env.worker', '.env.desk')).toMatchObject({ NOUS_MODEL_VISION: 'vendor/vision', NOUS_MODEL_SMALL: 'vendor/small', DESK_ORIGIN: 'https://mac.example.ts.net' });
    rmSync(dir, { recursive: true, force: true });
    expect(init([]).code).toBe(0);
    expect(parse('.env.worker').IMAGEGEN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(parse('.env.worker').LLM_DEFAULT_PROVIDER).toBe('ollama');
    expect(checkEnv().status).toBe(0);
  });

  it('never overwrites existing env files and rejects a bad origin', () => {
    expect(init([]).code).toBe(0);
    const before = file('.env');
    const again = spawnSync('bash', [path.join(dir, 'deploy/init-env.sh')], { encoding: 'utf8' });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already exists');
    expect(file('.env')).toBe(before);
    rmSync(dir, { recursive: true, force: true });
    expect(init(['--desk-origin', 'http://localhost:3000/']).code).toBe(2);
  });
});
