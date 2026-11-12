import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { EventEmitter } from 'node:events';

export const TERMINAL_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled', 'unknown']);

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function fault(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
const timestamp = () => new Date().toISOString();
const workloadLane = "CASE WHEN json_extract(metadata_json,'$.workload')='interactive' THEN 'interactive' ELSE 'background' END";
const pendingJobs = "execution_status IN('queued','retrying') AND cancel_requested=0";
const responseStats = `
  (SELECT MIN(started_at) FROM attempts WHERE job_id=jobs.id) AS started_at,
  (SELECT created_at FROM events WHERE job_id=jobs.id AND event_type='response.output_text.delta' ORDER BY id LIMIT 1) AS first_text_at,
  EXISTS(SELECT 1 FROM attempts WHERE job_id=jobs.id AND upstream_id IS NOT NULL) AS forwarded`;

function decode(row) {
  if (!row) return null;
  const out = { ...row };
  for (const field of ['request_json', 'response_json', 'metadata_json', 'changes_json']) {
    out[field.replace('_json', '')] = out[field] ? JSON.parse(out[field]) : null;
    delete out[field];
  }
  return out;
}

export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.statements = new Map();
    this.changes = new EventEmitter().setMaxListeners(0);
    this.eventVersion = 0;
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,kind TEXT NOT NULL,request_json TEXT NOT NULL,changes_json TEXT NOT NULL,metadata_json TEXT NOT NULL,execution_status TEXT NOT NULL,save_status TEXT NOT NULL,response_id TEXT NOT NULL UNIQUE,response_json TEXT,output_text TEXT,reported_model TEXT,error_code TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,ready_at INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_id,idempotency_key),UNIQUE(owner_id,operation_id));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,event_type TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id,id);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL,upstream_id TEXT,request_hash TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,error_code TEXT);
      CREATE TABLE IF NOT EXISTS connection_bindings(owner_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_defaults(owner_id TEXT PRIMARY KEY,scope TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL);
      PRAGMA user_version=1;`);
    const columns = this.db.prepare('PRAGMA table_info(jobs)').all().map(x => x.name);
    if (!columns.includes('terminal_json')) this.db.exec('ALTER TABLE jobs ADD COLUMN terminal_json TEXT');
    if (!columns.includes('original_json')) this.db.exec('ALTER TABLE jobs ADD COLUMN original_json TEXT');
    if (!this.db.prepare('PRAGMA table_info(attempts)').all().some(x => x.name === 'submitted')) this.db.exec('ALTER TABLE attempts ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS attempts_job_started ON attempts(job_id,started_at);
      CREATE INDEX IF NOT EXISTS jobs_pending_lane ON jobs(${workloadLane},created_at,id) WHERE ${pendingJobs};
      DROP INDEX IF EXISTS jobs_pending;
      CREATE INDEX IF NOT EXISTS jobs_active_lease ON jobs(lease_until)
        WHERE execution_status IN('running','cancel_requested');
      CREATE INDEX IF NOT EXISTS jobs_retention ON jobs(updated_at)
        WHERE json_extract(metadata_json,'$.retain')=0 AND request_json!='{}'
          AND execution_status IN('completed','failed','incomplete','unknown','cancelled');
      CREATE INDEX IF NOT EXISTS jobs_recent_terminal ON jobs(owner_id,updated_at DESC)
        WHERE execution_status IN('completed','failed','incomplete');
      CREATE INDEX IF NOT EXISTS jobs_model_probes ON jobs(owner_id,json_extract(metadata_json,'$.modelScope'),created_at DESC)
        WHERE json_extract(metadata_json,'$.modelProbe') IS NOT NULL;`);
  }
  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  transaction(fn) {
    const depth = this.transactionDepth || 0;
    const savepoint = 'nested_' + depth;
    this.db.exec(depth ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
    this.transactionDepth = depth + 1;
    try { const result = fn(); this.db.exec(depth ? 'RELEASE ' + savepoint : 'COMMIT'); return result; }
    catch (e) { this.db.exec(depth ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK'); if (depth) this.db.exec('RELEASE ' + savepoint); throw e; }
    finally { this.transactionDepth = depth; }
  }
  get(owner, id) {
    const row = this.prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').get(id, owner)
      ?? this.prepare('SELECT * FROM jobs WHERE response_id=? AND owner_id=?').get(id, owner);
    if (!row) throw fault('job_not_found', 404);
    return decode(row);
  }
  getResponse(owner, responseId) {
    const row = this.prepare(`SELECT id,response_id,execution_status,save_status,output_text,reported_model,
      error_code,metadata_json,response_json,created_at,updated_at,
      request_json='{}' AS request_pruned, json_extract(request_json,'$.model') AS requested_model,
      json_extract(request_json,'$.reasoning.effort') AS requested_effort, ${responseStats}
      FROM jobs WHERE response_id=? AND owner_id=?`).get(responseId, owner);
    if (!row) throw fault('job_not_found', 404);
    const job = decode(row);
    job.request = row.request_pruned ? {} : { model: row.requested_model, reasoning: { effort: row.requested_effort } };
    return job;
  }
  getInternal(id) { return decode(this.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }
  connectionRevision(owner) {
    const select = this.prepare('SELECT revision,enabled FROM connection_bindings WHERE owner_id=?');
    const existing = select.get(owner);
    if (existing) return existing;
    this.prepare('INSERT INTO connection_bindings(owner_id,revision,enabled,updated_at) VALUES(?,0,1,?) ON CONFLICT(owner_id) DO NOTHING').run(owner, timestamp());
    return select.get(owner);
  }
  changeConnection(owner, enabled) {
    this.connectionRevision(owner);
    this.prepare('UPDATE connection_bindings SET revision=revision+1,enabled=?,updated_at=? WHERE owner_id=?').run(enabled ? 1 : 0, timestamp(), owner);
    return this.connectionRevision(owner);
  }
  existing(owner, key, operationId) {
    return decode(this.prepare('SELECT * FROM jobs WHERE owner_id=? AND (idempotency_key=? OR operation_id=?)').get(owner, key, operationId));
  }
  create({ owner, key, operationId, request, original = request, originalHash, changes = [], metadata = {} }) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(key) || typeof operationId !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(operationId)) throw fault('idempotency_key_required');
    return this.transaction(() => {
      const existing = this.prepare('SELECT * FROM jobs WHERE owner_id=? AND (idempotency_key=? OR operation_id=?)').get(owner, key, operationId);
      if (existing) {
        if (existing.request_hash !== originalHash) throw fault('idempotency_conflict', 409);
        return { job: decode(existing), replayed: true };
      }
      const id = randomUUID(), responseId = 'ss_resp_' + randomUUID().replaceAll('-', ''), now = timestamp();
      this.prepare(`INSERT INTO jobs(id,owner_id,idempotency_key,operation_id,request_hash,kind,request_json,changes_json,metadata_json,execution_status,save_status,response_id,created_at,updated_at,original_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, owner, key, operationId, originalHash, 'response', JSON.stringify(request), JSON.stringify(changes), JSON.stringify(metadata), 'queued', 'local_pending', responseId, now, now, JSON.stringify(original));
      this.event(id, 'job.queued', { job_id: id, policy: metadata.policyId ?? 'sol_low_v1' });
      this.event(id, 'response.created', { type: 'response.created', response: { id: responseId, object: 'response', status: 'queued', model: request.model } });
      return { job: this.getInternal(id), replayed: false };
    });
  }
  event(id, type, data) {
    this.prepare('INSERT INTO events(job_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(id, type, JSON.stringify(data), timestamp());
    this.eventVersion++;
    this.changes.emit(id, type);
  }
  events(owner, id, after = 0) {
    return this.eventsForJob(this.get(owner, id).id, after);
  }
  eventsForJob(id, after = 0) {
    return this.prepare('SELECT id,event_type,data_json,created_at FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 500').all(id, after).map(r => ({ ...r, data: JSON.parse(r.data_json), data_json: undefined }));
  }
  status(id) {
    const row = this.prepare('SELECT execution_status FROM jobs WHERE id=?').get(id);
    if (!row) throw fault('job_not_found', 404);
    return row.execution_status;
  }
  claim(now = Date.now(), leaseMs = 120000, { maxConcurrent = 1 } = {}) {
    if (![1, 2].includes(maxConcurrent)) throw fault('invalid_concurrency_limit');
    return this.transaction(() => {
      const active = this.prepare(`SELECT ${workloadLane} AS lane FROM jobs WHERE execution_status IN('running','cancel_requested') AND lease_until>?`).all(now);
      if (active.length >= maxConcurrent) return null;
      let row;
      // One slot per lane. Background work never consumes the interactive reservation.
      for (const workload of ['interactive', 'background']) {
        if (active.some(item => item.lane === workload)) continue;
        row = this.prepare(`SELECT id FROM jobs WHERE ${pendingJobs} AND ready_at<=? AND ${workloadLane}=? ORDER BY created_at,id LIMIT 1`).get(now, workload);
        if (row) break;
      }
      if (!row) return null;
      this.prepare("UPDATE jobs SET execution_status='running',attempt_count=attempt_count+1,lease_until=?,updated_at=? WHERE id=?").run(now + leaseMs, timestamp(), row.id);
      const job = this.getInternal(row.id), attemptId = randomUUID();
      this.prepare('INSERT INTO attempts(id,job_id,state,request_hash,started_at) VALUES(?,?,?,?,?)').run(attemptId, job.id, 'preparing', hash(job.request), timestamp());
      this.event(job.id, 'job.started', { job_id: job.id, attempt: job.attempt_count });
      return { job, attemptId };
    });
  }
  responseMetrics(job) {
    const { started_at: start = null, first_text_at: first = null, forwarded = 0 } =
      job.forwarded !== undefined ? job : this.prepare(`SELECT ${responseStats} FROM jobs WHERE id=?`).get(job.id) ?? {};
    const finished = ['completed', 'failed', 'incomplete', 'cancelled'].includes(job.execution_status) ? job.updated_at : null;
    const accepted = Date.parse(job.created_at);
    const elapsed = value => value ? Math.max(0, Date.parse(value) - accepted) : null;
    return { forwarded: forwarded === 1,
      timing: { accepted_at: job.created_at, started_at: start, first_text_at: first, finished_at: finished,
        queue_ms: elapsed(start), first_text_ms: elapsed(first), total_ms: elapsed(finished) } };
  }
  submitted(jobId, attemptId) { this.prepare("UPDATE attempts SET state='submitted',submitted=1 WHERE id=? AND job_id=?").run(attemptId, jobId); }
  heartbeat(id) { this.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND execution_status='running'").run(Date.now() + 120000, id); }
  upstreamId(attemptId, id) { if (typeof id === 'string' && id.length < 240) this.prepare('UPDATE attempts SET upstream_id=? WHERE id=?').run(id, attemptId); }
  terminal(id, response) {
    const json = JSON.stringify(response);
    const text = (response.output || []).filter(x => x.type === 'message').flatMap(x => (x.content || []).filter(c => c.type === 'output_text').map(c => c.text || '')).join('\n');
    this.prepare('UPDATE jobs SET terminal_json=?,response_json=?,output_text=?,reported_model=?,updated_at=? WHERE id=?')
      .run(json, json, text, typeof response.model === 'string' ? response.model : null, timestamp(), id);
  }
  providerTerminal(id, attemptId, response, code) {
    this.terminal(id, response);
    const state = response.status === 'cancelled' ? 'cancelled' : response.status === 'incomplete' ? 'incomplete' : 'failed';
    this.fail(id, attemptId, code);
    const job = this.getInternal(id);
    if (!job.cancel_requested && job.execution_status !== 'cancelled') this.prepare('UPDATE jobs SET execution_status=?,updated_at=? WHERE id=?').run(state, timestamp(), id);
  }
  finish(id, attemptId, response, outputText, completedResponse) {
    return this.transaction(() => {
      const json = JSON.stringify(response);
      const saved = this.prepare(`UPDATE jobs SET execution_status='completed',save_status='local_saved',
        terminal_json=?,response_json=?,output_text=?,reported_model=?,lease_until=NULL,error_code=NULL,updated_at=?
        WHERE id=? AND cancel_requested=0 AND execution_status!='cancelled'`)
        .run(json, json, outputText, typeof response.model === 'string' ? response.model : null, timestamp(), id);
      if (!saved.changes) return false;
      this.prepare("UPDATE attempts SET state='completed',ended_at=? WHERE id=?").run(timestamp(), attemptId);
      if (completedResponse) this.event(id, 'response.completed', {
        type: 'response.completed', response: completedResponse(),
      });
      return true;
    });
  }
  fail(id, attemptId, code, retry = false, delayMs = 0, unknown = false) {
    this.transaction(() => {
      const job = this.getInternal(id);
      if (!job || job.execution_status === 'cancelled') return;
      const state = job.cancel_requested ? 'cancelled' : retry ? 'retrying' : unknown ? 'unknown' : 'failed';
      this.prepare('UPDATE jobs SET execution_status=?,error_code=?,lease_until=NULL,ready_at=?,updated_at=? WHERE id=?').run(state, code, Date.now() + delayMs, timestamp(), id);
      this.prepare('UPDATE attempts SET state=?,error_code=?,ended_at=? WHERE id=?').run(unknown ? 'unknown' : state, code, timestamp(), attemptId);
      this.event(id, 'job.' + state, { job_id: id, error_code: code, attempt: job.attempt_count });
    });
  }
  recoverExpired(now = Date.now()) {
    const rows = this.prepare("SELECT id,cancel_requested FROM jobs WHERE execution_status IN('running','cancel_requested') AND lease_until<?").all(now);
    for (const row of rows) {
      const attempt = this.prepare('SELECT id,state FROM attempts WHERE job_id=? ORDER BY started_at DESC LIMIT 1').get(row.id);
      if (row.cancel_requested) {
        this.prepare("UPDATE jobs SET execution_status='cancelled',lease_until=NULL,error_code='worker_interrupted',updated_at=? WHERE id=?").run(timestamp(), row.id);
      } else if (attempt?.state === 'preparing') {
        this.prepare("UPDATE jobs SET execution_status='queued',lease_until=NULL,updated_at=? WHERE id=?").run(timestamp(), row.id);
      } else {
        this.prepare("UPDATE jobs SET execution_status='unknown',error_code='worker_interrupted',lease_until=NULL,updated_at=? WHERE id=?").run(timestamp(), row.id);
      }
      if (attempt) this.prepare("UPDATE attempts SET state='unknown',error_code='worker_interrupted',ended_at=? WHERE id=?").run(timestamp(), attempt.id);
      this.event(row.id, 'job.recovered', { job_id: row.id, action: attempt?.state === 'preparing' ? 'queued_before_submission' : 'unknown_after_submission' });
    }
    return rows.length;
  }
  cancel(owner, id) {
    const job = this.get(owner, id);
    if (['completed', 'failed', 'incomplete', 'cancelled'].includes(job.execution_status)) return job;
    const state = job.execution_status === 'running' ? 'cancel_requested' : 'cancelled';
    this.prepare('UPDATE jobs SET cancel_requested=1,execution_status=?,save_status=?,updated_at=? WHERE id=?').run(state, state, timestamp(), job.id);
    this.event(job.id, 'job.' + state, { job_id: job.id });
    return this.get(owner, job.id);
  }
  close() { this.changes.removeAllListeners(); this.statements.clear(); this.db.close(); }
}
