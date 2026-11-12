import { randomUUID } from 'node:crypto';
import { MODEL, POLICY_ID, normalizeRequest, validateFinalRequest } from './policy.mjs';
import { hash, fault, TERMINAL_STATES } from './store.mjs';
import { ModelSettings, PROXY_POLICY_ID, matchesReportedModel, supports } from './model-settings.mjs';

const asInput = value => typeof value === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: value }] }] : Array.isArray(value) ? value : [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(value) }] }];
const historyInput = value => asInput(value).map(item => {
  if (item?.type !== 'configuration_update') return item;
  const { model, reasoning, reasoning_effort, ...history } = item;
  return history;
});
export const extractText = r => typeof r.output_text === 'string' ? r.output_text : (r.output || []).filter(x => x.type === 'message').flatMap(x => (x.content || []).filter(c => c.type === 'output_text').map(c => c.text || '')).join('\n');

export class Service {
  constructor({ store, proxy, connections, config }) {
    this.store = store; this.proxy = proxy; this.connections = connections; this.config = config;
    this.models = new ModelSettings(store);
    this.controllers = new Map(); this.closed = false;
    this.timer = setInterval(() => { this.store.recoverExpired(); this.schedulePump(); this.prune(); }, 1000);
    this.timer.unref();
    this.store.recoverExpired();
  }
  get running() { return this.controllers.size > 0; }
  assertRetained(job) {
    if (job.metadata?.retain === false && job.response === null && TERMINAL_STATES.has(job.execution_status)
        && Object.keys(job.request ?? {}).length === 0) throw fault('response_retention_expired', 404);
  }
  response(job, diagnostics = true) {
    this.assertRetained(job);
    const effort = job.request.reasoning?.effort ?? null;
    const model = job.request.model ?? MODEL;
    const original = job.response || {};
    const status = job.execution_status === 'running' ? 'in_progress' : ['retrying', 'cancel_requested'].includes(job.execution_status) ? 'in_progress' : job.execution_status === 'unknown' ? 'failed' : job.execution_status;
    const response = {
      id: job.response_id, object: 'response', created_at: Math.floor(Date.parse(job.created_at) / 1000), status,
      model: job.reported_model || model, output: original.output || [],
      usage: original.usage || null, error: job.error_code ? { type: 'gateway_error', code: job.error_code, message: job.error_code } : null,
      incomplete_details: original.incomplete_details || null,
    };
    if (!diagnostics) return response;
    const { forwarded, timing } = this.store.responseMetrics(job);
    return { ...response, reasoning: { effort: original.reasoning?.effort ?? null },
      output_text: job.output_text || '', instructions: null,
      metadata: job.metadata?.clientMetadata || {},
      background: true, store: job.metadata?.retain !== false,
      skill_store: { channel: 'codex_oauth_proxy', policy_id: job.metadata?.policyId ?? (effort ? POLICY_ID : null),
        caller_requested_model: job.metadata?.callerRequestedModel ?? null, requested_model: model,
        caller_requested_effort: job.metadata?.callerRequestedEffort ?? null, requested_effort: effort,
        forwarded_model: forwarded ? model : null, forwarded_effort: forwarded ? effort : null,
        reported_model: job.reported_model ?? null, reported_effort: original.reasoning?.effort ?? null,
        provider_response_id: typeof original.id === 'string' ? original.id : null, job_id: job.id, execution_status: job.execution_status, save_status: job.save_status, official_billing_verified: false,
        workload: job.metadata?.workload ?? 'background', local_timing: timing },
    };
  }
  async capabilities(owner) {
    const connection = await this.connections.current(owner);
    const scope = this.modelScope(owner);
    const defaults = this.models.defaults(owner, scope);
    let proxyState;
    try { proxyState = await this.proxy.getReadiness({ model: defaults.model }); } catch { proxyState = { ready: false, error_code: 'proxy_unavailable' }; }
    return {
      schema: 'local-responses-capabilities-v1', channel: 'codex_oauth_proxy', policy: { id: POLICY_ID, ...defaults,
        other_models: this.models.listed(owner, scope, proxyState?.modelIds ?? []).some(model => model.id !== MODEL && model.id !== 'local-default'), silent_downgrade: false },
      connection, proxy: proxyState,
      model_execution_ready: connection.connected === true && proxyState.ready === true,
      successful_proxy_generations: this.store.prepare("SELECT COUNT(*) AS n FROM jobs WHERE owner_id=? AND execution_status='completed' AND json_extract(metadata_json,'$.test_only') IS NOT 1").get(owner).n,
      official_model_execution_independently_verified: false,
      storage: { engine: 'sqlite', deployment: 'single-instance', server_side: true, zero_data_retention: false, store_false_terminal_retention_seconds: 600 },
      scheduler: { max_concurrent: this.config.maxConcurrent ?? 2, interactive_slots: 1, background_slots: 1,
        selection: 'metadata.skill_store_workload', default_workload: 'background', upstream_latency_guaranteed: false },
      response_stream: { resumable_get: true, cursor: 'sequence_number_or_last_event_id', poll_interval_ms: 50 },
      audio: { speech: false, transcriptions: false, provider: null },
      supported: ['responses', 'chat_completions', 'anthropic_messages', 'sse', 'local_background', 'local_response_retrieval', 'idempotency'],
      not_implemented: ['hosted_tools_execution', 'audio'],
    };
  }
  modelScope(owner) { return this.config.modelScope || String(this.store.connectionRevision(owner).revision); }

