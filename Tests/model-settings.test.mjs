import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const source = resolve(process.env.RESPONSES_TEST_SRC || 'Gateway/src');
const { Store, hash } = await import(pathToFileURL(join(source, 'store.mjs')));
const { Service } = await import(pathToFileURL(join(source, 'service.mjs')));
const { createApiServer } = await import(pathToFileURL(join(source, 'server.mjs')));
const { CATALOG, isSelectableModelId } = await import(pathToFileURL(join(source, 'model-settings.mjs')));
const sol = 'gpt-6.1-sol';
const terra = 'gpt-6.1-terra';

const registryIds = Object.keys(CATALOG);
async function setup(t, getReadiness = async () => ({ ready: true, modelIds: registryIds }), { bootstrap = true, upstream = () => 'accept' } = {}) {
  const store = new Store();
  const config = { ownerId: 'fixture', apiKey: 'public-key', proxyKey: 'private-key', modelScope: 'first-account',
    maxBodyBytes: 4096, maxAttempts: 1, maxConcurrent: 2, testMode: true };
  const forwarded = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const proxy = {
    getReadiness,
    async *run(request) {
      forwarded.push(request);
      const verdict = upstream(request);
      if (verdict === 'reject') {
        yield { type: 'error', error: { code: 'model_not_supported' } };
        return;
      }
      if (request.input[0].content[0].text === 'limit') throw Object.assign(Error('fixture rate limit'), { code: 'upstream_rate_limited' });
      if (request.input[0].content[0].text === 'hold') await held;
      const output = [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }];
      if (request.tools?.length) {
        output.push({ type: 'function_call', call_id: 'call_fixture', name: request.tools[0].name, arguments: '{"value":1}' });
      }
      yield { type: 'response.output_text.delta', delta: 'OK' };
      yield { type: 'response.completed', response: { id: 'fixture-upstream', status: 'completed',
        model: request.model, reasoning: verdict === 'unconfirmed' ? {} : request.reasoning,
        output, usage: { input_tokens: 6, output_tokens: 2 } } };
    },
  };
  const service = new Service({ store, config, proxy, connections: { async current() { return { connected: true }; } } });
  const server = createApiServer(service, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, privateAccess = false, key, headers = {}) {
    const requestHeaders = { authorization: 'Bearer ' + (privateAccess ? config.proxyKey : config.apiKey),
      'content-type': 'application/json', ...(key && { 'idempotency-key': key }), ...headers };
    if (requestHeaders.authorization === null) delete requestHeaders.authorization;
    const response = await fetch(base + path, { headers: requestHeaders,
    ...(body && { method: 'POST', body: JSON.stringify(body) }) });
    const data = response.headers.get('content-type').startsWith('text/event-stream') ? await response.text() : await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  async function until(check) {
    for (let i = 0; i < 150; i++) { const result = await check(); if (result) return result; await delay(10); }
    assert.fail('Fixture did not settle');
  }
  const models = '/__desktop/model-settings';
  const select = (action, model, effort) => request(models, { action, model, effort }, true);
  async function verify(model, effort) {
    assert.equal((await select('test', model, effort)).status, 200);
    await until(async () => !(await request(models, null, true)).data.testing);
    const options = (await request(models, null, true)).data.models;
    assert.equal(options.find(item => item.id === model).efforts.find(item => item.id === effort).verified, true);
  }
  if (bootstrap) await verify(sol, 'low');
  return { request, models, select, verify, forwarded, config, store, release, until };
}

test('the catalog admits GPT-6 and future numbered models while excluding earlier generations', () => {
  assert.ok(Object.hasOwn(CATALOG, 'gpt-6-sol'));
  assert.ok(Object.keys(CATALOG).every(isSelectableModelId));
  for (const id of ['gpt-6', 'gpt-6.1-sol', 'gpt-7', 'gpt-7.2-test', 'gpt-10.1-test']) assert.equal(isSelectableModelId(id), true);
  for (const id of ['gpt-4o', 'gpt-5', 'gpt-5.6-sol', 'other-7', 'gpt-6-sol(high)']) assert.equal(isSelectableModelId(id), false);
});

