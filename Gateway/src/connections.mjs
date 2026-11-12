import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, readFile, open, rename, unlink, chmod } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Use the device authorization protocol from CLIProxyAPI 091ff27. This
// manager obtains its own tokens without importing existing Codex credentials.
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEVICE_LIFETIME_MS = 15 * 60 * 1000;
const CLAIMS_KEY = 'https://api.openai.com/auth';

export class ConnectionError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const cleanText = (value, limit = 4096) => typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : null;
function claims(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return {};
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return {}; }
}
async function exists(path) {
  try { const info = await lstat(path); if (info.isSymbolicLink()) throw new ConnectionError('unsafe_credential_path', 503); return info.isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function privateWrite(path, object) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(object) + '\n', 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

export class ConnectionManager {
  #tail = Promise.resolve();
  #currentRead = null;
  #active = null;
  #polls = new Set();
  #closed = false;
  constructor({ authDir, fetchImpl = fetch, clientId = CODEX_CLIENT_ID, issuer = 'https://auth.openai.com', sleepImpl = delay, nowImpl = Date.now } = {}) {
    if (typeof authDir !== 'string' || !authDir.trim()) throw new ConnectionError('auth_directory_required', 503);
    const origin = new URL(issuer);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new ConnectionError('invalid_auth_issuer', 503);
    if (origin.origin !== 'https://auth.openai.com') throw new ConnectionError('unsupported_auth_issuer', 503);
    this.authDir = resolve(authDir);
    this.issuer = origin.origin;
    this.fetchImpl = fetchImpl; this.clientId = clientId; this.sleepImpl = sleepImpl; this.nowImpl = nowImpl;
  }
  #serial(fn) {
    this.#currentRead = null;
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => {});
    return result;
  }
  #time() { return new Date(this.nowImpl()).toISOString(); }
  async #paths(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 300) throw new ConnectionError('owner_required', 401);
    if (this.#closed) throw new ConnectionError('connection_manager_closed', 503);
    const existingCodexDir = resolve(homedir(), '.codex');
    const forbidden = path => {
      const child = relative(existingCodexDir, path);
      return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
    };
    if (forbidden(this.authDir)) throw new ConnectionError('existing_login_directory_forbidden', 503);
    let info;
    try { info = await lstat(this.authDir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(this.authDir, { recursive: true, mode: 0o700 });
      info = await lstat(this.authDir);
    }
    if (!info.isDirectory() || forbidden(await realpath(this.authDir))) throw new ConnectionError('unsafe_auth_directory', 503);
    if ((info.mode & 0o7777) !== 0o700) await chmod(this.authDir, 0o700);
    const ownerHash = hash(ownerId);
    const lockPath = join(this.authDir, '.service-owner.meta');
    if (await exists(lockPath)) {
      let lock; try { lock = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw new ConnectionError('connection_owner_metadata_invalid', 503); }
      if (lock.ownerHash !== ownerHash) throw new ConnectionError('single_owner_connection_required', 403);
    } else {
      try { const file = await open(lockPath, 'wx', 0o600); try { await file.writeFile(JSON.stringify({ ownerHash }) + '\n'); await file.sync(); } finally { await file.close(); } }
      catch (error) { if (error.code !== 'EEXIST') throw error; const lock = JSON.parse(await readFile(lockPath, 'utf8')); if (lock.ownerHash !== ownerHash) throw new ConnectionError('single_owner_connection_required', 403); }
    }
    return { ownerHash, meta: join(this.authDir, '.connection-state.meta'), credential: join(this.authDir, `codex-service-${ownerHash.slice(0, 32)}.json`) };
  }
  async #load(paths) {
    if (!(await exists(paths.meta))) return { connectionId: null, state: 'disconnected', revision: 0, updatedAt: this.#time(), upstreamRevocation: 'not_requested' };
    try {
      const meta = JSON.parse(await readFile(paths.meta, 'utf8'));
      if (meta.ownerHash !== paths.ownerHash || !Number.isSafeInteger(meta.revision) || meta.revision < 0) throw Error();
      if (['starting', 'pending'].includes(meta.state) && this.#active?.id !== meta.connectionId) {
        Object.assign(meta, { state: 'interrupted', userCode: null, verificationUri: null, errorCode: 'device_session_interrupted', updatedAt: this.#time() });
        await privateWrite(paths.meta, meta);
      }
      return meta;
    } catch (error) { if (error instanceof ConnectionError) throw error; throw new ConnectionError('connection_metadata_invalid', 503); }
  }
  async #public(paths, meta) {
    const credentialPresent = await exists(paths.credential);
    const poll = (this.#active?.id === meta.connectionId ? this.#active.poll : null) ?? meta.poll ?? null;
    return { poll, connectionId: meta.connectionId, state: meta.state === 'connected' && !credentialPresent ? 'disconnected' : meta.state,
      revision: meta.revision, credentialPresent, connected: meta.state === 'connected' && credentialPresent,
      verificationUri: meta.state === 'pending' ? meta.verificationUri : null, userCode: meta.state === 'pending' ? meta.userCode : null,
      expiresAt: meta.state === 'pending' ? meta.expiresAt : null, updatedAt: meta.updatedAt, lastAuthenticatedAt: meta.lastAuthenticatedAt ?? null,
      tokenExpiresAt: meta.tokenExpiresAt ?? null, errorCode: meta.errorCode ?? null,
      upstreamAuthorizationVerified: false, upstreamRevocation: meta.upstreamRevocation ?? 'not_requested' };
  }
  current(ownerId) {
    const pending = this.#currentRead;
    if (pending && pending.ownerId === ownerId) return pending.result;
    const result = this.#serial(async () => {
      const paths = await this.#paths(ownerId);
      return this.#public(paths, await this.#load(paths));
    });
    // Share overlapping reads only. Enqueuing any other operation clears this
    // slot, so reads after a disconnect cannot reuse an earlier result.
    const read = this.#currentRead = { ownerId, result };
    const clear = () => { if (this.#currentRead === read) this.#currentRead = null; };
    result.then(clear, clear);
    return result;
  }
  async #request(path, body, signal, form = false) {
    let response;
    try { response = await this.fetchImpl(this.issuer + path, { method: 'POST', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }); }
    catch { if (signal.aborted) throw new ConnectionError('device_session_cancelled'); throw new ConnectionError('device_network_unavailable', 502); }
    if (signal.aborted) { await response.body?.cancel().catch(() => {}); throw new ConnectionError('device_session_cancelled'); }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError('device_redirect_refused', 502);
    let data;
    try { const raw = await response.text(); if (Buffer.byteLength(raw) > 100000) throw Error(); data = JSON.parse(raw); }
    catch { if (!response.ok) return { response, data: {} }; throw new ConnectionError('device_response_invalid', 502); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConnectionError('device_response_invalid', 502);
    if (signal.aborted) throw new ConnectionError('device_session_cancelled');
    return { response, data };
  }
  async start(ownerId) {
    return this.#serial(async () => {
      const paths = await this.#paths(ownerId), previous = await this.#load(paths);
      if (previous.state === 'connected' && await exists(paths.credential) || previous.state === 'pending' && this.#active?.id === previous.connectionId) return this.#public(paths, previous);
      const session = { id: randomUUID(), ownerId, paths, controller: new AbortController() };
      this.#active = session;
      const meta = { ownerHash: paths.ownerHash, connectionId: session.id, revision: previous.revision + 1, state: 'starting', updatedAt: this.#time(), upstreamRevocation: 'not_requested' };
      await privateWrite(paths.meta, meta);
      try {
        const { response, data } = await this.#request('/api/accounts/deviceauth/usercode', { client_id: this.clientId }, session.controller.signal);
        if (!response.ok) throw new ConnectionError(response.status === 404 ? 'device_endpoint_unavailable' : 'device_start_rejected', 502);
        session.deviceAuthId = cleanText(data.device_auth_id); session.userCode = cleanText(data.user_code ?? data.usercode, 120);
        if (!session.deviceAuthId || !session.userCode) throw new ConnectionError('device_response_invalid', 502);
        const seconds = Number(data.interval);
        session.interval = Number.isInteger(seconds) && seconds > 0 && seconds <= 300 ? seconds * 1000 : 5000;
        session.deadline = this.nowImpl() + DEVICE_LIFETIME_MS;
        if (session.controller.signal.aborted) throw new ConnectionError('device_session_cancelled');
        Object.assign(meta, { state: 'pending', verificationUri: this.issuer + '/codex/device', userCode: session.userCode, expiresAt: new Date(session.deadline).toISOString(), updatedAt: this.#time() });
        await privateWrite(paths.meta, meta);
        const polling = Promise.resolve().then(() => this.#poll(session)).catch(() => {});
        this.#polls.add(polling); polling.finally(() => this.#polls.delete(polling));
        return this.#public(paths, meta);
      } catch (error) {
        Object.assign(meta, { state: session.controller.signal.aborted ? 'cancelled' : 'failed', errorCode: error instanceof ConnectionError ? error.code : 'device_start_failed', updatedAt: this.#time() });
        await privateWrite(paths.meta, meta); if (this.#active === session) this.#active = null;
        throw error instanceof ConnectionError ? error : new ConnectionError('device_start_failed', 502);
      }
    });
  }
  async #poll(session) {
    const { controller, paths } = session;
    const observe = (phase, http = null) => { session.poll = { phase, http, at: this.#time() }; };
    try {
      while (!controller.signal.aborted && this.nowImpl() < session.deadline) {
        let poll;
        try { poll = await this.#request('/api/accounts/deviceauth/token', { device_auth_id: session.deviceAuthId, user_code: session.userCode }, controller.signal); }
        catch (error) {
          // Polling only checks the same pending authorization. A temporary
          // transport failure must not discard the user's still-valid code.
          if (error.code !== 'device_network_unavailable' || controller.signal.aborted) throw error;
          observe('network_retry');
          await this.sleepImpl(Math.min(Math.max(session.interval, 5000), Math.max(1, session.deadline - this.nowImpl())), undefined, { signal: controller.signal });
          continue;
        }
        const { response, data } = poll;
        if (response.status === 429 || response.status >= 500) {
          observe('upstream_retry', response.status);
          await this.sleepImpl(Math.min(Math.max(session.interval, 10000), Math.max(1, session.deadline - this.nowImpl())), undefined, { signal: controller.signal });
          continue;
        }
        if (response.ok) {
          observe('token_exchange', response.status);
          const code = cleanText(data.authorization_code), verifier = cleanText(data.code_verifier), challenge = cleanText(data.code_challenge);
          if (!code || !verifier || !challenge || hashPkce(verifier) !== challenge) throw new ConnectionError('device_exchange_fields_invalid', 502);
          const exchanged = await this.#request('/oauth/token', { grant_type: 'authorization_code', client_id: this.clientId, code, redirect_uri: this.issuer + '/deviceauth/callback', code_verifier: verifier }, controller.signal, true);
          if (!exchanged.response.ok) throw new ConnectionError('device_token_exchange_rejected', 502);
          const tokens = exchanged.data;
          if (!cleanText(tokens.access_token, 20000) || !cleanText(tokens.refresh_token, 20000) || !cleanText(tokens.id_token, 30000) || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0 || Number(tokens.expires_in) > 86400 * 365) throw new ConnectionError('device_tokens_invalid', 502);
          const identity = claims(tokens.id_token), auth = identity[CLAIMS_KEY] ?? {};
          // Claims are metadata from the TLS token response, never website identity.
          if (!cleanText(auth.chatgpt_account_id, 300) || !cleanText(identity.email, 320)) throw new ConnectionError('device_account_metadata_missing', 502);
          await this.#serial(async () => {
            if (controller.signal.aborted || this.#active !== session || this.#closed) return;
            const meta = await this.#load(paths);
            if (meta.connectionId !== session.id || meta.state !== 'pending') return;
            const expired = new Date(this.nowImpl() + Number(tokens.expires_in) * 1000).toISOString();
            await privateWrite(paths.credential, { type: 'codex', access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token,
              account_id: auth.chatgpt_account_id, email: identity.email, plan_type: cleanText(auth.chatgpt_plan_type, 80) ?? 'free', expired, last_refresh: this.#time(),
              service_owner_hash: paths.ownerHash, service_connection_id: session.id, service_connection_revision: meta.revision });
            // Tokens are published to CLIProxyAPI only through this private file.
            Object.assign(meta, { poll: { phase: 'connected', http: null, at: this.#time() }, state: 'connected', userCode: null, verificationUri: null, errorCode: null, tokenExpiresAt: expired, lastAuthenticatedAt: this.#time(), updatedAt: this.#time() });
            await privateWrite(paths.meta, meta); this.#active = null;
          });
          return;
        }
        observe(data.error === 'slow_down' ? 'slow_down' : 'awaiting_authorization', response.status);
        if (data.error === 'access_denied' || data.error === 'expired_token') throw new ConnectionError(data.error === 'access_denied' ? 'device_access_denied' : 'device_session_expired');
        if (data.error === 'slow_down') session.interval = Math.min(300000, session.interval + 5000);
        else if (![403, 404].includes(response.status) && data.error !== 'authorization_pending') throw new ConnectionError('device_poll_rejected', 502);
        await this.sleepImpl(Math.min(session.interval, Math.max(1, session.deadline - this.nowImpl())), undefined, { signal: controller.signal });
      }
      if (!controller.signal.aborted) throw new ConnectionError('device_session_expired');
    } catch (error) {
      await this.#serial(async () => {
        if (this.#active !== session) return;
        const meta = await this.#load(paths);
        if (meta.connectionId === session.id && ['starting', 'pending'].includes(meta.state)) {
          Object.assign(meta, { poll: session.poll ?? null, state: controller.signal.aborted ? 'cancelled' : error.code === 'device_session_expired' ? 'expired' : 'failed', userCode: null, verificationUri: null, errorCode: error instanceof ConnectionError ? error.code : 'device_poll_failed', updatedAt: this.#time() });
          await privateWrite(paths.meta, meta);
        }
        this.#active = null;
      });
    }
  }
  async cancel(ownerId) {
    if (this.#active?.ownerId === ownerId) this.#active.controller.abort();
    return this.#serial(async () => {
      const paths = await this.#paths(ownerId), meta = await this.#load(paths);
      if (['starting', 'pending'].includes(meta.state)) {
        Object.assign(meta, { state: 'cancelled', userCode: null, verificationUri: null, errorCode: 'device_session_cancelled', updatedAt: this.#time() });
        await privateWrite(paths.meta, meta);
      }
      if (this.#active?.ownerId === ownerId) this.#active = null;
      return this.#public(paths, meta);
    });
  }
  async disconnect(ownerId) {
    if (this.#active?.ownerId === ownerId) this.#active.controller.abort();
    return this.#serial(async () => {
      const paths = await this.#paths(ownerId), meta = await this.#load(paths);
      await unlink(paths.credential).catch(error => { if (error.code !== 'ENOENT') throw error; });
      Object.assign(meta, { ownerHash: paths.ownerHash, state: 'disconnected', revision: meta.revision + 1, userCode: null, verificationUri: null, errorCode: null, updatedAt: this.#time(), upstreamRevocation: 'not_requested' });
      await privateWrite(paths.meta, meta); if (this.#active?.ownerId === ownerId) this.#active = null;
      return this.#public(paths, meta);
    });
  }
  async close() { this.#active?.controller.abort(); await Promise.allSettled([...this.#polls]); await this.#tail; this.#closed = true; }
}
function hashPkce(verifier) { return createHash('sha256').update(verifier).digest('base64url'); }
