import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const key = 'benchmark-fixture-key';
const owner = 'benchmark-owner';
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

if (process.argv[2] === '--worker') {
  const source = resolve(process.argv[3]);
  const { Store } = await import(pathToFileURL(join(source, 'store.mjs')));
  const { Service } = await import(pathToFileURL(join(source, 'service.mjs')));
  const { createApiServer } = await import(pathToFileURL(join(source, 'server.mjs')));
  const { ConnectionManager } = await import(pathToFileURL(join(source, 'connections.mjs')));
  const store = new Store(join(process.argv[4], 'benchmark.sqlite'));
  const authDir = join(process.argv[4], 'fixture-auth');
  const ownerHash = createHash('sha256').update(owner).digest('hex');
  await mkdir(authDir, { mode: 0o700 });
  await Promise.all([
    writeFile(join(authDir, '.service-owner.meta'), JSON.stringify({ ownerHash }), { mode: 0o600 }),
    writeFile(join(authDir, '.connection-state.meta'), JSON.stringify({
      ownerHash, state: 'connected', connectionId: 'benchmark-connection', revision: 0,
    }), { mode: 0o600 }),
    writeFile(join(authDir, `codex-service-${ownerHash.slice(0, 32)}.json`), '{}', { mode: 0o600 }),
  ]);
  const seed = store.db.prepare(`INSERT INTO jobs
    (id,owner_id,idempotency_key,operation_id,request_hash,kind,request_json,changes_json,
    metadata_json,execution_status,save_status,response_id,created_at,updated_at,original_json,terminal_json)
    VALUES(?,?,?,?,?,'response',?,'[]','{}','completed','local_saved',?,?,?,?,?)`);
  store.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      seed.run(`history-${i}`, owner, `history-${i}`, `history-${i}`, 'fixture-hash',
        JSON.stringify({ model: 'gpt-6.1-sol', input: 'x'.repeat(1024) }),
        `ss_resp_history${i}`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null, null);
    }
    const original = JSON.stringify({ input: 'x'.repeat(128 * 1024) });
    const response = JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'saved' }] }] });
    store.db.prepare("UPDATE jobs SET original_json=?,terminal_json=?,response_json=?,output_text='saved' WHERE id='history-0'")
      .run(original, response, response);
  });
  let held = false;
  let release;
  let prepared = 0;
  let executed = 0;
  let statusQueries = 0;
  let emptyClaims = 0;
  const claim = store.claim.bind(store);
  store.claim = (...args) => {
    const result = claim(...args);
    if (!result) emptyClaims++;
    return result;
  };
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    prepared++;
    const statement = prepare(sql);
    for (const method of ['get', 'all', 'run']) {
      const execute = statement[method].bind(statement);
      statement[method] = (...parameters) => {
        executed++;
        if (sql === 'SELECT execution_status FROM jobs WHERE id=?') statusQueries++;
        return execute(...parameters);
      };
    }
    return statement;
  };
  const proxy = {
    async getReadiness() { return { ready: true, modelIds: ['gpt-6.1-sol'] }; },
    async *run(request, { signal }) {
      if (held) await Promise.race([
        new Promise(resolve => { release = resolve; }),
        new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      const input = request.input[0]?.content[0]?.text;
      if (input === 'fanout' || input === 'fanout-burst') {
        for (let i = 0; i < 120; i++) {
          if (input === 'fanout') await delay(2);
          yield { type: 'response.output_text.delta', delta: `${Date.now()}|${'x'.repeat(256)}` };
        }
      } else if (input?.startsWith('compatibility fixture')) {
        for (let i = 0; i < 16; i++) yield { type: 'response.output_text.delta', delta: 'x'.repeat(256) };
        yield { type: 'response.completed', response: {
          id: 'fixture-provider-response', status: 'completed', model: request.model, reasoning: request.reasoning,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(4096) }] }],
          usage: { input_tokens: 100, output_tokens: 512, total_tokens: 612 },
        } };
        return;
      } else {
        await delay(7);
        yield { type: 'response.output_text.delta', delta: String(Date.now()) };
      }
      await delay(7);
      yield { type: 'response.completed', response: {
        id: 'fixture-provider-response', status: 'completed', model: 'gpt-6.1-sol',
        reasoning: { effort: 'low' }, output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'benchmark completed' }] }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      } };
    },
  };
  const config = { apiKey: key, ownerId: owner, maxBodyBytes: 768 * 1024,
    maxAttempts: 1, maxConcurrent: 2, testMode: true };
  const service = new Service({ store, proxy, connections: new ConnectionManager({ authDir }), config });
  const defaultPair = { model: 'gpt-6.1-sol', effort: 'low' };
  const scope = service.modelScope?.(owner);
  const defaultVerified = () => service.models.status(owner, scope, [defaultPair.model]).models
    .find(entry => entry.id === defaultPair.model).efforts.find(entry => entry.id === defaultPair.effort).verified;
  if (service.models && !defaultVerified()) {
    await service.changeModel(owner, { action: 'test', ...defaultPair });
    for (let attempt = 0; attempt < 100 && !defaultVerified(); attempt++) await delay(10);
    assert.equal(defaultVerified(), true);
  }
  const server = createApiServer(service, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ ready: true, origin: `http://127.0.0.1:${server.address().port}` });
  process.on('message', async message => {
    if (message.command === 'hold') held = true;
    if (message.command === 'release') { held = false; release?.(); }
    if (message.command === 'sample') {
      process.send({ serial: message.serial, cpu: process.cpuUsage(),
        rss: process.memoryUsage().rss, prepared, executed, statusQueries, emptyClaims });
    } else if (message.command === 'close') {
      await service.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      store.close();
      process.disconnect();
    } else {
      process.send({ serial: message.serial });
    }
  });
} else {
  const source = resolve(process.argv[2]);
  const output = process.argv[3];
  const directory = await mkdtemp(join(tmpdir(), 'responses-performance-'));
  const worker = fork(import.meta.filename, ['--worker', source, directory], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const ready = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => reject(Error(`Worker exited ${code}`)));
  });
  let serial = 0;
  function command(command) {
    const id = ++serial;
    return new Promise(resolve => {
      const receive = message => {
        if (message.serial !== id) return;
        worker.off('message', receive);
        resolve(message);
      };
      worker.on('message', receive);
      worker.send({ command, serial: id });
    });
  }
  const request = (path, body) => fetch(ready.origin + path, {
    headers, ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const statistics = values => ({ median: percentile(values, 0.5), p95: percentile(values, 0.95) });
  const cpuMs = (a, b) => (b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / 1000;
  async function measureRequests(count, concurrency, task) {
    let next = 0;
    const latencies = [];
    const before = await command('sample');
    const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const index = next++;
        const sent = performance.now();
        await task(index);
        latencies.push(performance.now() - sent);
      }
    }));
    const duration = performance.now() - start;
    const after = await command('sample');
    return { requests_per_second: count / duration * 1000, latency_ms: statistics(latencies),
      server_cpu_ms: cpuMs(before, after), rss_mib: after.rss / 1024 / 1024,
      sqlite_executions: after.executed - before.executed, job_status_queries: after.statusQueries - before.statusQueries,
      empty_claims: after.emptyClaims - before.emptyClaims };
  }
  async function consume(response, deltas = []) {
    assert.equal(response.status, 200);
    const decoder = new TextDecoder();
    let buffer = '', terminal;
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const raw = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
        if (!raw) continue;
        const event = JSON.parse(raw);
        if (event.type === 'response.output_text.delta') deltas.push(Date.now() - Number(event.delta.split('|', 1)[0]));
        if (event.type === 'response.completed') terminal = event.response;
      }
    }
    assert.equal(terminal?.status, 'completed');
    return terminal;
  }
  async function measureFanout(input) {
    await command('hold');
    const job = await (await request('/v1/responses', { input, background: true })).json();
    const streams = await Promise.all(Array.from({ length: 100 }, () => request('/v1/responses/' + job.id + '?stream=true')));
    const deltas = [];
    const finished = Promise.all(streams.map(response => consume(response, deltas)));
    const before = await command('sample');
    const start = performance.now();
    await command('release');
    await finished;
    const duration = performance.now() - start;
    const after = await command('sample');
    assert.equal(deltas.length, 12000);
    return { delivered_deltas_per_second: deltas.length / duration * 1000,
      delta_delivery_ms: statistics(deltas), server_cpu_ms: cpuMs(before, after),
      sqlite_executions: after.executed - before.executed, rss_mib: after.rss / 1024 / 1024 };
  }
  try {
    const deltaDelivery = [], completionDelivery = [], synchronousDelivery = [];
    let final;
    // Warm up HTTP connections and SQLite before collecting timings.
    await consume(await request('/v1/responses', { input: 'warmup', stream: true }));
    for (let i = 0; i < 30; i++) {
      final = await consume(await request('/v1/responses', { input: 'latency', stream: true }), deltaDelivery);
      completionDelivery.push(Date.now() - Date.parse(final.skill_store.local_timing.finished_at));
      const result = await (await request('/v1/responses', { input: 'synchronous' })).json();
      assert.equal(result.status, 'completed');
      synchronousDelivery.push(Date.now() - Date.parse(result.skill_store.local_timing.finished_at));
    }
    // Warm the read endpoint separately; short runs otherwise mostly measure
    // compilation and CPU frequency changes left by the preceding SSE phase.
    const count = 6000;
    const responseRead = async () => {
      const result = await (await request('/v1/responses/' + final.id)).json();
      assert.equal(result.status, 'completed');
    };
    await measureRequests(640, 16, responseRead);
    const responseReads = await measureRequests(count, 16, responseRead);
    await command('hold');
    const heldJob = await (await request('/v1/responses', { input: 'held', background: true })).json();
    const streams = await Promise.all(Array.from({ length: 100 }, () => request('/v1/responses/' + heldJob.id + '?stream=true')));
    const finished = Promise.all(streams.map(response => consume(response)));
    await delay(250);
    const fanoutBefore = await command('sample');
    const idleStart = performance.now();
    await delay(2500);
    const idleDuration = performance.now() - idleStart;
    const fanoutAfter = await command('sample');
    await command('release');
    await finished;

    const active = await measureFanout('fanout');
    const burst = await measureFanout('fanout-burst');

    const historical = '/v1/responses/ss_resp_history0';
    const savedRead = async () => {
      const response = await request(historical);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).output_text, 'saved');
    };
    await measureRequests(320, 16, savedRead);
    const largeAuditReads = await measureRequests(6000, 16, savedRead);

    const messages = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: 'compatibility fixture ' + 'x'.repeat(1500),
    }));
    const mixedGeneration = async index => {
      const anthropic = index % 2 === 1;
      const path = anthropic ? '/anthropic/v1/messages' : '/v1/chat/completions';
      const streaming = index % 4 >= 2;
      const response = await request(path, { messages, model: 'local-default', stream: streaming,
        ...(anthropic ? { max_tokens: 1024, output_config: { effort: 'low' } } : { reasoning_effort: 'low' }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-responses-reasoning-effort'), 'low');
      if (streaming) {
        const text = await response.text();
        assert.ok(text.includes(anthropic ? 'event: message_stop' : 'data: [DONE]'));
      } else {
        const result = await response.json();
        assert.equal((anthropic ? result.content[0].text : result.choices[0].message.content).length, 4096);
      }
    };
    await measureRequests(24, 8, mixedGeneration);
    const compatibility = await measureRequests(200, 8, mixedGeneration);

    // Hold the provider so this phase measures local request admission and queueing.
    await command('hold');
    const admissionCount = 1200;
    const admission = await measureRequests(admissionCount, 8, async () => {
      const response = await request('/v1/responses', { input: 'admission', background: true });
      assert.equal(response.status, 200);
      assert.ok(['queued', 'in_progress'].includes((await response.json()).status));
    });
    const result = {
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      fixture: { history_jobs: 5000, repeated_generations: 30, read_requests: count, read_concurrency: 16,
        read_warmup_requests: 640, simultaneous_sse_subscribers: 100,
        active_delta_events: 120, queued_requests: admissionCount, admission_concurrency: 8,
        large_audit_reads: 6000, large_audit_original_bytes: 128 * 1024,
        compatibility_requests: 200, compatibility_concurrency: 8, local_connection_checks: true },
      sse_delta_delivery_ms: statistics(deltaDelivery),
      sse_completion_delivery_ms: statistics(completionDelivery),
      synchronous_completion_delivery_ms: statistics(synchronousDelivery),
      response_reads: responseReads,
      quiet_sse: { server_cpu_ms_per_second: cpuMs(fanoutBefore, fanoutAfter) / idleDuration * 1000,
        rss_mib: fanoutAfter.rss / 1024 / 1024,
        sqlite_prepare_calls_per_second: (fanoutAfter.prepared - fanoutBefore.prepared) / idleDuration * 1000,
        sqlite_execution_calls_per_second: (fanoutAfter.executed - fanoutBefore.executed) / idleDuration * 1000 },
      active_sse: active,
      burst_sse: burst,
      large_audit_reads: largeAuditReads,
      compatibility,
      request_admission: admission,
    };
    if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    worker.send({ command: 'close' });
    await new Promise(resolve => worker.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