  async modelStatus(owner) {
    const { modelIds } = await this.proxy.getReadiness();
    return this.models.status(owner, this.modelScope(owner), modelIds ?? null);
  }

  async availableModels(owner) {
    const { modelIds } = await this.proxy.getReadiness();
    if (!modelIds) throw fault('proxy_catalog_unavailable', 503);
    return this.models.listed(owner, this.modelScope(owner), modelIds, true);
  }

  async changeModel(owner, { action, model, effort }) {
    const scope = this.modelScope(owner);
    if (typeof model !== 'string' || typeof effort !== 'string' || !supports(model, effort)) throw fault('effort_not_allowed');
    if (action === 'apply') {
      const { modelIds } = await this.proxy.getReadiness();
      if (!modelIds) throw fault('proxy_catalog_unavailable', 503);
      if (!modelIds.includes(model)) throw fault('proxy_model_not_listed', 404);
      if (this.modelScope(owner) !== scope) throw fault('connection_changed', 409);
      this.models.apply(owner, scope, { model, effort });
    }
    else if (action === 'test') {
      if (this.models.status(owner, scope).testing) throw fault('model_test_in_progress', 409);
      this.createResponse(owner, { model, reasoning: { effort }, input: 'Reply with OK.', store: false,
        background: true, metadata: { skill_store_workload: 'interactive' } }, undefined, { probe: true });
    } else throw fault('invalid_model_action');
    return this.modelStatus(owner);
  }

  async submit(owner, body, key, options) {
    try { return this.createResponse(owner, body, key, options); }
    catch (error) {
      if (error.selection) {
        const { model } = error.selection;
        const { modelIds } = await this.proxy.getReadiness();
        if (!modelIds) throw fault('proxy_catalog_unavailable', 503);
        if (!modelIds.includes(model)) throw fault('proxy_model_not_listed', 404);
      }
      throw error;
    }
  }

