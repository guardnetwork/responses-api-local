import { fault } from './store.mjs';
import { OUTPUT_LIMIT_FIELDS } from './policy.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : invalid();
const string = value => typeof value === 'string' ? value : invalid();
const invalid = () => { throw fault('invalid_request'); };
const unsupported = () => { throw fault('unsupported_compatibility_parameter'); };
const usage = response => ({
  input_tokens: response.usage?.input_tokens ?? 0,
  output_tokens: response.usage?.output_tokens ?? 0,
});

function chatContent(part, role) {
  if (part?.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: string(part.text) };
  if (part?.type === 'image_url' && role === 'user') {
    const image = part.image_url;
    return { type: 'input_image', image_url: string(image?.url), detail: image?.detail ?? 'auto' };
  }
  return unsupported();
}

function claudeContent(part, role) {
  if (part?.type === 'text') return chatContent(part, role);
  if (part?.type === 'image' && role === 'user') {
    const source = part.source;
    if (source?.type === 'url') return chatContent({ type: 'image_url', image_url: { url: source.url } }, role);
    if (source?.type === 'base64' && /^image\/(?:jpeg|png|gif|webp)$/.test(source.media_type)) {
      return chatContent({ type: 'image_url', image_url: { url: 'data:' + source.media_type + ';base64,' + string(source.data) } }, role);
    }
  }
  return unsupported();
}

function call(id, name, args) {
  return { type: 'function_call', call_id: string(id), name: string(name), arguments: string(args) };
}

function chatInput(messages) {
  return array(messages).flatMap(message => {
    const role = message?.role;
    if (role === 'tool') {
      const output = typeof message.content === 'string' ? message.content :
        array(message.content).map(part => chatContent(part, 'user')).map(part => {
          if (part.type !== 'input_text') return unsupported();
          return part.text;
        }).join('\n');
      return [{ type: 'function_call_output', call_id: string(message.tool_call_id), output }];
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) return unsupported();
    const content = typeof message.content === 'string' ? [chatContent({ type: 'text', text: message.content }, role)] :
      message.content == null && role === 'assistant' ? [] : array(message.content).map(part => chatContent(part, role));
    const calls = message.tool_calls === undefined ? [] : array(message.tool_calls).map(tool => {
      if (role !== 'assistant' || tool?.type !== 'function') return unsupported();
      return call(tool.id, tool.function?.name, tool.function?.arguments);
    });
    if (!content.length && !calls.length) return invalid();
    return [...(content.length ? [{ type: 'message', role, content }] : []), ...calls];
  });
}

function claudeInput(messages) {
  const input = [];
  for (const message of array(messages)) {
    const role = message?.role;
    if (role !== 'assistant' && role !== 'user') return unsupported();
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : array(message.content);
    let content = [];
    const flush = () => { if (content.length) input.push({ type: 'message', role, content }); content = []; };
    for (const part of parts) {
      if (part?.type === 'tool_use' && role === 'assistant') {
        flush();
        if (!object(part.input)) return invalid();
        input.push(call(part.id, part.name, JSON.stringify(part.input)));
      } else if (part?.type === 'tool_result' && role === 'user') {
        flush();
        const result = part.content ?? '';
        const output = typeof result === 'string' ? result : array(result).map(item => claudeContent(item, role));
        input.push({ type: 'function_call_output', call_id: string(part.tool_use_id),
          output: part.is_error && typeof output === 'string' ? 'Tool error: ' + output : output });
      } else {
        content.push(claudeContent(part, role));
      }
    }
    flush();
  }
  return input;
}

function toolsFor(tools, anthropic) {
  return array(tools).map(tool => {
    if (anthropic ? tool?.type !== undefined && tool.type !== 'custom' : tool?.type !== 'function') return unsupported();
    const definition = anthropic ? tool : tool.function;
    const schema = anthropic ? definition?.input_schema : definition?.parameters ?? { type: 'object', properties: {} };
    if (!object(schema) || typeof definition?.name !== 'string') return invalid();
    const result = { type: 'function', name: definition.name, parameters: schema, strict: definition.strict ?? false };
    if (definition.description !== undefined) result.description = string(definition.description);
    return result;
  });
}

