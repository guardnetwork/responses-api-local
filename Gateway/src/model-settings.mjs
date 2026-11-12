import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fault } from './store.mjs';

export const DEFAULT_SELECTION = Object.freeze({ model: 'gpt-6.1-sol', effort: 'low' });
export const DEFAULT_ALIAS = 'local-default';
export const PROXY_POLICY_ID = 'desktop-model-selection-v2';
export const CATALOG_SOURCE = Object.freeze(JSON.parse(readFileSync(new URL('./model-catalog-source.json', import.meta.url))));
if (!/^[a-f0-9]{40}$/.test(CATALOG_SOURCE.commit) || !/^[a-f0-9]{64}$/.test(CATALOG_SOURCE.sha256)) {
  throw Error('invalid_catalog_source');
}
export function isSelectableModelId(id) {
  const version = typeof id === 'string' && /^gpt-([1-9]\d*)(?:\.\d+)?(?:-[a-z0-9]+)*$/.exec(id);
  const major = version ? Number(version[1]) : 0;
  return Number.isSafeInteger(major) && major >= 6;
}

const catalogBytes = readFileSync(new URL('./model-catalog.json', import.meta.url));
const catalog = JSON.parse(catalogBytes);
for (const [id, efforts] of Object.entries(catalog)) {
  if (!isSelectableModelId(id) || !Array.isArray(efforts) || !efforts.length ||
      !efforts.every(effort => typeof effort === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(effort)) ||
      new Set(efforts).size !== efforts.length) throw Error('invalid_model_catalog');
  Object.freeze(efforts);
}
export const CATALOG = Object.freeze(catalog);
export const CATALOG_SHA = createHash('sha256').update(catalogBytes).digest('hex');
export const supports = (model, effort) => Object.hasOwn(CATALOG, model) && CATALOG[model].includes(effort);
const aliasId = (model, effort) => `local-${model}--${effort}`;
const aliases = new Map(Object.entries(CATALOG).flatMap(([model, efforts]) =>
  efforts.map(effort => [aliasId(model, effort), { model, effort }])));
if (!supports(DEFAULT_SELECTION.model, DEFAULT_SELECTION.effort)) throw Error('invalid_model_catalog_default');
const probePredicate = `owner_id=? AND json_extract(metadata_json,'$.modelScope')=?
  AND json_extract(metadata_json,'$.modelProbe') IS NOT NULL`;
const probeRows = `SELECT execution_status AS status,error_code AS code,reported_model,
  json_extract(metadata_json,'$.modelProbe.model') AS model,
  json_extract(metadata_json,'$.modelProbe.effort') AS effort,
  EXISTS(SELECT 1 FROM attempts WHERE job_id=jobs.id AND submitted=1 AND length(upstream_id)>0) AS submitted
  FROM jobs WHERE ${probePredicate}`;
const negativeStatus = new Map([
  ['upstream_model_access_denied', 403], ['upstream_parameter_unsupported', 400],
  ['upstream_request_rejected', 400], ['model_not_available', 404], ['reported_model_mismatch', 502],
  ['reported_effort_mismatch', 502], ['model_verification_unconfirmed', 502],
]);
export const matchesReportedModel = (model, reported) => typeof reported === 'string' &&
  (reported === model || reported.replace(/-\d{4}-\d{2}-\d{2}$/, '') === model);
const confirmed = row => row?.status === 'completed' && row.submitted === 1 && matchesReportedModel(row.model, row.reported_model);

export class ModelSettings {
  constructor(store) { this.store = store; }

  defaults(owner, revision) {
    const saved = this.store.prepare('SELECT model,effort FROM model_defaults WHERE owner_id=? AND scope=?').get(owner, revision);
    return saved && supports(saved.model, saved.effort) ? saved : DEFAULT_SELECTION;
  }

  requireVerified(owner, revision, pair) {
    const rows = this.store.prepare(`${probeRows} AND json_extract(metadata_json,'$.modelProbe.model')=?
      AND json_extract(metadata_json,'$.modelProbe.effort')=? ORDER BY created_at DESC,rowid DESC`)
      .all(owner, revision, pair.model, pair.effort);
    const evidence = rows.find(row => confirmed(row) || negativeStatus.has(row.code));
    if (!confirmed(evidence)) {
      const code = evidence?.code ?? 'model_effort_not_verified';
      throw Object.assign(fault(code, negativeStatus.get(code) ?? 400), { selection: pair });
    }
  }