test('private verification gates model selection and keeps explicit requests and replays stable', async t => {
  const a = await setup(t);
  const body = { model: 'local-default', input: 'fixture' };
  assert.equal((await a.request(a.models, { action: 'test', model: sol, effort: 'high' })).status, 401);
  assert.equal((await a.select('apply', sol, 'high')).data.error.code, 'model_effort_not_verified');
  assert.equal((await a.request('/v1/responses', { ...body, reasoning: { effort: 'none' } })).data.error.code, 'effort_not_allowed');
  const first = (await a.request('/v1/responses', body, false, 'stable-request')).data;
  assert.equal(first.skill_store.forwarded_effort, 'low');
  await a.verify(sol, 'high');
  await a.verify(terra, 'low');
  assert.equal((await a.select('apply', terra, 'low')).status, 200);
  const changed = (await a.request('/v1/responses', body)).data;
  assert.equal(changed.skill_store.forwarded_model, terra);
  const explicit = (await a.request('/v1/responses', { ...body, model: sol, reasoning: { effort: 'high' } })).data;
  assert.equal(explicit.skill_store.reported_effort, 'high');
  assert.equal((await a.request('/v1/responses', body, false, 'stable-request')).data.id, first.id);
  const needsHistory = await a.request('/v1/responses', { ...body, previous_response_id: first.id });
  assert.equal(needsHistory.status, 409);
  assert.match(needsHistory.data.error.message, /resend compatible conversation history/);
  const continued = (await a.request('/v1/responses', { ...body, model: sol, previous_response_id: first.id })).data;
  assert.equal(continued.skill_store.forwarded_model, sol);
  const listed = (await a.request('/v1/models')).data.data;
  assert.deepEqual(listed.find(item => item.id === sol).reasoning.supported_efforts, ['low', 'high']);
  assert.ok(listed.some(item => item.id === terra));
  a.config.modelScope = 'second-account';
  assert.equal((await a.select('apply', terra, 'low')).data.error.code, 'model_effort_not_verified');
  assert.deepEqual((await a.request(a.models, null, true)).data.selection, { model: sol, effort: 'low' });
});

test('a queued job keeps its resolved selection after defaults change', async t => {
  const a = await setup(t);
  await a.request('/v1/responses', { input: 'hold', background: true });
  await a.until(() => a.forwarded.some(request => request.input[0].content[0].text === 'hold'));
  await a.verify(sol, 'medium');
  const queued = (await a.request('/v1/responses', { model: 'local-default', input: 'queued', background: true })).data;
  assert.equal(queued.status, 'queued');
  assert.equal((await a.select('apply', sol, 'medium')).status, 200);
  a.release();
  const completed = await a.until(async () => {
    const response = (await a.request('/v1/responses/' + queued.id)).data;
    return response.status === 'completed' && response;
  });
  assert.equal(completed.skill_store.forwarded_effort, 'low');
  assert.equal((await a.request('/v1/responses', { input: 'next' })).data.skill_store.forwarded_effort, 'medium');
});

test('an unavailable probe and a failed store=false request both leave the service running', async t => {
  const a = await setup(t, async ({ model } = {}) =>
    ({ ready: model !== terra, modelIds: registryIds.filter(id => id !== terra) }));
  assert.equal((await a.request('/v1/responses', { input: 'fixture', model: terra })).data.error.code, 'proxy_model_not_listed');
  assert.equal((await a.select('test', terra, 'low')).status, 200);
  await a.until(async () => !(await a.request(a.models, null, true)).data.testing);
  const options = (await a.request(a.models, null, true)).data.models;
  const result = options.find(model => model.id === terra).efforts.find(effort => effort.id === 'low');
  assert.equal(result.code, 'proxy_model_not_listed');
  assert.equal(result.verified, false);
  const failed = (await a.request('/v1/responses', { input: 'limit', store: false })).data;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'upstream_rate_limited');
  assert.equal((await a.request('/v1/responses/' + failed.id)).status, 200);
  assert.equal((await a.request('/v1/responses', { input: 'next' })).data.status, 'completed');
});

