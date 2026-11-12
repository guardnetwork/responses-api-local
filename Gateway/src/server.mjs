import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { fault, TERMINAL_STATES } from './store.mjs';
import { POLICY_ID } from './policy.mjs';
import { compatibilityRequest, compatibilityResponse, compatibilityError, compatibilityStatus, compatibilityStream,
  ignoredOutputLimits, requestErrorMessage } from './compat.mjs';

const equal = (a, b) => { if (typeof a !== 'string') return false; const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const terminalEvents = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled']);
const terminalWake = new Set([...terminalEvents, 'job.failed', 'job.cancelled', 'job.unknown', 'job.recovered']);

function watchJob(store, id, response, eventTypes) {
  let changed = false, closed = response.destroyed, wake;
  const notify = type => {
    if (eventTypes && !eventTypes.has(type)) return;
    changed = true; wake?.();
  };
  const close = () => { closed = true; wake?.(); };
  store.changes.on(id, notify);
  response.once('close', close);
  return {
    get changed() { return changed; },
    get closed() { return closed; },
    reset() { changed = false; },
    async wait(timeout) {
      if (changed || closed) return;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, timeout);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
    },
    dispose() {
      store.changes.off(id, notify);
      response.off('close', close);
    },
  };
}

function writeFrame(response, frame) {
  if (response.destroyed || response.write(frame)) return;
  return new Promise(resolve => {
    const ready = () => {
      response.off('drain', ready);
      response.off('close', ready);
      resolve();
    };
    response.once('drain', ready);
    response.once('close', ready);
  });
}

function nativeFrame(event) {
  return event.text ??= `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify({ ...event.data, sequence_number: event.id })}\n\n`;
}