  choose(owner, revision, body, probe = false) {
    const defaults = this.defaults(owner, revision);
    if (body.model !== undefined && typeof body.model !== 'string') throw fault('model_not_allowed');
    const requested = body.model?.trim();
    const alias = aliases.get(requested);
    const nested = body.reasoning?.effort;
    const legacy = body.reasoning_effort;
    if (nested != null && legacy != null && nested !== legacy) throw fault('reasoning_effort_conflict');
    const explicit = nested ?? legacy ?? undefined;
    if (alias && explicit !== undefined && explicit !== alias.effort) throw fault('model_alias_effort_conflict');
    const model = alias?.model ?? (requested === undefined || requested === DEFAULT_ALIAS ? defaults.model : requested);
    if (!Object.hasOwn(CATALOG, model)) throw fault('model_not_allowed');
    const effort = explicit ?? alias?.effort ?? defaults.effort;
    if (!supports(model, effort)) throw fault(explicit === undefined ? 'default_effort_not_supported' : 'effort_not_allowed');
    const pair = { model, effort };
    if (!probe) this.requireVerified(owner, revision, pair);
    return pair;
  }

  apply(owner, revision, pair) {
    if (!supports(pair.model, pair.effort)) throw fault('effort_not_allowed');
    this.requireVerified(owner, revision, pair);
    this.store.prepare(`INSERT INTO model_defaults(owner_id,scope,model,effort) VALUES(?,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET scope=excluded.scope,model=excluded.model,effort=excluded.effort`)
      .run(owner, revision, pair.model, pair.effort);
  }

  status(owner, revision, modelIds = null) {
    const rows = this.store.prepare(`${probeRows} ORDER BY created_at DESC,rowid DESC`).all(owner, revision);
    const latest = new Map();
    const evidence = new Map();
    for (const row of rows) {
      const key = `${row.model}/${row.effort}`;
      if (!latest.has(key)) latest.set(key, row);
      if (!evidence.has(key) && (confirmed(row) || negativeStatus.has(row.code))) evidence.set(key, row);
    }
    const listed = modelIds === null ? null : new Set(modelIds);
    const models = Object.entries(CATALOG).map(([id, efforts]) => ({ id, proxyListed: listed?.has(id) ?? null, efforts: efforts.map(idEffort => {
      const key = `${id}/${idEffort}`;
      const last = latest.get(key);
      const proxyListed = listed?.has(id);
      const staleMissing = proxyListed && last?.code === 'proxy_model_not_listed';
      const verdict = evidence.get(key);
      return { id: idEffort, verified: proxyListed !== false && confirmed(verdict),
        status: staleMissing ? null : last?.status ?? null,
        code: proxyListed === false ? 'proxy_model_not_listed' :
          (staleMissing ? verdict?.code : last?.code ?? verdict?.code) ?? null };
    }) }));
    return { selection: this.defaults(owner, revision), models,
      testing: rows.some(row => ['queued','running','retrying','cancel_requested'].includes(row.status)) };
  }

  listed(owner, revision, modelIds, includeAliases = false) {
    const { selection, models } = this.status(owner, revision, modelIds);
    const available = models.map(model => ({ id: model.id, efforts: model.efforts.filter(effort => effort.verified).map(effort => effort.id) }))
      .filter(model => model.efforts.length);
    const defaultEfforts = available.find(model => model.id === selection.model)?.efforts ?? [];
    const defaults = defaultEfforts.includes(selection.effort) ? [{ id: DEFAULT_ALIAS, efforts: defaultEfforts }] : [];
    if (!includeAliases) return [...available, ...defaults];
    return [...defaults, ...available, ...available.flatMap(({ id, efforts }) => efforts.map(effort => ({
      id: aliasId(id, effort), efforts: [effort], model: id,
    })))];
  }
}

export const isSelectionAlias = id => aliases.has(id?.trim());
