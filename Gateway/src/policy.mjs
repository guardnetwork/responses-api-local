import { CATALOG, DEFAULT_ALIAS, DEFAULT_SELECTION, isSelectionAlias, supports } from './model-settings.mjs';

export const MODEL = DEFAULT_SELECTION.model;
export const POLICY_ID = 'sol_low_v1';
export const OUTPUT_LIMIT_FIELDS = ['max_output_tokens', 'max_completion_tokens', 'max_tokens'];

const LOCAL_FIELDS = new Set(['background', 'store', 'metadata', 'previous_response_id', 'operation_id']);
const UNSUPPORTED_FIELDS = new Set([
  ...OUTPUT_LIMIT_FIELDS, 'temperature', 'top_p', 'truncation',
  'prompt_cache_options', 'prompt_cache_retention', 'context_management',
  'safety_identifier', 'stream_options', 'generate', 'user', 'reasoning_effort',
]);
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class PolicyError extends Error {
  constructor(code, field) {
    super('Request does not satisfy the model policy.');
    this.name = 'PolicyError';
    this.code = code;
    this.status = 400;
    this.details = { field, safeToRetry: false };
  }
}

function fail(code, field) { throw new PolicyError(code, field); }

function jsonClone(value) {
  let count = 0;
  function check(item, depth) {
    if (++count > 500000 || depth > 64) fail('request_too_complex', 'request');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[i];
        if (!descriptor || !('value' in descriptor)) fail('invalid_json_request', 'request');
        check(descriptor.value, depth + 1);
      }
      if (Reflect.ownKeys(descriptors).length !== item.length + 1) fail('invalid_json_request', 'request');
      return;
    }
    if (!object(item)) fail('invalid_json_request', 'request');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(descriptors).length) fail('invalid_json_request', 'request');
    for (const descriptor of Object.values(descriptors)) {
      if (!('value' in descriptor)) fail('invalid_json_request', 'request');
      check(descriptor.value, depth + 1);
    }
  }
  check(value, 0);
  return JSON.parse(JSON.stringify(value));
}

function checkModel(model, field, expected) {
  if (typeof model !== 'string' || model.trim() !== expected) fail('model_not_allowed', field);
}

export function normalizeRequest(body, selection = null) {
  if (!object(body)) fail('invalid_request', 'request');
  const request = jsonClone(body);
  const changes = [];
  const change = (path, action, reason) => changes.push({ path, action, reason });
  const pair = selection ?? DEFAULT_SELECTION;
  const usesAlias = selection && typeof request.model === 'string' &&
    (request.model.trim() === DEFAULT_ALIAS || isSelectionAlias(request.model));
  if (own(request, 'model') && !usesAlias) checkModel(request.model, 'model', pair.model);
  if (request.model !== pair.model) change('model', 'set', selection ? 'resolved_model' : 'fixed_model');
  request.model = pair.model;

  if (own(request, 'instructions') && typeof request.instructions !== 'string') {
    fail('invalid_request', 'instructions');
  }
  if (!own(request, 'input') || !(typeof request.input === 'string' || Array.isArray(request.input))) {
    fail('invalid_request', 'input');
  }
  if (typeof request.input === 'string') {
    request.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.input }] }];
    change('input', 'normalize', 'codex_input_array');
  }
  if (own(request, 'reasoning') && !object(request.reasoning)) fail('invalid_request', 'reasoning');
  const requestedEffort = typeof request.reasoning?.effort === 'string'
    ? request.reasoning.effort : typeof request.reasoning_effort === 'string' ? request.reasoning_effort : null;
  if (request.reasoning?.effort !== pair.effort) change('reasoning.effort', 'set', selection ? 'resolved_effort' : 'fixed_low');
  request.reasoning = { ...request.reasoning, effort: pair.effort };

  for (let i = 0; i < request.input.length; i++) {
    const item = request.input[i];
    if (!object(item)) fail('invalid_request', 'input');
    if (item.type !== 'configuration_update') continue;
    if (own(item, 'model')) {
      checkModel(item.model, 'configuration_update.model', pair.model);
      item.model = pair.model;
    }
    if (own(item, 'reasoning') && !object(item.reasoning)) fail('invalid_request', 'configuration_update.reasoning');
    if (selection && item.reasoning?.effort != null && item.reasoning_effort != null &&
        item.reasoning.effort !== item.reasoning_effort) fail('reasoning_effort_conflict', `input.${i}.reasoning.effort`);
    const itemEffort = item.reasoning?.effort ?? item.reasoning_effort;
    if (selection && itemEffort !== undefined && itemEffort !== pair.effort) fail('effort_not_allowed', `input.${i}.reasoning.effort`);
    if (item.reasoning?.effort !== pair.effort) change(`input.${i}.reasoning.effort`, 'set', selection ? 'resolved_effort' : 'fixed_low');
    item.reasoning = { ...item.reasoning, effort: pair.effort };
    if (own(item, 'reasoning_effort')) {
      delete item.reasoning_effort;
      change(`input.${i}.reasoning_effort`, 'remove', 'legacy_effort');
    }
  }
  for (const field of [...LOCAL_FIELDS, ...UNSUPPORTED_FIELDS]) {
    if (own(request, field)) {
      delete request[field];
      change(field, 'remove', LOCAL_FIELDS.has(field) ? 'handled_locally' : 'unsupported_by_codex');
    }
  }
  if (request.stream !== true) change('stream', 'set', 'server_stream');
  request.stream = true;
  validatePayload(request, pair);
  return { request, changes, requestedEffort };
}

export function validateFinalRequest(request, selection = DEFAULT_SELECTION) {
  if (!object(request)) fail('invalid_request', 'request');
  // Validate only JSON data, never objects whose getters/toJSON can change the
  // body after the policy check and before its wire serialization.
  return validatePayload(jsonClone(request), selection);
}

function validatePayload(request, { model, effort }) {
  if (request.model !== model || !Object.hasOwn(CATALOG, model)) fail('model_not_allowed', 'model');
  if (!object(request.reasoning) || request.reasoning.effort !== effort || !supports(model, effort)) fail('effort_not_allowed', 'reasoning.effort');
  if (!Array.isArray(request.input)) fail('invalid_request', 'input');
  for (const item of request.input) {
    if (!object(item)) fail('invalid_request', 'input');
    if (item.type !== 'configuration_update') continue;
    if (own(item, 'model') && item.model !== model) fail('model_not_allowed', 'configuration_update.model');
    if (!object(item.reasoning) || item.reasoning.effort !== effort || own(item, 'reasoning_effort')) {
      fail('effort_not_allowed', 'configuration_update.reasoning.effort');
    }
  }
  for (const field of [...LOCAL_FIELDS, ...UNSUPPORTED_FIELDS]) {
    if (field === 'store' && request.store === false) continue;
    if (own(request, field)) fail('nonforwardable_field', field);
  }
  if (own(request, 'stream') && request.stream !== true) fail('invalid_request', 'stream');
  return true;
}