export function ignoredOutputLimits(body) {
  const supplied = OUTPUT_LIMIT_FIELDS.filter(field => body[field] != null);
  if (supplied.some(field => !Number.isSafeInteger(body[field]) || body[field] <= 0)) {
    throw fault('invalid_output_limit');
  }
  if (supplied.some(field => body[field] !== body[supplied[0]])) throw fault('output_limit_conflict');
  return supplied;
}

export function compatibilityRequest(body, anthropic) {
  const input = anthropic ? claudeInput(body.messages) : chatInput(body.messages);
  if (!input.length || body.stream !== undefined && typeof body.stream !== 'boolean') return invalid();
  if (anthropic && body.output_config != null && !object(body.output_config)) return invalid();
  if (body.effort != null || body.reasoning != null ||
      (anthropic ? body.reasoning_effort != null : body.output_config?.effort != null)) {
    throw fault('unsupported_reasoning_parameter');
  }
  const effort = anthropic ? body.output_config?.effort : body.reasoning_effort;
  if (effort != null && typeof effort !== 'string') throw fault('effort_not_allowed');
  const request = { input, stream: body.stream === true, store: false, metadata: { skill_store_workload: 'interactive' } };
  if (body.model !== undefined) request.model = body.model;
  if (effort != null) request.reasoning = { effort };
  if (body.tools !== undefined) request.tools = toolsFor(body.tools, anthropic);
  const choice = body.tool_choice;
  if (choice !== undefined) {
    const type = anthropic ? choice?.type : choice;
    if (anthropic ? choice?.type === 'tool' : choice?.type === 'function') {
      request.tool_choice = { type: 'function', name: string(anthropic ? choice.name : choice.function?.name) };
    } else if (typeof type === 'string') {
      if (!['auto', 'none', 'any', 'required'].includes(type)) return unsupported();
      request.tool_choice = type === 'any' ? 'required' : type;
    } else return invalid();
    if (anthropic && choice.disable_parallel_tool_use === true) request.parallel_tool_calls = false;
  }
  if (!anthropic && body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== 'boolean') return invalid();
    request.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (anthropic && body.system !== undefined) {
    request.instructions = typeof body.system === 'string' ? body.system :
      array(body.system).map(part => {
        if (part?.type !== 'text') return unsupported();
        return string(part.text);
      }).join('\n');
  }
  const format = anthropic ? body.output_config?.format : body.response_format;
  if (format !== undefined) {
    if (!object(format)) return invalid();
    if (format.type === 'json_schema') {
      const spec = anthropic ? { name: 'response', schema: format.schema, strict: true } : format.json_schema;
      if (!object(spec?.schema)) return invalid();
      request.text = { format: { type: 'json_schema', name: string(spec.name), schema: spec.schema, strict: spec.strict ?? false } };
    } else if (!anthropic && ['text', 'json_object'].includes(format.type)) {
      request.text = { format: { type: format.type } };
    } else return unsupported();
  }
  if (body.n !== undefined && body.n !== 1 || body.stop?.length || body.stop_sequences?.length ||
      body.logprobs === true || body.audio != null || body.modalities?.some?.(mode => mode !== 'text') ||
      body.container != null || body.mcp_servers?.length || body.thinking != null &&
      !['adaptive', 'disabled'].includes(body.thinking.type)) return unsupported();

  const ignored = ignoredOutputLimits(body);
  for (const field of ['temperature', 'top_p', 'top_k']) {
    if (body[field] == null) continue;
    if (!Number.isFinite(body[field])) return invalid();
    ignored.push(field);
  }
  if (body.thinking != null) ignored.push('thinking');
  if (anthropic && (body.cache_control || body.system?.some?.(part => part?.cache_control) ||
      body.tools?.some?.(tool => tool?.cache_control) || body.messages.some(message =>
        message.content?.some?.(part => part?.cache_control)))) ignored.push('cache_control');
  return { request, ignored, includeUsage: body.stream_options?.include_usage === true };
}

