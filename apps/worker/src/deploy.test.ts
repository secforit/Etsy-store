/**
 * Regression tests for the deployment hardening in deploy/ (security review SEC-07..SEC-10):
 * pinned images, internal-only GPU services, resource limits, and per-container env files with the
 * deploy/check-env.sh guard that deploy/compose.sh runs before every compose command.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
    expect(envFiles('migrate')).toEqual(['.env']);
    expect(envFiles('worker')).toEqual(['.env', '.env.worker']);
    expect(envFiles('desk')).toEqual(['.env', '.env.desk']);
    expect(envFiles('imagegen-download')).toEqual(['.env.imagegen']);
    for (const name of ['postgres', 'ollama', 'imagegen', 'ollama-pull', 'init-volumes']) expect(envFiles(name), name).toEqual([]);
    expect(compose).not.toMatch(/HF_TOKEN:/); // never interpolated into a long-running service
  });

  it('keeps worker and desk secrets out of the shared .env template', () => {
    const shared = read('.env.example');
    for (const key of ['IMAGEGEN_TOKEN', 'MARKER_API_PASSWORD', 'ANTHROPIC_API_KEY', 'HF_TOKEN', 'DESK_SESSION_SECRET', 'DESK_PASSWORD_HASH']) {
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

  it('refuses an OLLAMA_IMAGE override without a digest (env file or shell)', () => {
    setup({ ...good, '.env': `${good['.env']}OLLAMA_IMAGE='ollama/ollama:latest'\n` });
    expect(run().err).toContain('OLLAMA_IMAGE (.env) must be pinned by digest');
    rmSync(dir, { recursive: true, force: true });
    setup({ ...good, '.env': `${good['.env']}OLLAMA_IMAGE=ollama/ollama:0.35.1@sha256:${'0'.repeat(64)}\n` });
    expect(run().code).toBe(0);
    expect(run({ OLLAMA_IMAGE: 'ollama/ollama:0.35.1' }).err).toContain('OLLAMA_IMAGE (shell environment)');
  });
});
