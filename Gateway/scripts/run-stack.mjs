#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CATALOG_SHA, CATALOG_SOURCE, PROXY_POLICY_ID } from '../src/model-settings.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const report = (event, details = {}) => console.log(JSON.stringify({ event, ...details, secretsPrinted: false }));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

export function stackOptions(env = process.env, root = ROOT) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('node24_required');
  const proxyUrl = new URL(env.SKILLSTORE_PROXY_URL || 'http://127.0.0.1:8641');
  if (proxyUrl.protocol !== 'http:' || proxyUrl.hostname !== '127.0.0.1' || proxyUrl.username || proxyUrl.password || proxyUrl.search || proxyUrl.hash || !['', '/'].includes(proxyUrl.pathname)) throw new Error('stack_proxy_must_be_localhost');
  const proxyPort = Number(proxyUrl.port || 80), port = Number(env.SKILLSTORE_PORT || 5640);
  if (![proxyPort, port].every(value => Number.isInteger(value) && value >= 1 && value <= 65535) || proxyPort === port) throw new Error('invalid_stack_ports');
  const proxyKey = env.SKILLSTORE_PROXY_KEY || '';
  if (proxyKey.length < 32 || (env.SKILLSTORE_API_KEY || '').length < 32) throw new Error('stack_keys_missing_run_init');
  const dataDir = resolve(env.SKILLSTORE_DATA_DIR || resolve(root, 'data'));
  const binary = resolve(env.SKILLSTORE_PROXY_BINARY || resolve(root, 'bin/cliproxyapi'));
  return { root, dataDir, authDir: resolve(dataDir, 'proxy-auth'), binary,
    buildReceipt: resolve(env.SKILLSTORE_PROXY_BUILD_RECEIPT || `${binary}.build.json`),
    proxyConfig: resolve(dataDir, 'proxy-config.yaml'), proxyHost: '127.0.0.1', proxyPort, proxyKey,
    port, host: env.SKILLSTORE_BIND_HOST || '127.0.0.1', lock: resolve(dataDir, 'stack.lock'), guardDb: resolve(dataDir, 'stack-guard.sqlite') };
}

export function proxyYaml({ authDir, proxyPort, proxyKey }) {
  return `host: "127.0.0.1"\nport: ${proxyPort}\nauth-dir: ${JSON.stringify(authDir)}\napi-keys:\n  - ${JSON.stringify(proxyKey)}\nremote-management:\n  allow-remote: false\n  disable-control-panel: true\n  secret-key: ""\nlogging-to-file: false\nrequest-log: false\nusage-statistics-enabled: false\nrequest-retry: 0\nquota-exceeded:\n  switch-project: false\n  switch-preview-model: false\n`;
}

