import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@etsy-agents/core/config/env.ts';
import { isCoreEnvKey, scopeEnvForLoad } from './envScope.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'desk-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scopeEnvForLoad', () => {
  it('recognises core keys only', () => {
    for (const k of ['MODE', 'DATABASE_URL', 'DESK_PASSWORD_HASH', 'DESK_SESSION_SECRET', 'ETSY_API_KEY', 'IMAGEGEN_TOKEN']) {
      expect(isCoreEnvKey(k)).toBe(true);
    }
    for (const k of ['WORKER_HEARTBEAT', 'SSL_CERT', 'PIP_CONFIG', 'PATH', 'DESK_PASSWORD_HASH_FILE', 'mode']) {
      expect(isCoreEnvKey(k)).toBe(false);
    }
  });

  it('drops *_FILE variables that do not target a core key and keeps everything else', () => {
    const scoped = scopeEnvForLoad({
      MODE: 'mock',
      PATH: '/usr/bin',
      WORKER_HEARTBEAT_FILE: '/tmp/worker-heartbeat',
      SSL_CERT_FILE: '/nonexistent/ca.pem',
      DESK_PASSWORD_HASH_FILE: '/run/secrets/desk_password_hash',
      DATABASE_URL_FILE: '/run/secrets/database_url',
    });
    expect(scoped).toEqual({
      MODE: 'mock',
      PATH: '/usr/bin',
      DESK_PASSWORD_HASH_FILE: '/run/secrets/desk_password_hash',
      DATABASE_URL_FILE: '/run/secrets/database_url',
    });
  });

  it('lets loadEnv succeed despite unrelated missing *_FILE paths, and still reads Docker secrets', () => {
    const secretPath = path.join(dir, 'desk_session_secret');
    writeFileSync(secretPath, `${'s'.repeat(40)}\n`);
    const raw: Record<string, string> = {
      MODE: 'mock',
      WORKER_HEARTBEAT_FILE: path.join(dir, 'missing-heartbeat'),
      SSL_CERT_FILE: path.join(dir, 'missing-ca.pem'),
      DESK_SESSION_SECRET_FILE: secretPath,
    };
    expect(() => loadEnv(raw as NodeJS.ProcessEnv)).toThrow(); // the unscoped environment breaks loadEnv
    const env = loadEnv(scopeEnvForLoad(raw));
    expect(env.MODE).toBe('mock');
    expect(env.DESK_SESSION_SECRET).toBe('s'.repeat(40));
  });

  it('still fails loudly when a core secret file is missing', () => {
    expect(() => loadEnv(scopeEnvForLoad({ MODE: 'mock', DESK_PASSWORD_HASH_FILE: path.join(dir, 'nope') }))).toThrow();
  });
});
