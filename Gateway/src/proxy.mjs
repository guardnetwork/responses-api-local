import { MODEL, POLICY_ID, validateFinalRequest } from './policy.mjs';
import { parseSSE, withSignal } from './sse.mjs';
import { CATALOG_SHA, CATALOG_SOURCE, DEFAULT_SELECTION, PROXY_POLICY_ID } from './model-settings.mjs';

export const PROXY_FORK_ID = PROXY_POLICY_ID;
export const PROXY_SOURCE_COMMIT = '091ff27f31285ec4fd1dd5823b44f7f51fb8f48b';

const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled', 'error']);
const SAFE_UPSTREAM_CODES = new Set([
  'usage_limit_reached', 'rate_limit_exceeded', 'insufficient_quota', 'model_not_found',
  'model_not_supported', 'invalid_encrypted_content', 'invalid_request_error', 'server_error',
  'authentication_error', 'invalid_api_key', 'context_length_exceeded', 'unsupported_parameter',
]);

export class ProxyError extends Error {
  constructor(code, status = 502, details = {}) {
    super('The private inference connection could not finish the request.');
    this.name = 'ProxyError';
    this.code = code;
    this.status = status;
    this.details = { safeToRetry: false, ...details };
    this.retryable = this.details.safeToRetry;
  }
}

function statusError(status, code) {
  const details = { upstreamStatus: status, safeToRetry: true, outcome: 'rejected' };
  if (SAFE_UPSTREAM_CODES.has(code)) details.upstreamCode = code;
  if (status === 401 || status === 403 && ['authentication_error', 'invalid_api_key'].includes(code)) {
    return new ProxyError('upstream_auth_error', status, { ...details, retryHint: 'reconnect_account' });
  }
  if (status === 403 || ['model_not_found','model_not_supported'].includes(code)) return new ProxyError('upstream_model_access_denied', status, details);
  if (code === 'unsupported_parameter') return new ProxyError('upstream_parameter_unsupported', status, details);
  if (status === 429) return new ProxyError(['usage_limit_reached', 'insufficient_quota'].includes(code)
    ? 'upstream_quota_exhausted' : 'upstream_rate_limited', status, { ...details, retryHint: 'wait_for_quota' });
  if (status >= 500 || status === 408) return new ProxyError('upstream_unavailable', status, {
    ...details, safeToRetry: false, outcome: 'unknown', retryHint: 'reconcile_before_retry',
  });
  return new ProxyError('upstream_request_rejected', status, { ...details, retryHint: 'check_configuration' });
}