export async function verifyBinary(options) {
  const info = await lstat(options.binary);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe_proxy_binary');
  await access(options.binary, constants.X_OK);
  const receipt = JSON.parse(await readFile(options.buildReceipt, 'utf8'));
  const targetOS = { darwin: 'darwin', linux: 'linux' }[process.platform];
  const targetArch = { arm64: 'arm64', x64: 'amd64' }[process.arch];
  if (!targetOS || !targetArch || receipt.targetOS !== targetOS || receipt.targetArch !== targetArch
      || receipt.patchId !== PROXY_POLICY_ID || receipt.catalogSha256 !== CATALOG_SHA
      || receipt.registryCommit !== CATALOG_SOURCE.commit || receipt.registrySha256 !== CATALOG_SOURCE.sha256) {
    throw new Error('proxy_binary_platform_or_policy_mismatch');
  }
  const digest = createHash('sha256').update(await readFile(options.binary)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(receipt.binarySha256 || '') || digest !== receipt.binarySha256) throw new Error('proxy_binary_hash_mismatch');
  return { targetOS, targetArch, binarySha256: digest };
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_stack_data_directory');
  await chmod(path, 0o700);
}
async function writePrivate(path, value) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('unsafe_proxy_configuration'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function acquireGuard(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('unsafe_stack_guard'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const guard = new DatabaseSync(path);
  try { guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch { guard.close(); throw new Error('stack_active_or_guard_unavailable'); }
  try { await chmod(path, 0o600); }
  catch (error) { guard.exec('ROLLBACK'); guard.close(); throw error; }
  let released = false;
  return { close() { if (released) return; released = true; try { guard.exec('ROLLBACK'); } finally { guard.close(); } } };
}
async function readLock(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe_stack_metadata');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function freePort(host, port) {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', () => reject(new Error('stack_port_in_use')));
    probe.listen(port, host, () => probe.close(resolveListen));
  });
}
async function freePorts(options, stale) {
  const until = Date.now() + (stale ? 12000 : 0);
  while (true) {
    try { await freePort(options.proxyHost, options.proxyPort); await freePort(options.host, options.port); return; }
    catch (error) { if (!stale || Date.now() >= until) throw error; await delay(150); }
  }
}
async function tcpReady(host, port) {
  return new Promise(resolveReady => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = ready => { if (done) return; done = true; socket.destroy(); resolveReady(ready); };
    socket.setTimeout(500, () => finish(false));
    socket.once('error', () => finish(false)); socket.once('connect', () => finish(true));
  });
}
async function waitReady(check, child, code, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(code);
    if (await check()) return;
    await delay(150);
  }
  throw new Error(code);
}
function proxyEnvironment(env) {
  // Do not inherit upstream-key, database, Git-store or unrelated login variables.
  return Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY']
    .filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const until = Date.now() + 8000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(50);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export async function runStack({ check = false } = {}) {
  const localEnv = resolve(ROOT, '.env.local');
  try {
    const envInfo = await lstat(localEnv);
    if (!envInfo.isFile() || envInfo.isSymbolicLink()) throw new Error('unsafe_local_environment_file');
    process.loadEnvFile(localEnv);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const options = stackOptions();
  const provenance = await verifyBinary(options);
  if (check) {
    report('stack_configuration_checked', { node: process.versions.node, ...provenance, gatewayPort: options.port, proxyPort: options.proxyPort, checkedOnly: true, childrenStarted: false });
    return;
  }
  await privateDirectory(options.dataDir); await privateDirectory(options.authDir);
  const guard = await acquireGuard(options.guardDb);
  let previous;
  try { previous = await readLock(options.lock); }
  catch (error) { guard.close(); throw error; }
  // Older, unguarded metadata must be reconciled explicitly when its PID is alive.
  if (previous && previous.guardVersion !== 2) {
    try {
      if (Number.isSafeInteger(previous.pid) && previous.pid > 0) process.kill(previous.pid, 0);
      else throw new Error('unknown_legacy_stack_owner');
      guard.close(); throw new Error('legacy_stack_lock_requires_reconciliation');
    } catch (error) { if (error.code !== 'ESRCH') { guard.close(); throw error; } }
  }
  const instanceId = randomUUID();
  let ownsMetadata = false, proxy, gateway, stopping = false, stopPromise;
  const stop = (reason, exitCode = 0) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      report('stack_stopping', { reason });
      await stopChild(gateway); await stopChild(proxy);
      process.exitCode = exitCode;
    })();
    return stopPromise;
  };
  const onSignal = () => { void stop('operator_signal'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    await freePorts(options, previous !== null);
    if (stopping) return await stopPromise;
    await writePrivate(options.lock, JSON.stringify({ guardVersion: 2, instanceId, pid: process.pid,
      startedAt: new Date().toISOString(), gatewayPort: options.port, proxyPort: options.proxyPort }) + '\n');
    ownsMetadata = true;
    if (previous) report('stale_stack_metadata_reconciled', { kernelGuardAcquired: true, portsAvailable: true, oldProcessKilled: false });
    await writePrivate(options.proxyConfig, proxyYaml(options));
    if (stopping) return await stopPromise;
    const start = (component, binary, args, env) => {
      const child = spawn(binary, args, { cwd: options.root, env, stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => { void stop(`${component}_spawn_failed`, 1); });
      child.once('exit', (code, signal) => { if (!stopping) { report('stack_component_exited', { component, code, signal }); void stop(`${component}_exited`, 1); } });
      return child;
    };
    const managedChild = resolve(options.root, 'scripts/managed-child.mjs');
    proxy = start('proxy', process.execPath, [managedChild, 'proxy', options.binary, options.proxyConfig], proxyEnvironment(process.env));
    await waitReady(() => tcpReady(options.proxyHost, options.proxyPort), proxy, 'proxy_start_failed');
    if (stopping) return await stopPromise;
    gateway = start('gateway', process.execPath, [managedChild, 'gateway'], process.env);
    await waitReady(async () => {
      try { const response = await fetch(`http://127.0.0.1:${options.port}/health`, { redirect: 'manual', signal: AbortSignal.timeout(1000) }); return response.status === 200 && (await response.json()).status === 'ok'; }
      catch { return false; }
    }, gateway, 'gateway_start_failed');
    if (stopping) return await stopPromise;
    report('stack_started', { gateway: `http://127.0.0.1:${options.port}`, proxy: 'localhost_only', storage: 'sqlite_single_instance', ...provenance });
    await new Promise(resolveDone => {
      gateway.once('exit', resolveDone); proxy.once('exit', resolveDone);
    });
    await stopPromise;
  } catch (error) {
    await stop('startup_failed', 1);
    throw error;
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    try {
      if (ownsMetadata && (await readLock(options.lock))?.instanceId === instanceId) await unlink(options.lock);
    } finally { guard.close(); }
  }
}

let entryPath;
try { if (process.argv[1]) entryPath = await realpath(resolve(process.argv[1])); } catch {}
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') {
    report('stack_error', { code: 'usage_node_scripts_run_stack_check_optional' }); process.exitCode = 1;
  } else {
    try { await runStack({ check: args[0] === '--check' }); }
    catch (error) {
      const code = typeof error.message === 'string' && /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'stack_setup_failed';
      report('stack_error', { code }); process.exitCode = 1;
    }
  }
}