  createResponse(owner, body, key, { probe = false, format } = {}) {
    if (!body || Array.isArray(body) || typeof body !== 'object') throw fault('invalid_request');
    const original = body;
    const workload = body.metadata?.skill_store_workload ?? 'background';
    if (!['interactive', 'background'].includes(workload)) throw fault('invalid_workload');
    const effectiveKey = key || randomUUID(), operationId = body.operation_id || effectiveKey;
    if (typeof operationId !== 'string') throw fault('invalid_operation_id');
    const hashInput = format ? { mode: format, body: original } : original;
    const existing = key || body.operation_id ? this.store.existing(owner, effectiveKey, operationId) : null;
    if (existing) {
      // Older clients could opt into application defaults with a header that
      // also affected their saved idempotency hash.
      if (existing.request_hash !== hash(hashInput) &&
          (format || existing.request_hash !== hash({ mode: 'responses-app-defaults', body: original }))) {
        throw fault('idempotency_conflict', 409);
      }
      return { job: existing, replayed: true };
    }
    const revision = this.store.connectionRevision(owner).revision;
    const scope = this.config.modelScope || String(revision);
    let effective = body;
    const selection = this.models.choose(owner, scope, body, probe);
    if (body.previous_response_id) {
      const previous = this.store.get(owner, body.previous_response_id);
      if (previous.execution_status !== 'completed' || !previous.response) throw fault('previous_response_not_completed', 409);
      if (previous.metadata.connectionRevision !== revision) throw fault('previous_response_connection_changed', 409);
      if (previous.request.model !== selection.model) throw fault('previous_response_model_changed', 409);
      effective = { ...body, input: [...historyInput(previous.request.input || []),
        ...(previous.response.output || []), ...asInput(body.input || '')] };
      if (effective.instructions === undefined && typeof previous.request.instructions === 'string') effective.instructions = previous.request.instructions;
    }
    const normalized = normalizeRequest(effective, selection);
    const policyId = selection.model === MODEL && selection.effort === 'low' ? POLICY_ID : PROXY_POLICY_ID;
    const result = this.store.create({ owner, key: effectiveKey, operationId, request: normalized.request, original, originalHash: hash(hashInput), changes: normalized.changes,
      metadata: { retain: body.store !== false, clientMetadata: body.metadata || {}, workload, connectionRevision: revision,
        callerRequestedModel: body.model ?? null, callerRequestedEffort: normalized.requestedEffort, policyId,
        ...(probe && { modelProbe: selection, modelScope: scope }), test_only: probe || this.config.testMode === true } });
    this.schedulePump();
    return result;
  }
  schedulePump() {
    if (this.closed || this.pumpImmediate) return;
    this.pumpImmediate = setImmediate(() => {
      this.pumpImmediate = null;
      const maxConcurrent = this.config.maxConcurrent ?? 2;
      while (!this.closed && this.controllers.size < maxConcurrent) {
        const active = this.store.claim(Date.now(), 120000, { maxConcurrent });
        if (!active) break;
        void this.runJob(active);
      }
    });
  }
  async runJob({ job, attemptId }) {
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    const probeTimeout = job.metadata.modelProbe ? AbortSignal.timeout(45000) : null;
    const signal = probeTimeout ? AbortSignal.any([controller.signal, probeTimeout]) : controller.signal;
    const heartbeat = setInterval(() => this.store.heartbeat(job.id), 30000); heartbeat.unref();
    try {
      const connection = await this.connections.current(job.owner_id);
      const binding = this.store.connectionRevision(job.owner_id);
      if (!connection.connected || !binding.enabled) throw fault('subscription_connection_required', 503);
      if (job.metadata.connectionRevision !== binding.revision) throw fault('connection_changed', 409);
      const selection = { model: job.request.model, effort: job.request.reasoning?.effort };
      const readiness = await this.proxy.getReadiness({ signal, model: selection.model });
      if (!readiness.ready) throw fault(readiness.modelIds && !readiness.modelIds.includes(selection.model)
        ? 'proxy_model_not_listed' : 'proxy_catalog_unavailable', 503);
      if (signal.aborted || this.closed) throw fault('worker_shutdown', 503);
      const beforeDispatch = this.store.connectionRevision(job.owner_id);
      if (!beforeDispatch.enabled || beforeDispatch.revision !== job.metadata.connectionRevision) throw fault('connection_changed', 409);
      validateFinalRequest(job.request, selection);
      this.store.submitted(job.id, attemptId);
      let terminal = false, upstreamId;
      for await (const event of this.proxy.run(job.request, { signal, selection })) {
        if (event.response?.id && event.response.id !== upstreamId) {
          upstreamId = event.response.id;
          this.store.upstreamId(attemptId, upstreamId);
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          this.store.event(job.id, event.type, { type: event.type, delta: event.delta, output_index: event.output_index, content_index: event.content_index });
        } else if (event.type === 'response.created' || event.type === 'response.in_progress') {
          this.store.event(job.id, 'response.in_progress', { type: 'response.in_progress', response: { id: job.response_id, object: 'response', status: 'in_progress', model: selection.model } });
        }
        if (event.type === 'response.completed') {
          const response = event.response;
          if (!response || response.status && response.status !== 'completed' || !Array.isArray(response.output)) throw fault('invalid_completed_response', 502);
          let text;
          try {
            if (response.model && !matchesReportedModel(selection.model, response.model)) throw fault('reported_model_mismatch', 502);
            if (response.reasoning?.effort && response.reasoning.effort !== selection.effort) throw fault('reported_effort_mismatch', 502);
            if (job.metadata.modelProbe && (!matchesReportedModel(selection.model, response.model) ||
                response.reasoning?.effort !== selection.effort ||
                typeof response.id !== 'string' || !response.id.trim() || response.id.length >= 240)) {
              throw fault('model_verification_unconfirmed', 502);
            }
            text = extractText(response);
            if (!response.output.length) throw fault('empty_response', 502);
            const binding = this.store.connectionRevision(job.owner_id);
            if (!binding.enabled || binding.revision !== job.metadata.connectionRevision) throw fault('connection_changed', 409);
          } catch (error) {
            this.store.terminal(job.id, response);
            throw error;
          }
          const stored = this.store.finish(job.id, attemptId, response, text,
            () => this.response(this.store.getResponse(job.owner_id, job.response_id)));
          if (!stored) this.store.terminal(job.id, response);
          terminal = true; break;
        }
        if (['response.failed', 'response.incomplete', 'response.cancelled', 'error'].includes(event.type)) {
          const code = classifyProviderError(event.response?.error || event.error || event);
          if (event.response) {
            this.store.providerTerminal(job.id, attemptId, event.response, event.type === 'response.incomplete' ? 'provider_incomplete' : event.type === 'response.cancelled' ? 'provider_cancelled' : code);
            this.store.event(job.id, event.type, { type: event.type, response: this.response(this.store.getInternal(job.id)) });
            terminal = true; break;
          }
          throw fault(code, 502);
        }
      }
      if (!terminal) throw fault('upstream_stream_truncated', 502);
    } catch (error) {
      const code = probeTimeout?.aborted ? 'model_test_timeout' :
        typeof error.code === 'string' && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code : 'provider_connection_error';
      const uncertain = error.details?.outcome === 'unknown' || ['upstream_stream_truncated', 'provider_connection_error', 'upstream_timeout', 'worker_shutdown', 'upstream_transport_error', 'upstream_protocol_error'].includes(code);
      const transient = !uncertain && (error.details?.safeToRetry === true && ['upstream_rate_limited', 'provider_rate_limited'].includes(code));
      const current = this.store.getInternal(job.id);
      const retry = !this.closed && !signal.aborted && transient && current.attempt_count < this.config.maxAttempts;
      this.store.fail(job.id, attemptId, code, retry, retry ? 1000 * current.attempt_count : 0, uncertain);
      if (!retry) this.store.event(job.id, 'response.failed', { type: 'response.failed', response: this.response(this.store.getInternal(job.id)) });
    } finally {
      clearInterval(heartbeat); this.controllers.delete(job.id);
      this.schedulePump();
    }
  }
  cancel(owner, id) { const job = this.store.cancel(owner, id); this.controllers.get(job.id)?.abort(); return job; }
  async disconnect(owner) {
    this.store.changeConnection(owner, false);
    for (const [id, controller] of this.controllers) if (this.store.getInternal(id)?.owner_id === owner) controller.abort();
    return this.connections.disconnect(owner);
  }
  prune() {
    const expired = this.store.prepare("SELECT id FROM jobs WHERE json_extract(metadata_json,'$.retain')=0 AND request_json!='{}' AND execution_status IN('completed','failed','incomplete','unknown','cancelled') AND updated_at<?").all(new Date(Date.now() - 600000).toISOString());
    for (const job of expired) this.store.transaction(() => {
      this.store.prepare("UPDATE jobs SET response_json=NULL,terminal_json=NULL,original_json=NULL,request_json='{}',output_text=NULL,metadata_json=json_remove(metadata_json,'$.clientMetadata') WHERE id=?").run(job.id);
      this.store.prepare('DELETE FROM events WHERE job_id=?').run(job.id);
    });
  }
  async close() {
    this.closed = true; clearInterval(this.timer); clearImmediate(this.pumpImmediate);
    for (const controller of this.controllers.values()) controller.abort();
    await this.connections.close?.();
    while (this.running) await new Promise(r => setTimeout(r, 25));
  }
}

export function classifyProviderError(error) {
  const code = String(error?.code || error?.type || '');
  if (/quota|usage_limit_reached|credit_balance|insufficient/i.test(code)) return 'provider_quota_exhausted';
  if (/rate_limit/i.test(code)) return 'provider_rate_limited';
  if (/auth|token|unauthoriz/i.test(code)) return 'provider_auth_failed';
  if (/model/i.test(code)) return 'upstream_model_access_denied';
  if (code === 'unsupported_parameter') return 'upstream_parameter_unsupported';
  if (code === 'invalid_request_error') return 'upstream_request_rejected';
  return 'provider_generation_failed';
}
