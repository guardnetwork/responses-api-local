import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { ConnectionManager } from '../src/connections.mjs';
import { Store } from '../src/store.mjs';
import { acquireGuard } from './run-stack.mjs';

const owner = 'desktop-owner';
const loopback = '127.0.0.1';
const safeCode = value => typeof value === 'string' && /^[a-z0-9_]{1,100}$/.test(value);
const authErrors = new Set(['upstream_auth_error', 'provider_auth_failed']);
const stackEntry = join(import.meta.dirname, 'stack-child.mjs');

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw Error('unsafe_application_data_directory');
  }
}

async function readSettings(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw Error('unsafe_local_settings');
    }
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(data.apiKey) || !/^[a-f0-9]{64}$/.test(data.proxyKey)
        || ![data.port, data.proxyPort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535)
        || data.port === data.proxyPort) throw Error('invalid_local_settings');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveSettings(path, data) {
  const temp = path + '.' + randomUUID();
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(data) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function portAvailable(port) {
  const server = createServer();
  return new Promise(resolve => {
    server.once('error', error => resolve(error.code === 'EADDRINUSE' ? false : null));
    server.listen({ port, host: loopback, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function initialPorts() {
  for (const [port, proxyPort] of [[5640, 8641], [15640, 18641], [25640, 28641]]) {
    const available = await Promise.all([portAvailable(port), portAvailable(proxyPort)]);
    if (available.every(Boolean)) return { port, proxyPort };
  }
  throw Error('stack_port_in_use');
}

export class Desktop {
  constructor({ directory, proxyBinary, send, connectionOptions = {} }) {
    this.directory = directory;
    this.settingsPath = join(directory, 'installation.json');
    this.dbPath = join(directory, 'gateway.sqlite');
    this.proxyBinary = proxyBinary;
    this.send = send;
    this.connections = new ConnectionManager({ ...connectionOptions, authDir: join(directory, 'proxy-auth') });
    this.closed = false;
    this.serial = Promise.resolve();
  }

  async initialize() {
    await privateDirectory(this.directory);
    const guardPath = join(this.directory, 'desktop-guard.sqlite');
    try {
      const handle = await open(guardPath, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    this.guard = await acquireGuard(guardPath);
    this.settings = await readSettings(this.settingsPath);
    await this.sync();
    const poll = async () => {
      await this.enqueue(() => this.sync());
      if (!this.closed) this.timer = setTimeout(poll, 650);
    };
    this.timer = setTimeout(poll, 650);
  }

  enqueue(fn) {
    this.serial = this.serial.then(async () => {
      if (!this.closed) await fn();
    }).catch(error => {
      if (!this.closed) this.publish('error', { code: safeCode(error.code) ? error.code
        : safeCode(error.message) ? error.message : 'desktop_operation_failed' });
    });
    return this.serial;
  }

  publish(state, data = {}) {
    const value = { state, ...data };
    const encoded = JSON.stringify(value);
    if (encoded !== this.lastState) {
      this.lastState = encoded;
      this.send(value);
    }
  }

  async sync() {
    const connection = await this.connections.current(owner);
    if (!connection.connected) {
      if (this.stack) await this.stopStack();
      const pending = connection.state === 'pending';
      this.publish(pending ? 'pending' : 'disconnected', pending
        ? { code: connection.userCode, url: connection.verificationUri, expires: connection.expiresAt }
        : { ...(connection.errorCode && { code: connection.errorCode }) });
      return;
    }
    if (this.needsReconnect) {
      this.publish('reconnect');
      return;
    }
    if (this.stackError) return;
    if (!this.stack) await this.startStack(connection.revision, connection.connectionId);
    if (this.stack?.ready) {
      if (this.latestInferenceAuthFailure()) {
        this.needsReconnect = true;
        await this.stopStack();
        this.publish('reconnect');
        return;
      }
      if (!this.modelSettings || this.modelSettings.testing) {
        try { this.modelSettings = await this.modelRequest(); } catch { /* Retry on the next status check. */ }
      }
      this.publishRunning();
    }
  }

  publishRunning() {
    if (!this.stack?.ready) return;
    this.publish('running', { url: this.baseURL, anthropicURL: `http://${loopback}:${this.settings.port}/anthropic`,
      key: this.settings.apiKey, modelSettings: this.modelSettings, modelError: this.modelError });
  }

  async modelRequest(body) {
    const response = await fetch(this.baseURL.slice(0, -3) + '/__desktop/model-settings', {
      headers: { authorization: `Bearer ${this.settings.proxyKey}`, 'content-type': 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(2000),
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(safeCode(result.error?.code) ? result.error.code : 'model_operation_failed');
    return result;
  }

  latestInferenceAuthFailure() {
    if (!this.monitorDb) {
      this.monitorDb = new DatabaseSync(this.dbPath, { readOnly: true });
      this.authFailureQuery = this.monitorDb.prepare(`SELECT error_code FROM jobs
        WHERE owner_id=? AND updated_at >= ?
          AND execution_status IN ('completed','failed','incomplete')
          AND (error_code IN ('upstream_auth_error','provider_auth_failed') OR execution_status='completed')
        ORDER BY updated_at DESC LIMIT 1`);
    }
    return authErrors.has(this.authFailureQuery.get(owner, this.stack.started)?.error_code);
  }

  closeMonitor() {
    this.authFailureQuery = null;
    this.monitorDb?.close();
    this.monitorDb = null;
  }

  bindConnection(revision, enabled) {
    if (!this.settings) return;
    const db = new Store(this.dbPath);
    try {
      db.db.prepare(`INSERT INTO connection_bindings(owner_id,revision,enabled,updated_at)
        VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
        revision=excluded.revision, enabled=excluded.enabled, updated_at=excluded.updated_at
        WHERE connection_bindings.revision != excluded.revision OR connection_bindings.enabled != excluded.enabled`)
        .run(owner, revision, Number(enabled), new Date().toISOString());
    } finally {
      db.close();
    }
  }

  async startStack(revision, connectionId) {
    this.publish('starting');
    if (!this.settings) {
      const ports = await initialPorts();
      const settings = { ...ports, apiKey: randomBytes(32).toString('hex'), proxyKey: randomBytes(32).toString('hex') };
      await saveSettings(this.settingsPath, settings);
      this.settings = settings;
    }
    this.bindConnection(revision, true);
    this.baseURL = `http://${loopback}:${this.settings.port}/v1`;
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME,
      ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
      NO_PROXY: '127.0.0.1,localhost,::1',
      SKILLSTORE_DATA_DIR: this.directory,
      SKILLSTORE_OWNER_ID: owner,
      SKILLSTORE_MODEL_SCOPE: connectionId,
      SKILLSTORE_API_KEY: this.settings.apiKey,
      SKILLSTORE_PROXY_KEY: this.settings.proxyKey,
      SKILLSTORE_PORT: String(this.settings.port),
      SKILLSTORE_PROXY_URL: `http://${loopback}:${this.settings.proxyPort}`,
      SKILLSTORE_PROXY_BINARY: this.proxyBinary,
      SKILLSTORE_PROXY_BUILD_RECEIPT: join(import.meta.dirname, '../proxy-build.json'),
    };
    const child = spawn(process.execPath, [stackEntry], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const stack = { child, started: new Date().toISOString(), ready: false, stopping: false };
    this.stack = stack;
    child.stdin.on('error', () => {});
    const output = createInterface({ input: child.stdout });
    output.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.event === 'stack_started') stack.ready = true;
        if (value.event === 'stack_error' && safeCode(value.code)) stack.error = value.code;
        if (value.event === 'stack_component_exited' && ['proxy', 'gateway'].includes(value.component)) stack.error = `${value.component}_exited`;
      } catch { /* Ignore output that is not a stack status. */ }
    });
    stack.done = new Promise(resolve => {
      child.once('close', () => {
        output.close();
        this.closeMonitor();
        this.modelSettings = null;
        this.modelError = null;
        if (this.stack === stack) this.stack = null;
        if (!stack.stopping && !this.closed) {
          this.stackError = stack.error ?? 'stack_stopped';
          this.publish('error', { code: this.stackError, restart: true });
        }
        resolve();
      });
      child.once('error', () => { stack.error = 'stack_spawn_failed'; });
    });
  }

  async stopStack() {
    const stack = this.stack;
    if (!stack) return;
    stack.stopping = true;
    stack.child.stdin.end();
    const kill = setTimeout(() => stack.child.kill('SIGKILL'), 11000);
    try { await stack.done; } finally { clearTimeout(kill); }
  }

  async command(action) {
    if (action.startsWith('{')) {
      if (!this.stack?.ready) return;
      try {
        this.modelSettings = await this.modelRequest(JSON.parse(action));
        this.modelError = null;
      } catch (error) {
        this.modelError = safeCode(error.message) ? error.message : 'model_operation_failed';
      }
      this.publishRunning();
      return;
    }
    switch (action) {
      case 'connect': {
        if (this.needsReconnect) await this.disconnect();
        this.stackError = null;
        this.publish('authorizing');
        await this.connections.start(owner);
        await this.sync();
        break;
      }
      case 'cancel': {
        await this.connections.cancel(owner);
        await this.sync();
        break;
      }
      case 'disconnect': {
        this.publish('stopping');
        await this.disconnect();
        this.publish('disconnected');
        break;
      }
      case 'restart': {
        this.stackError = null;
        await this.sync();
        break;
      }
      case 'change_ports': {
        if (this.stack || !this.settings) return;
        const settings = { ...this.settings, ...await initialPorts() };
        await saveSettings(this.settingsPath, settings);
        this.settings = settings;
        this.stackError = null;
        await this.sync();
        break;
      }
    }
  }

  async disconnect() {
    await this.stopStack();
    const connection = await this.connections.disconnect(owner);
    this.bindConnection(connection.revision, false);
    this.needsReconnect = false;
    this.stackError = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.connections.close();
    await this.serial;
    await this.stopStack();
    this.guard?.close();
  }
}
