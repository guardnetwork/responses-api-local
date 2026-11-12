import { resolve } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';

export function loadConfig(env = process.env) {
  const dataDir = resolve(env.SKILLSTORE_DATA_DIR || 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const host = env.SKILLSTORE_BIND_HOST || '127.0.0.1';
  const port = Number(env.SKILLSTORE_PORT || 5640);
  const apiKey = env.SKILLSTORE_API_KEY || '';
  const ownerId = env.SKILLSTORE_OWNER_ID || 'private-owner';
  const maxConcurrent = Number(env.SKILLSTORE_MAX_CONCURRENT || 2);
  if (![1, 2].includes(maxConcurrent)) throw new Error('invalid_concurrency_limit');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port');
  if (![Number(env.SKILLSTORE_MAX_ATTEMPTS || 2), Number(env.SKILLSTORE_MAX_RUN_MS || 3600000)].every(Number.isSafeInteger)) throw new Error('invalid_runtime_limits');
  if (apiKey.length < 32) throw new Error('service_key_missing_run_init');
  if (!/^[A-Za-z0-9._:@-]{1,160}$/.test(ownerId)) throw new Error('invalid_owner_id');
  if (host !== '127.0.0.1') throw new Error('standalone_requires_ipv4_loopback');
  return {
    host, port, apiKey, ownerId, dataDir,
    dbPath: resolve(dataDir, 'gateway.sqlite'), authDir: resolve(dataDir, 'proxy-auth'),
    proxyUrl: env.SKILLSTORE_PROXY_URL || 'http://127.0.0.1:8641',
    proxyKey: env.SKILLSTORE_PROXY_KEY || '',
    modelScope: env.SKILLSTORE_MODEL_SCOPE || '',
    maxAttempts: Math.max(1, Math.min(3, Number(env.SKILLSTORE_MAX_ATTEMPTS || 2))),
    maxRunMs: Math.max(60000, Math.min(14400000, Number(env.SKILLSTORE_MAX_RUN_MS || 3600000))),
    maxBodyBytes: 768 * 1024, maxConcurrent,
  };
}