test('cold defaults, missing confirmations and explicit upstream rejections stay out of client lists', async t => {
  let verdict = 'accept';
  const a = await setup(t, undefined, { bootstrap: false, upstream: () => verdict });
  const list = async () => (await a.request('/v1/models')).data.data.map(item => item.id);
  assert.deepEqual(await list(), []);
  assert.equal((await a.request('/v1/responses', { input: 'fixture' })).data.error.code, 'model_effort_not_verified');
  await a.verify(sol, 'low');
  assert.equal((await list())[0], 'local-default');
  const probeCode = async () => {
    assert.equal((await a.select('test', sol, 'low')).status, 200);
    await a.until(async () => !(await a.request(a.models, null, true)).data.testing);
    return (await a.request(a.models, null, true)).data.models.find(entry => entry.id === sol).efforts[0].code;
  };
  verdict = 'unconfirmed';
  assert.equal(await probeCode(), 'model_verification_unconfirmed');
  const unconfirmed = await a.request('/v1/responses', { input: 'fixture' });
  assert.equal(unconfirmed.status, 502);
  assert.equal(unconfirmed.data.error.code, 'model_verification_unconfirmed');
  assert.deepEqual(await list(), []);
  verdict = 'reject';
  assert.equal(await probeCode(), 'upstream_model_access_denied');
  const rejected = await a.request('/v1/responses', { model: 'local-gpt-6.1-sol--low', input: 'fixture' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.data.error.code, 'upstream_model_access_denied');
  assert.deepEqual(await list(), []);
  verdict = 'accept';
  await a.verify(sol, 'low');
  assert.ok((await list()).includes('local-gpt-6.1-sol--low'));
});

const chat = '/v1/chat/completions';
const messagesPath = '/anthropic/v1/messages';
const messages = [{ role: 'user', content: 'fixture' }];
const pair = result => [result.headers.get('x-responses-model'), result.headers.get('x-responses-reasoning-effort')];

test('compatibility requests resolve each missing field against the app defaults and keep calls isolated', async t => {
  const a = await setup(t);
  await a.verify(sol, 'high');
  await a.verify(terra, 'high');
  await a.verify(terra, 'low');
  await a.select('apply', sol, 'high');
  const [defaults, modelOnly, effortOnly, both] = await Promise.all([
    a.request(chat, { messages }),
    a.request(messagesPath, { messages, model: terra, max_tokens: 256 }),
    a.request(chat, { messages, reasoning_effort: 'low' }),
    a.request(messagesPath, { messages, model: terra, output_config: { effort: 'low' }, max_tokens: 256 }),
  ]);
  assert.deepEqual([defaults, modelOnly, effortOnly, both].map(result => result.status), [200, 200, 200, 200]);
  assert.deepEqual([defaults, modelOnly, effortOnly, both].map(pair), [[sol, 'high'], [terra, 'high'], [sol, 'low'], [terra, 'low']]);
  assert.equal(both.headers.get('x-responses-unsupported-parameters'), 'max_tokens');
  assert.equal(defaults.data.choices[0].message.content, 'OK');
  assert.deepEqual(both.data.content, [{ type: 'text', text: 'OK' }]);
  assert.deepEqual(pair(await a.request(chat, { messages, model: 'local-default' })), [sol, 'high']);
  const native = { input: 'fixture', model: terra };
  const selected = await a.request('/v1/responses', native, false, 'native');
  assert.deepEqual(pair(selected), [terra, 'high']);
  const olderHash = hash({ mode: 'responses-app-defaults', body: native });
  a.store.prepare('UPDATE jobs SET request_hash=? WHERE response_id=?').run(olderHash, selected.data.id);
  assert.equal((await a.request('/v1/responses', native, false, 'native')).data.id, selected.data.id);
  assert.equal((await a.request('/v1/responses', native, false, 'native', { 'x-responses-defaults': 'app' })).data.id, selected.data.id);
  assert.equal((await a.request('/v1/responses', { ...native, input: 'changed' }, false, 'native')).status, 409);
  const unverified = await a.request(messagesPath, { messages, model: terra, output_config: { effort: 'medium' } });
  assert.equal(unverified.status, 400);
  assert.equal(unverified.data.error.type, 'invalid_request_error');
  assert.match(unverified.data.error.message, /Verify/);
  assert.equal((await a.request(chat, { messages, model: 'gpt-5' })).status, 400);
});

test('continuations use current effort and stateless history allows an explicit model switch', async t => {
  const a = await setup(t);
  await a.verify(sol, 'high');
  await a.verify(terra, 'low');
  const user = { role: 'user', content: [{ type: 'input_text', text: 'fixture' }] };
  const first = await a.request('/v1/responses', { input: [user,
    { type: 'configuration_update', reasoning: { effort: 'high' } }], reasoning: { effort: 'high' } });
  assert.deepEqual(pair(first), [sol, 'high']);
  const same = await a.request('/v1/responses', { previous_response_id: first.data.id, input: 'fixture' });
  assert.deepEqual(pair(same), [sol, 'low']);
  assert.equal(a.forwarded.at(-1).input[1].reasoning.effort, 'low');
  const pointer = await a.request('/v1/responses', { previous_response_id: first.data.id, input: 'fixture', model: terra });
  assert.equal(pointer.status, 409);
  const switched = await a.request(chat, { messages: [...messages, { role: 'assistant', content: 'OK' },
    { role: 'user', content: 'fixture follow-up' }], model: terra });
  assert.deepEqual(pair(switched), [terra, 'low']);
  assert.deepEqual(a.forwarded.at(-1).input.map(item => item.role), ['user', 'assistant', 'user']);
});

test('unsupported, unverified and conflicting settings fail with actionable errors', async t => {
  const a = await setup(t);
  const conflicting = await a.request('/v1/responses', {
    input: 'fixture', reasoning: { effort: 'low' }, reasoning_effort: 'high',
  });
  assert.equal(conflicting.status, 400);
  assert.equal(conflicting.data.error.code, 'reasoning_effort_conflict');
  const wrongField = await a.request(chat, { messages, reasoning: { effort: 'high' } });
  assert.equal(wrongField.data.error.code, 'unsupported_reasoning_parameter');
  const unsupported = await a.request('/v1/responses', { input: 'fixture', reasoning: { effort: 'none' } });
  assert.equal(unsupported.data.error.code, 'effort_not_allowed');
  const conflict = await a.request(chat, { messages, max_tokens: 10, max_completion_tokens: 20 });
  assert.equal(conflict.data.error.code, 'output_limit_conflict');
  const ignored = await a.request('/v1/responses', { input: 'fixture', max_output_tokens: 16 });
  assert.equal(ignored.headers.get('x-responses-unsupported-parameters'), 'max_output_tokens');
  assert.equal(a.forwarded.at(-1).max_output_tokens, undefined);
});

test('both compatible model lists expose verified aliases and preserve independent authentication', async t => {
  const a = await setup(t);
  await a.verify(sol, 'high');
  const alias = 'local-gpt-6.1-sol--high';
  const openai = await a.request('/v1/models');
  const anthropic = await a.request('/anthropic/v1/models', null, false, null,
    { authorization: null, 'x-api-key': a.config.apiKey });
  assert.ok(openai.data.data.some(model => model.id === alias));
  assert.equal(openai.data.data[0].id, 'local-default');
  assert.equal(anthropic.data.first_id, 'local-default');
  assert.ok(anthropic.data.data.some(model => model.id === alias && model.type === 'model'));
  assert.equal((await a.request('/anthropic/v1/models', null, true)).status, 401);
  assert.equal((await a.request(messagesPath, { messages }, false, null, { 'x-api-key': 'wrong' })).status, 401);
  const valid = await a.request(messagesPath, { messages, model: alias });
  assert.deepEqual(pair(valid), [sol, 'high']);
  const conflict = await a.request(chat, { messages, model: alias, reasoning_effort: 'low' });
  assert.equal(conflict.data.error.code, 'model_alias_effort_conflict');
});

test('compatible streaming emits text, tool calls, usage and protocol-specific errors', async t => {
  const a = await setup(t);
  const tool = { name: 'fixture_tool', input_schema: { type: 'object', properties: { value: { type: 'number' } } } };
  const anthropic = await a.request(messagesPath, { messages, tools: [tool],
    tool_choice: { type: 'tool', name: tool.name, disable_parallel_tool_use: true }, stream: true });
  const events = anthropic.data.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[2].delta.text, 'OK');
  assert.equal(events[4].content_block.id, 'call_fixture');
  assert.deepEqual(JSON.parse(events[5].delta.partial_json), { value: 1 });
  assert.equal(events[7].delta.stop_reason, 'tool_use');
  assert.deepEqual(a.forwarded.at(-1).tool_choice, { type: 'function', name: tool.name });
  assert.equal(a.forwarded.at(-1).parallel_tool_calls, false);
  const continuation = await a.request(messagesPath, { messages: [...messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_fixture', name: tool.name, input: { value: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'done' }] }] });
  assert.equal(continuation.status, 200);
  assert.deepEqual(a.forwarded.at(-1).input.at(-1), { type: 'function_call_output', call_id: 'call_fixture', output: 'done' });
  const openai = await a.request(chat, { messages, stream: true, stream_options: { include_usage: true },
    tools: [{ type: 'function', function: { name: tool.name, parameters: tool.input_schema } }] });
  assert.match(openai.data, /"finish_reason":"tool_calls"/);
  assert.match(openai.data, /"completion_tokens":2/);
  assert.match(openai.data, /data: \[DONE\]\n\n$/);
  const limited = [{ role: 'user', content: 'limit' }];
  assert.equal((await a.request(chat, { messages: limited })).status, 429);
  assert.match((await a.request(messagesPath, { messages: limited, stream: true })).data, /event: error\n.*rate_limit_error/);
});
