import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = resolve(process.env.RESPONSES_TEST_SRC || 'Gateway/src');
const { Store, hash } = await import(pathToFileURL(join(source, 'store.mjs')));
const { Service } = await import(pathToFileURL(join(source, 'service.mjs')));
const { createApiServer } = await import(pathToFileURL(join(source, 'server.mjs')));
const key = 'notification-fixture-key';
const owner = 'notification-fixture-owner';
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const terminal = { id: 'fixture-provider-response', status: 'completed', model: 'gpt-6.1-sol',
  reasoning: { effort: 'low' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] };

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Notification listener did not settle');
}

async function setup(t) {
  const store = new Store();
  const config = { apiKey: key, ownerId: owner, maxBodyBytes: 768 * 1024, maxAttempts: 1 };
  const service = new Service({ store, config, proxy: {}, connections: {} });
  service.closed = true; // This fixture writes durable events without invoking a provider.
  const server = createApiServer(service, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const request = { model: 'gpt-6.1-sol', input: [], reasoning: { effort: 'low' } };
  const { job } = store.create({ owner, key: 'fixture', operationId: 'fixture', request, originalHash: hash(request) });
  const { attemptId } = store.claim();
  const finish = () => {
    store.finish(job.id, attemptId, terminal, 'ok');
    store.event(job.id, 'response.completed', { type: 'response.completed', response: service.response(store.getInternal(job.id)) });
  };
  return { store, service, server, job, request, attemptId, finish, origin };
}

test('synchronous replays ignore deltas and return promptly when an interrupted job recovers', async t => {
  const a = await setup(t);
  const status = a.store.status.bind(a.store);
  let reads = 0;
  a.store.status = id => { reads++; return status(id); };
  const response = fetch(`${a.origin}/v1/responses`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'fixture' },
    body: JSON.stringify(a.request), signal: AbortSignal.timeout(3000),
  });
  await until(() => a.store.changes.listenerCount(a.job.id) === 1);
  for (let i = 0; i < 8; i++) {
    a.store.event(a.job.id, 'response.output_text.delta', { type: 'response.output_text.delta', delta: 'partial' });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(reads, 1);
  a.store.submitted(a.job.id, a.attemptId);
  assert.equal(a.store.recoverExpired(Date.now() + 121000), 1);
  const body = await (await response).json();
  assert.equal(body.status, 'failed');
  assert.equal(body.error.code, 'worker_interrupted');
  assert.equal(reads, 2);
  assert.equal(a.store.changes.listenerCount(a.job.id), 0);
});

test('concurrent SSE subscribers wake on committed events and release listeners on completion or abort', async t => {
  const a = await setup(t);
  const controllers = Array.from({ length: 24 }, () => new AbortController());
  const responses = await Promise.all(controllers.map(controller => fetch(
    `${a.origin}/v1/responses/${a.job.response_id}?stream=true`, { headers, signal: controller.signal })));
  await until(() => a.store.changes.listenerCount(a.job.id) === 24);
  const completed = responses.map((response, index) => response.text().catch(error => {
    assert.ok(index < 12 && error.name === 'AbortError');
    return null;
  }));
  controllers.slice(0, 12).forEach(controller => controller.abort());
  await until(() => a.store.changes.listenerCount(a.job.id) === 12);
  a.store.upstreamId(a.attemptId, terminal.id);
  a.store.event(a.job.id, 'response.output_text.delta', { type: 'response.output_text.delta', delta: 'ok' });
  a.finish();
  const results = await Promise.all(completed);
  for (const text of results.slice(12)) {
    assert.equal((text.match(/^event: response.completed$/gm) || []).length, 1);
    assert.ok(text.includes('response.output_text.delta'));
  }
  await until(() => a.store.changes.listenerCount(a.job.id) === 0);
  const stored = a.store.getInternal(a.job.id);
  assert.deepEqual(JSON.parse(stored.terminal_json), terminal);
  const retrieved = await fetch(`${a.origin}/v1/responses/${a.job.response_id}`, { headers });
  const body = await retrieved.json();
  assert.deepEqual(body, a.service.response(stored));
  assert.equal(body.skill_store.forwarded_effort, 'low');
  assert.ok(body.skill_store.local_timing.first_text_at);
});

test('terminal event at an exact 500-event page boundary is sent once, including resumed streams', async t => {
  const a = await setup(t);
  for (let i = 0; i < 496; i++) {
    a.store.event(a.job.id, 'response.output_text.delta', { type: 'response.output_text.delta', delta: 'x' });
  }
  a.finish();
  assert.equal(a.store.events(owner, a.job.id).length, 500);
  const response = await fetch(`${a.origin}/v1/responses/${a.job.response_id}?stream=true`, { headers });
  const text = await response.text();
  assert.equal((text.match(/^event: response.completed$/gm) || []).length, 1);
  assert.equal((text.match(/^event: response.output_text.delta$/gm) || []).length, 496);
  const last = a.store.events(owner, a.job.id).at(-1).id;
  const resumed = await fetch(`${a.origin}/v1/responses/${a.job.response_id}?stream=true&starting_after=${last}`, { headers });
  assert.equal(((await resumed.text()).match(/^event: response.completed$/gm) || []).length, 1);
  assert.equal(a.store.changes.listenerCount(a.job.id), 0);
});