async function boundedJSON(body, limit, signal) {
  if (!body?.getReader) return null;
  const reader = body.getReader();
  const collected = [];
  let size = 0;
  let done = false;
  try {
    while (true) {
      const next = await withSignal(reader.read(), signal);
      if (next.done) { done = true; break; }
      if (!(next.value instanceof Uint8Array)) return null;
      size += next.value.byteLength;
      if (size > limit) return null;
      collected.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(collected)));
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    return null;
  }
  finally {
    if (!done) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function safeTerminal(event) {
  const safeError = (raw) => ({
    code: SAFE_UPSTREAM_CODES.has(raw?.code) ? raw.code : 'upstream_generation_failed',
    message: 'The inference service reported a failed generation.',
  });
  if (event.type === 'error') {
    return { type: 'error', error: safeError(event.error ?? event),
      ...(Number.isSafeInteger(event.sequence_number) ? { sequence_number: event.sequence_number } : {}) };
  }
  if (event.response?.error) return { ...event, response: { ...event.response, error: safeError(event.response.error) } };
  return event;
}

export class ProxyClient {
  #apiKey;

  constructor({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 3600000 }) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new ProxyError('proxy_configuration_error', 503); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback)
      || url.username || url.password || url.search || url.hash
      || typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)
      || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new ProxyError('proxy_configuration_error', 503);
    }
    const base = url.toString().replace(/\/+$/, '');
    this.endpoints = {
      responses: base.endsWith('/v1') ? `${base}/responses` : `${base}/v1/responses`,
      models: base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`,
      health: `${base.replace(/\/v1$/, '')}/healthz`,
    };
    this.#apiKey = apiKey.trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async *run(request, { signal, selection = DEFAULT_SELECTION } = {}) {
    validateFinalRequest(request, selection);
    const body = JSON.stringify({ ...request, stream: true, store: false });
    // This is the body actually passed to fetch. Reject any unexpected change
    // rather than falling back to another model or effort.
    validateFinalRequest(JSON.parse(body), selection);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timedOut = false;
    let phase = 'response_headers';
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      if (combined.aborted) throw new ProxyError('upstream_cancelled', 499, {
        phase: 'not_sent', outcome: 'not_started', safeToRetry: true,
      });
      const response = await withSignal(this.fetchImpl(this.endpoints.responses, {
        method: 'POST', redirect: 'manual', signal: combined,
        headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body,
      }), combined);
      if (response.status >= 300 && response.status < 400 || response.redirected || response.type === 'opaqueredirect') {
        response.body?.cancel?.().catch(() => {});
        throw new ProxyError('upstream_redirect_blocked', 502, { phase, outcome: 'unknown' });
      }
      if (!response.ok) {
        const payload = await boundedJSON(response.body, 65536, combined);
        throw statusError(response.status, payload?.error?.code ?? payload?.code);
      }
      phase = 'stream';
      if (!response.headers?.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        response.body?.cancel?.().catch(() => {});
        throw new ProxyError('upstream_protocol_error', 502, { phase, outcome: 'unknown' });
      }
      for await (const frame of parseSSE(response.body, { signal: combined })) {
        if (frame.data.trim() === '[DONE]') continue;
        let event;
        try { event = JSON.parse(frame.data); }
        catch { throw new ProxyError('upstream_protocol_error', 502, { phase, outcome: 'unknown' }); }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string'
          || frame.event && frame.event !== 'message' && frame.event !== event.type) {
          throw new ProxyError('upstream_protocol_error', 502, { phase, outcome: 'unknown' });
        }
        if (event.type.startsWith('response.') && TERMINAL.has(event.type)
          && (!event.response || typeof event.response !== 'object' || Array.isArray(event.response)
            || event.response.status !== event.type.slice('response.'.length))) {
          throw new ProxyError('upstream_protocol_error', 502, { phase, outcome: 'unknown' });
        }
        yield TERMINAL.has(event.type) ? safeTerminal(event) : event;
        if (TERMINAL.has(event.type)) return;
      }
      throw new ProxyError('upstream_stream_truncated', 502, { phase, outcome: 'unknown', retryHint: 'reconcile_before_retry' });
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      if (timedOut) throw new ProxyError('upstream_timeout', 504, { phase, outcome: 'unknown', retryHint: 'reconcile_before_retry' });
      if (signal?.aborted) throw new ProxyError('upstream_cancelled', 499, { phase, outcome: 'unknown', retryHint: 'reconcile_before_retry' });
      if (error?.code?.startsWith('upstream_')) throw new ProxyError(error.code, 502, { phase, outcome: 'unknown' });
      throw new ProxyError('upstream_transport_error', 502, { phase, outcome: 'unknown', retryHint: 'reconcile_before_retry' });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async getReadiness({ signal, model = MODEL } = {}) {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 10000));
    let health = false;
    let modelIds = null;
    let forkId = null;
    let sourceCommit = null;
    let maxGateDeclared = false;
    try {
      const [healthResponse, modelResponse] = await Promise.all([
        withSignal(this.fetchImpl(this.endpoints.health, { redirect: 'manual', signal: combined }), combined),
        withSignal(this.fetchImpl(this.endpoints.models, { redirect: 'manual', signal: combined,
          headers: { Authorization: `Bearer ${this.#apiKey}` } }), combined),
      ]);
      health = healthResponse.ok && !healthResponse.redirected;
      if (health) {
        const healthMetadata = await boundedJSON(healthResponse.body, 16384, combined);
        if (healthMetadata?.forkId === PROXY_FORK_ID) forkId = PROXY_FORK_ID;
        if (healthMetadata?.sourceCommit === PROXY_SOURCE_COMMIT) sourceCommit = PROXY_SOURCE_COMMIT;
        const policy = healthMetadata?.policy;
        maxGateDeclared = forkId !== null && sourceCommit !== null && policy?.catalogSha256 === CATALOG_SHA
          && policy?.registryCommit === CATALOG_SOURCE.commit
          && policy?.enforcement === 'after_payload_finalizer_before_http_request'
          && policy?.transport === 'http' && policy?.websocket === 'blocked';
      } else healthResponse.body?.cancel?.().catch(() => {});
      if (modelResponse.ok && !modelResponse.redirected) {
        const models = await boundedJSON(modelResponse.body, 262144, combined);
        if (Array.isArray(models?.data) && models.data.every(entry => typeof entry?.id === 'string')) {
          modelIds = models.data.map(entry => entry.id);
        }
      } else modelResponse.body?.cancel?.().catch(() => {});
    } catch { /* Public metadata remains explicit when the proxy is unreachable. */ }
    finally { clearTimeout(timer); controller.abort(); }
    const listed = modelIds?.includes(model) ?? null;
    return {
      ready: health && listed === true && maxGateDeclared, configured: true, health: { status: health ? 'ok' : 'unavailable' },
      modelIds: maxGateDeclared ? modelIds : null,
      // The OpenAI-compatible model list omits reasoning effort levels. An exact
      // ID match confirms only that the proxy lists the model.
      model: { id: model, listed, maxEffortListed: null },
      policy: { id: POLICY_ID, catalogSha256: CATALOG_SHA, enforcedLocally: true },
      fork: { id: forkId, sourceCommit, maxGateDeclared },
      liveInferenceVerified: false, liveMaxVerified: false,
    };
  }
}