function outputParts(response) {
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const content of item.content ?? []) {
        if (content.type === 'output_text') parts.push({ type: 'text', text: content.text });
        else if (content.type === 'refusal') parts.push({ type: 'refusal', text: content.refusal });
      }
    } else if (item.type === 'function_call') {
      parts.push({ type: 'tool_use', id: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return parts;
}

function toolInput(part) {
  try {
    const input = JSON.parse(part.arguments);
    if (object(input)) return input;
  } catch { /* A tool call must contain a complete JSON object. */ }
  throw fault('invalid_tool_arguments', 502);
}

const finishReason = (response, parts, anthropic) => {
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'content_filter'
      ? (anthropic ? 'refusal' : 'content_filter') : (anthropic ? 'max_tokens' : 'length');
  }
  if (parts.some(part => part.type === 'tool_use')) return anthropic ? 'tool_use' : 'tool_calls';
  if (parts.some(part => part.type === 'refusal')) return anthropic ? 'refusal' : 'stop';
  return anthropic ? 'end_turn' : 'stop';
};
const chatBase = response => ({ id: response.id.replace(/^ss_resp_/, 'chatcmpl-'), created: response.created_at, model: response.model });
const claudeBase = response => ({ id: response.id.replace(/^ss_resp_/, 'msg_'), type: 'message', role: 'assistant', model: response.model });
const chatUsage = response => {
  const { input_tokens, output_tokens } = usage(response);
  return { prompt_tokens: input_tokens, completion_tokens: output_tokens, total_tokens: input_tokens + output_tokens,
    ...(response.usage?.output_tokens_details && { completion_tokens_details: response.usage.output_tokens_details }) };
};
const chatCall = part => ({ id: part.id, type: 'function', function: { name: part.name, arguments: part.arguments } });

export function compatibilityResponse(response, anthropic) {
  const parts = outputParts(response);
  const stop = finishReason(response, parts, anthropic);
  if (anthropic) {
    const content = parts.map(part => part.type === 'tool_use'
      ? { type: 'tool_use', id: part.id, name: part.name, input: toolInput(part) } : { type: 'text', text: part.text });
    return { ...claudeBase(response), content, stop_reason: stop, stop_sequence: null, usage: usage(response) };
  }
  const toolCalls = parts.filter(part => part.type === 'tool_use').map(chatCall);
  const refusal = parts.filter(part => part.type === 'refusal').map(part => part.text).join('');
  const message = { role: 'assistant', content: parts.filter(part => part.type === 'text').map(part => part.text).join('') || null,
    ...(refusal && { refusal }), ...(toolCalls.length && { tool_calls: toolCalls }) };
  return { ...chatBase(response), object: 'chat.completion', choices: [{ index: 0, message, finish_reason: stop }], usage: chatUsage(response) };
}

export function requestErrorMessage(code) {
  return {
    model_not_allowed: 'This model is not supported. See the models endpoint for available IDs and aliases.',
    model_effort_not_verified: 'Verify this model and effort in Responses API before using the combination.',
    proxy_model_not_listed: 'The connected proxy catalog does not list this model for the current account.',
    proxy_catalog_unavailable: 'The embedded proxy catalog is temporarily unavailable or does not match this build.',
    upstream_model_access_denied: 'The inference upstream rejected access to this model.',
    upstream_parameter_unsupported: 'The inference upstream rejected a request parameter.',
    upstream_request_rejected: 'The inference upstream rejected this request.',
    model_verification_unconfirmed: 'The upstream result did not confirm the model and reasoning effort.',
    reported_model_mismatch: 'The upstream reported a different model from the one requested.',
    reported_effort_mismatch: 'The upstream reported a different reasoning effort from the one requested.',
    effort_not_allowed: 'This reasoning effort is not supported by the selected model.',
    default_effort_not_supported: 'The selected model does not support the app default effort. Specify a verified effort for this model.',
    reasoning_effort_conflict: 'The request contains conflicting reasoning effort values.',
    model_alias_effort_conflict: 'The model alias and requested reasoning effort conflict.',
    unsupported_reasoning_parameter: 'Use reasoning.effort for Responses, reasoning_effort for Chat Completions, or output_config.effort for Messages.',
    previous_response_model_changed: 'To switch models, resend compatible conversation history as input and omit previous_response_id.',
    invalid_output_limit: 'The requested output limit must be a positive integer.',
    output_limit_conflict: 'The request contains conflicting output limits.',
    unsupported_compatibility_parameter: 'This request uses a feature that the local compatibility endpoint does not support.',
  }[code] ?? code;
}

export function compatibilityError(code, status, anthropic, requestId) {
  const type = { 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error',
    413: 'request_too_large', 503: 'overloaded_error' }[status] ?? (status >= 500 ? 'api_error' : 'invalid_request_error');
  const message = requestErrorMessage(code);
  return anthropic ? { type: 'error', error: { type, message }, request_id: requestId } :
    { error: { type, code, message, param: null } };
}

export function compatibilityStatus(code) {
  if (/rate_limit|quota_exhausted/.test(code)) return 429;
  if (code === 'model_not_available' || code === 'proxy_model_not_listed') return 404;
  if (code === 'upstream_model_access_denied') return 403;
  if (code === 'upstream_parameter_unsupported' || code === 'upstream_request_rejected') return 400;
  if (code === 'proxy_catalog_unavailable') return 503;
  if (code === 'subscription_connection_required' || code === 'provider_auth_failed') return 503;
  return 502;
}

const frame = (value, type) => (type ? 'event: ' + type + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n';
const claudeFrame = (type, fields) => frame({ type, ...fields }, type);

export function compatibilityStream(initial, anthropic, includeUsage, requestId) {
  let started = false, textOpen = false, textSent = false, block = 0;
  const chat = (delta, finish_reason = null) => frame({ ...chatBase(initial), object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason }], ...(includeUsage && { usage: null }) });
  const start = () => {
    if (started) return [];
    started = true;
    return [anthropic ? claudeFrame('message_start', { message: { ...claudeBase(initial), content: [],
      stop_reason: null, stop_sequence: null, usage: usage(initial) } }) : chat({ role: 'assistant', content: '' })];
  };
  const delta = text => {
    if (!text) return [];
    textSent = true;
    if (!anthropic) return [chat({ content: text })];
    const out = [];
    if (!textOpen) out.push(claudeFrame('content_block_start', { index: block, content_block: { type: 'text', text: '' } }));
    textOpen = true;
    out.push(claudeFrame('content_block_delta', { index: block, delta: { type: 'text_delta', text } }));
    return out;
  };
  const error = code => [frame(compatibilityError(code, compatibilityStatus(code), anthropic, requestId), anthropic ? 'error' : undefined)];
  return {
    event(type, data) {
      if (type === 'response.output_text.delta') return [...start(), ...delta(data.delta)];
      return [];
    },
    finish(response) {
      if (!['completed', 'incomplete'].includes(response.status)) return error(response.error?.code ?? 'provider_generation_failed');
      const parts = outputParts(response);
      const calls = parts.filter(part => part.type === 'tool_use');
      if (anthropic) for (const part of calls) toolInput(part);
      const out = start();
      if (!textSent) out.push(...delta(parts.filter(part => part.type === 'text').map(part => part.text).join('')));
      for (const part of parts.filter(part => part.type === 'refusal')) {
        out.push(...(anthropic ? delta(part.text) : [chat({ refusal: part.text })]));
      }
      const stop = finishReason(response, parts, anthropic);
      if (!anthropic) {
        for (const [index, part] of calls.entries()) out.push(chat({ tool_calls: [{ index, ...chatCall(part) }] }));
        out.push(chat({}, stop));
        if (includeUsage) out.push(frame({ ...chatBase(initial), object: 'chat.completion.chunk', choices: [], usage: chatUsage(response) }));
        out.push('data: [DONE]\n\n');
        return out;
      }
      if (textOpen) out.push(claudeFrame('content_block_stop', { index: block++ }));
      for (const part of calls) {
        out.push(claudeFrame('content_block_start', { index: block, content_block: { type: 'tool_use', id: part.id, name: part.name, input: {} } }),
          claudeFrame('content_block_delta', { index: block, delta: { type: 'input_json_delta', partial_json: part.arguments } }),
          claudeFrame('content_block_stop', { index: block++ }));
      }
      out.push(claudeFrame('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: usage(response) }),
        claudeFrame('message_stop', {}));
      return out;
    },
    error,
  };
}
