import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Service } from './service.mjs';
import { ProxyClient } from './proxy.mjs';
import { ConnectionManager } from './connections.mjs';
import { createApiServer } from './server.mjs';

const root = resolve(import.meta.dirname, '..');
const localEnv = resolve(root, '.env.local');
if (existsSync(localEnv)) process.loadEnvFile(localEnv);
const config = loadConfig();
const store = new Store(config.dbPath);
const proxy = new ProxyClient({ baseUrl: config.proxyUrl, apiKey: config.proxyKey, timeoutMs: config.maxRunMs });
const connections = new ConnectionManager({ authDir: config.authDir });
const service = new Service({ store, proxy, connections, config });
const server = createApiServer(service, config);
server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'api_started', url: `http://${config.host}:${server.address().port}`, model: 'gpt-6.1-sol', reasoning_effort: 'low', channel: 'codex_oauth_proxy', credentialsPrinted: false })));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await service.close();
  server.closeAllConnections(); server.close(); store.close();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
