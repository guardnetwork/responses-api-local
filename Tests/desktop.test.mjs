import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const app = process.env.RESPONSES_TEST_APP;
const proxyBinary = join(app, 'Contents/MacOS/cliproxyapi');
const { Desktop } = await import(pathToFileURL(join(app, 'Contents/Resources/Gateway/scripts/desktop.mjs')));
const { ConnectionManager } = await import(pathToFileURL(join(app, 'Contents/Resources/Gateway/src/connections.mjs')));
const model = 'gpt-6.1-sol';
const reply = (data, status = 200) => Response.json(data, { status });
const verifier = 'test-verifier';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const identity = 'header.' + Buffer.from(JSON.stringify({
  email: 'fixture@example.invalid',
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'plus' },
})).toString('base64url') + '.signature';

async function waitUntil(check, label) {
  for (let i = 0; i < 240; i++) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail('Timed out: ' + label);
}

async function unused(port) {
  const server = createServer();
  return new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

test('overlapping connection reads stay ordered around disconnect', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-connection-read-'));
  const manager = new ConnectionManager({ authDir: directory });
  t.after(async () => {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = 'fixture-owner';
  const ownerHash = createHash('sha256').update(owner).digest('hex');
  await Promise.all([
    writeFile(join(directory, '.service-owner.meta'), JSON.stringify({ ownerHash }), { mode: 0o600 }),
    writeFile(join(directory, '.connection-state.meta'), JSON.stringify({
      ownerHash, state: 'connected', connectionId: 'fixture', revision: 1,
    }), { mode: 0o600 }),
    writeFile(join(directory, `codex-service-${ownerHash.slice(0, 32)}.json`), '{}', { mode: 0o600 }),
  ]);
  await assert.rejects(manager.current(), { code: 'owner_required' });
  const before = Promise.all(Array.from({ length: 8 }, () => manager.current(owner)));
  const disconnect = manager.disconnect(owner);
  const after = Promise.all(Array.from({ length: 8 }, () => manager.current(owner)));
  assert.ok((await before).every(state => state.connected && state.revision === 1));
  assert.equal((await disconnect).revision, 2);
  assert.ok((await after).every(state => !state.connected && state.revision === 2));
  await assert.rejects(manager.current('other-owner'), { code: 'single_owner_connection_required' });
});

test('packaged desktop supervisor authorizes before starting, preserves its key, disconnects, and reconnects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-desktop-qa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let permitted = false, codes = 0, exchanges = 0;
  const connectionOptions = {
    sleepImpl: (_ms, _, { signal }) => delay(20, undefined, { signal }),
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/usercode')) {
        return reply({ device_auth_id: 'fixture-device', user_code: 'TEST-' + ++codes, interval: 1 });
      }
      if (path.endsWith('/deviceauth/token')) {
        return permitted ? reply({ authorization_code: 'fixture-code', code_verifier: verifier, code_challenge: challenge })
          : reply({ error: 'authorization_pending' }, 403);
      }
      if (path === '/oauth/token') {
        exchanges++;
        return reply({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', id_token: identity, expires_in: 3600 });
      }
      assert.fail('Unexpected authorization path');
    },
  };
  let state;
  const make = () => new Desktop({ directory, proxyBinary, connectionOptions, send: value => { state = value; } });
  let desktop = make();
  t.after(async () => desktop.close());
  await desktop.initialize();
  assert.equal(state.state, 'disconnected');
  await assert.rejects(stat(join(directory, 'installation.json')), { code: 'ENOENT' });

  await desktop.enqueue(() => desktop.command('connect'));
  assert.equal(state.state, 'pending');
  assert.equal(state.url, 'https://auth.openai.com/codex/device');
  assert.equal(desktop.stack, undefined);
  await assert.rejects(stat(join(directory, 'installation.json')), { code: 'ENOENT' });
  await desktop.enqueue(() => desktop.command('cancel'));
  assert.equal(state.state, 'disconnected');
  assert.equal(exchanges, 0);

  await desktop.enqueue(() => desktop.command('connect'));
  permitted = true;
  await waitUntil(() => state.state === 'running', 'first packaged service startup');
  const { key, url } = state;
  assert.equal(state.anthropicURL, new URL('/anthropic', url).href);
  const port = Number(new URL(url).port);
  const settings = JSON.parse(await readFile(join(directory, 'installation.json')));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(settings.proxyKey, key);
  assert.equal((await stat(join(directory, 'installation.json'))).mode & 0o777, 0o600);
  const authDir = join(directory, 'proxy-auth');
  const credential = (await readdir(authDir)).find(name => name.endsWith('.json'));
  assert.ok(credential);
  assert.equal((await stat(join(authDir, credential))).mode & 0o777, 0o600);
  const anonymous = await fetch(url + '/models');
  assert.equal(anonymous.status, 401);
  await anonymous.body.cancel();
  const headers = { Authorization: 'Bearer ' + key };
  const models = await (await fetch(url + '/models', { headers })).json();
  assert.deepEqual(models.data, []);
  const internal = await fetch(url.replace(/\/v1$/, '') + '/v10/connections/disconnect', { headers, method: 'POST' });
  assert.equal(internal.status, 404);
  await internal.body.cancel();
  const health = await (await fetch('http://127.0.0.1:' + settings.proxyPort + '/healthz')).json();
  assert.equal(health.forkId, 'desktop-model-selection-v2');
  assert.match(health.policy.catalogSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.modelSettings?.selection, { model, effort: 'low' });

  await desktop.close();
  assert.equal(await unused(port), true);
  assert.equal(await unused(settings.proxyPort), true);
  desktop = make();
  await desktop.initialize();
  await waitUntil(() => state.state === 'running', 'restart with existing connection');
  assert.equal(state.key, key);
  assert.equal(exchanges, 1);

  await desktop.enqueue(() => desktop.command('disconnect'));
  assert.equal(state.state, 'disconnected');
  await assert.rejects(stat(join(authDir, credential)), { code: 'ENOENT' });
  assert.equal(await unused(port), true);
  assert.equal(await unused(settings.proxyPort), true);

  permitted = false;
  await desktop.enqueue(() => desktop.command('connect'));
  assert.equal(state.state, 'pending');
  permitted = true;
  await waitUntil(() => state.state === 'running', 'reconnected service');
  assert.equal(state.url, url);
  assert.equal(state.key, key);
  assert.equal(exchanges, 2);
  await desktop.enqueue(() => desktop.command('disconnect'));
  assert.equal(state.state, 'disconnected');
});