test('shared stream pages preserve job isolation, event order and rollback boundaries', async t => {
  const a = await setup(t);
  const request = { model: 'gpt-6.1-sol', input: [], reasoning: { effort: 'low' } };
  const { job: second } = a.store.create({ owner, key: 'second', operationId: 'second', request,
    originalHash: hash(request), metadata: { workload: 'interactive' } });
  const claimed = a.store.claim(Date.now(), 120000, { maxConcurrent: 2 });
  assert.equal(claimed.job.id, second.id);
  const jobs = [a.job, second];
  const clients = await Promise.all(jobs.flatMap(job => Array.from({ length: 12 }, async () => {
    const response = await fetch(`${a.origin}/v1/responses/${job.response_id}?stream=true`, { headers });
    return { job, text: response.text() };
  })));
  assert.throws(() => a.store.transaction(() => {
    a.store.event(a.job.id, 'response.output_text.delta', { type: 'response.output_text.delta', delta: 'rolled-back' });
    throw Error('fixture rollback');
  }), /fixture rollback/);
  for (let i = 0; i < 24; i++) {
    for (const job of jobs) {
      a.store.event(job.id, 'response.output_text.delta', {
        type: 'response.output_text.delta', delta: `${job.id}:${i}`, sequence_number: 'must-be-overridden',
      });
      await Promise.resolve();
    }
    if (i % 3 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  a.finish();
  a.store.finish(second.id, claimed.attemptId, terminal, 'ok');
  a.store.event(second.id, 'response.completed', { type: 'response.completed', response: a.service.response(a.store.getInternal(second.id)) });
  for (const client of clients) {
    const text = await client.text;
    const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta),
      Array.from({ length: 24 }, (_, i) => `${client.job.id}:${i}`));
    const numbered = events.map(event => event.sequence_number);
    assert.ok(numbered.every(Number.isSafeInteger));
    assert.ok(numbered.every((id, i) => i === 0 || id > numbered[i - 1]));
    assert.equal(events.filter(event => event.type === 'response.completed').length, 1);
    assert.equal(events.find(event => event.type === 'response.created').response.id, client.job.response_id);
  }
  await until(() => a.store.changes.eventNames().length === 0);
});

test('slow clients can abort during backpressure without retaining job subscriptions', async t => {
  const a = await setup(t);
  for (let i = 0; i < 80; i++) {
    a.store.event(a.job.id, 'response.output_text.delta', { type: 'response.output_text.delta', delta: 'x'.repeat(32768) });
  }
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const request = http.get(`${a.origin}/v1/responses/${a.job.response_id}?stream=true`, { headers }, response => {
      response.pause();
      setTimeout(() => { request.destroy(); resolve(); }, 30);
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  })));
  await until(() => a.store.changes.listenerCount(a.job.id) === 0);
  a.finish();
  assert.equal(a.store.get(owner, a.job.id).execution_status, 'completed');
});

test('existing databases reopen without altering saved responses or owner isolation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'legacy.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, kind TEXT NOT NULL, request_json TEXT NOT NULL, changes_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL, execution_status TEXT NOT NULL, save_status TEXT NOT NULL,
    response_id TEXT NOT NULL UNIQUE, response_json TEXT, output_text TEXT, reported_model TEXT, error_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, ready_at INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(owner_id,idempotency_key), UNIQUE(owner_id,operation_id)
  ); CREATE TABLE attempts (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL, upstream_id TEXT, request_hash TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, error_code TEXT
  );`);
  const request = { model: 'gpt-6.1-sol', input: [], reasoning: { effort: 'low' } };
  const id = 'legacy-job', responseId = 'ss_resp_legacy', timestamp = new Date(0).toISOString();
  old.prepare(`INSERT INTO jobs
    (id,owner_id,idempotency_key,operation_id,request_hash,kind,request_json,changes_json,metadata_json,
     execution_status,save_status,response_id,response_json,output_text,reported_model,attempt_count,created_at,updated_at)
    VALUES (?,?,'legacy','legacy',?,'response',?,'[]','{}','completed','local_saved',?,?,'ok',?,1,?,?)`)
    .run(id, owner, hash(request), JSON.stringify(request), responseId, JSON.stringify(terminal),
      terminal.model, timestamp, timestamp);
  old.prepare("INSERT INTO attempts (id,job_id,state,upstream_id,request_hash,started_at,ended_at) VALUES ('legacy-attempt',?,'completed',?,?,?,?)")
    .run(id, terminal.id, hash(request), timestamp, timestamp);
  old.close();
  const updated = new Store(file);
  t.after(() => updated.close());
  const migrated = updated.get(owner, responseId);
  assert.deepEqual(migrated.request, request);
  assert.deepEqual(migrated.response, terminal);
  assert.equal(migrated.terminal_json, null);
  assert.equal(migrated.original_json, null);
  assert.equal(updated.db.prepare('SELECT submitted FROM attempts WHERE job_id=?').get(id).submitted, 0);
  assert.throws(() => updated.get('different-owner', responseId), /job_not_found/);
  assert.equal(updated.getResponse(owner, responseId).output_text, 'ok');
  assert.throws(() => updated.getResponse('different-owner', responseId), /job_not_found/);
  assert.equal(updated.existing(owner, 'legacy', 'legacy').id, id);
  assert.equal(updated.claim(), null);
});