export function createApiServer(service, config) {
  const owner = config.ownerId;
  let sharedPage;
  function streamPage(id, after) {
    if (sharedPage?.id === id && sharedPage.after === after && sharedPage.version === service.store.eventVersion) return sharedPage;
    const events = service.store.eventsForJob(id, after);
    const page = {
      id, after, version: service.store.eventVersion,
      cursor: events.at(-1)?.id ?? after,
      full: events.length === 500,
      status: events.length < 500 ? service.store.status(id) : null,
      events: events.filter(event => event.event_type.startsWith('response.')),
    };
    // Subscribers woken together share one read and encoding. Release the page
    // after this microtask batch, even if the job stays idle or a client stalls.
    sharedPage = page;
    queueMicrotask(() => { if (sharedPage === page) sharedPage = undefined; });
    return page;
  }
  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-skillstore-channel': 'codex_oauth_proxy' });
    res.end(JSON.stringify(body));
  };
  async function read(req) {
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw fault('json_required', 415);
    const declared = req.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > config.maxBodyBytes)) throw fault('body_too_large', 413);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > config.maxBodyBytes) throw fault('body_too_large', 413); chunks.push(chunk); }
    let value;
    try { value = JSON.parse(utf8.decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size))); } catch { throw fault('invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('invalid_request');
    return value;
  }
  function authenticate(req, secret = config.apiKey) {
    const token = String(req.headers.authorization || '');
    if (!token.startsWith('Bearer ') || !equal(token.slice(7), secret)) throw fault('unauthorized', 401);
  }
  function key(req) {
    const k = req.headers['idempotency-key'];
    if (!k) return undefined;
    if (typeof k !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(k)) throw fault('idempotency_key_required');
    return k;
  }
  async function preflight(k) {
    if (k && service.store.prepare('SELECT id FROM jobs WHERE owner_id=? AND idempotency_key=?').get(owner, k)) return;
    const current = await service.connections.current(owner);
    if (!current.connected || !service.store.connectionRevision(owner).enabled) throw fault('subscription_connection_required', 503);
  }
  function cursor(req, url) {
    const query = url.searchParams.get('starting_after'), header = req.headers['last-event-id'];
    if (query !== null && header !== undefined && query !== header) throw fault('event_cursor_conflict');
    const last = query ?? header ?? '0';
    if (!/^\d{1,16}$/.test(last)) throw fault('invalid_event_cursor');
    const value = Number(last);
    if (!Number.isSafeInteger(value)) throw fault('invalid_event_cursor');
    return value;
  }
  async function stream(res, initial, after = 0, protocol) {
    service.assertRetained(initial); // Retention errors must be JSON errors before SSE headers.
    let cursor = after, terminalSent = false;
    const watcher = watchJob(service.store, initial.id, res);
    res.setHeader('x-skillstore-response-id', initial.response_id);
    res.socket?.setNoDelay(true);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', 'connection': 'keep-alive', 'x-accel-buffering': 'no', 'x-skillstore-channel': 'codex_oauth_proxy' });
    res.write(': connected\n\n');
    try {
      while (!watcher.closed) {
        watcher.reset();
        const page = streamPage(initial.id, cursor);
        let terminalResponse;
        for (const event of page.events) {
          const terminal = terminalEvents.has(event.event_type);
          terminalSent ||= terminal;
          let frame;
          if (protocol) {
            if (terminal) { terminalResponse = event.data.response; break; }
            frame = protocol.event(event.event_type, event.data).join('');
          } else frame = nativeFrame(event);
          const drain = frame && writeFrame(res, frame);
          if (drain) await drain;
          if (watcher.closed) return;
        }
        if (protocol && (terminalSent || TERMINAL_STATES.has(page.status))) {
          const completed = terminalResponse ?? service.response(service.store.getResponse(owner, initial.response_id), false);
          res.end(protocol.finish(completed).join('')); return;
        }
        cursor = page.cursor;
        if (page.full || watcher.changed) continue;
        if (TERMINAL_STATES.has(page.status)) {
          if (!terminalSent) {
            const job = service.store.getResponse(owner, initial.response_id);
            const type = job.execution_status === 'completed' ? 'response.completed' : job.execution_status === 'incomplete' ? 'response.incomplete' : job.execution_status === 'cancelled' ? 'response.cancelled' : 'response.failed';
            await writeFrame(res, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: cursor, response: service.response(job) })}\n\n`);
          }
          res.end(); return;
        }
        await watcher.wait(15000);
        if (!watcher.changed && !watcher.closed) await writeFrame(res, ': keepalive\n\n');
      }
    } catch (error) {
      if (!protocol) throw error;
      if (!res.destroyed) res.end(protocol.error(error.code ?? 'internal_error').join(''));
    } finally { watcher.dispose(); }
    // Closing a view only detaches its subscriber; it does not cancel a durable job.
  }
  async function waitForTerminal(res, job, timeout) {
    const until = Date.now() + timeout;
    const watcher = watchJob(service.store, job.id, res, terminalWake);
    try {
      while (!watcher.closed && Date.now() < until) {
        watcher.reset();
        if (TERMINAL_STATES.has(service.store.status(job.id))) return service.store.getResponse(owner, job.response_id);
        await watcher.wait(Math.max(1, until - Date.now()));
      }
    } finally { watcher.dispose(); }
  }
  const anthropicModel = ({ id, model, efforts }) => ({ type: 'model', id,
    display_name: model ? `${model} · ${efforts[0]}` : id === 'local-default' ? 'Application default' : id,
    created_at: '1970-01-01T00:00:00Z' });
  function selectionHeaders(res, job, ignored) {
    service.assertRetained(job);
    res.setHeader('x-responses-model', job.request.model);
    res.setHeader('x-responses-reasoning-effort', job.request.reasoning.effort);
    if (ignored.length) res.setHeader('x-responses-unsupported-parameters', ignored.join(', '));
  }

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    let anthropic = false, compatible = false;
    res.setHeader('x-request-id', requestId);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      anthropic = path.startsWith('/anthropic/');
      compatible = anthropic || path === '/v1/chat/completions';
      if (url.searchParams.has('api_key') || url.searchParams.has('token')) throw fault('credentials_in_url_not_allowed');
      if (req.method === 'GET' && (path === '/health' || path === '/healthz')) return json(res, { status: 'ok', service: 'local-responses-api', version: '1.1.0' });
      if (path === '/__desktop/model-settings' && config.proxyKey) {
        authenticate(req, config.proxyKey);
        if (req.method === 'GET') return json(res, await service.modelStatus(owner));
        if (req.method === 'POST') {
          const value = await read(req);
          await preflight();
          return json(res, await service.changeModel(owner, value));
        }
        throw fault('not_found', 404);
      }
      if (anthropic && req.headers['x-api-key'] !== undefined) {
        if (!equal(req.headers['x-api-key'], config.apiKey)) throw fault('unauthorized', 401);
        if (req.headers.authorization !== undefined) authenticate(req);
      } else authenticate(req);
      if (anthropic && req.method === 'GET' && path === '/anthropic/v1/models') {
        const data = (await service.availableModels(owner)).map(anthropicModel);
        return json(res, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
      }
      if (anthropic && req.method === 'GET' && path.startsWith('/anthropic/v1/models/')) {
        const entry = (await service.availableModels(owner)).find(item => item.id === path.slice('/anthropic/v1/models/'.length));
        if (!entry) throw fault('model_not_available', 404);
        return json(res, anthropicModel(entry));
      }
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/anthropic/v1/messages')) {
        const value = await read(req), k = key(req);
        const { request, ignored, includeUsage } = compatibilityRequest(value, anthropic);
        await preflight(k);
        const { job } = await service.submit(owner, request, k, { format: anthropic ? 'messages' : 'chat' });
        selectionHeaders(res, job, ignored);
        if (request.stream) return await stream(res, job, 0,
          compatibilityStream(service.response(job, false), anthropic, includeUsage, requestId));
        const completed = await waitForTerminal(res, job, 120000);
        if (res.destroyed) return;
        if (!completed) throw fault('generation_timeout', 504);
        const response = service.response(completed, false);
        if (!['completed', 'incomplete'].includes(response.status)) {
          const code = response.error?.code ?? 'provider_generation_failed';
          throw fault(code, compatibilityStatus(code));
        }
        return json(res, compatibilityResponse(response, anthropic));
      }
      if (req.method === 'GET' && path === '/v10/capabilities') return json(res, await service.capabilities(owner));
      if (req.method === 'GET' && path === '/v1/models') return json(res, { object: 'list', data:
        (await service.availableModels(owner)).map(({ id, efforts }) => ({ id, object: 'model', created: 0,
          owned_by: 'codex_oauth_proxy', reasoning: { supported_efforts: efforts }, policy_id: POLICY_ID,
          availability: 'available' })) });
      if (req.method === 'POST' && path === '/v1/responses') {
        const value = await read(req), k = key(req);
        if (value.effort != null || value.output_config?.effort != null) throw fault('unsupported_reasoning_parameter');
        const ignored = ignoredOutputLimits(value);
        const after = value.stream === true ? cursor(req, url) : 0;
        await preflight(k);
        const result = await service.submit(owner, value, k);
        selectionHeaders(res, result.job, ignored);
        res.setHeader('x-skillstore-job-id', result.job.id);
        res.setHeader('x-skillstore-response-id', result.job.response_id);
        if (value.stream === true) return await stream(res, result.job, after);
        if (value.background === true) return json(res, service.response(result.job), 200);
        const completed = await waitForTerminal(res, result.job, 60000);
        if (completed) return json(res, service.response(completed));
        if (!res.destroyed) return json(res, { ...service.response(service.store.getResponse(owner, result.job.response_id)), skill_store_async: true }, 202);
        return;
      }
      const responsePath = path.match(/^\/v1\/responses\/(ss_resp_[A-Za-z0-9_-]+)(?:\/(cancel))?$/);
      if (responsePath) {
        const [, id, action] = responsePath;
        if (req.method === 'GET' && !action) {
          if (url.searchParams.has('stream') && !['true', 'false'].includes(url.searchParams.get('stream'))) throw fault('invalid_stream_parameter');
          const job = service.store.getResponse(owner, id);
          if (url.searchParams.get('stream') === 'true') return await stream(res, job, cursor(req, url));
          return json(res, service.response(job));
        }
        if (req.method === 'POST' && action === 'cancel') { await read(req); return json(res, service.response(service.cancel(owner, id))); }
      }
      if (path.startsWith('/v1/') || anthropic) throw fault('endpoint_not_implemented', 501);
      throw fault('not_found', 404);
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.end(); return; }
      const code = typeof error.code === 'string' && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code : 'internal_error';
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : code === 'internal_error' ? 500 : 400;
      if (compatible) return json(res, compatibilityError(code, status, anthropic, requestId), status);
      json(res, { error: { code, message: requestErrorMessage(code), type: 'gateway_error', request_id: requestId } }, status);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  return server;
}
