import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, CATALOG_SOURCE, isSelectableModelId } from '../Gateway/src/model-settings.mjs';

const tiers = ['codex-free', 'codex-team', 'codex-plus', 'codex-pro'];

export function syncCatalog(vendor, cacheDirectory) {
  const { commit, sha256 } = CATALOG_SOURCE;
  const cache = join(cacheDirectory, commit + '.json');
  const cached = existsSync(cache);
  const bytes = cached ? readFileSync(cache) : execFileSync('/usr/bin/curl', [
    '--fail', '--silent', '--show-error', '--location', '--max-time', '45',
    'https://raw.githubusercontent.com/router-for-me/models/' + commit + '/models.json',
  ], { maxBuffer: 4 * 1024 * 1024 });
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('Pinned registry checksum mismatch');
  if (!cached) {
    mkdirSync(cacheDirectory, { recursive: true });
    writeFileSync(cache, bytes);
  }
  const pinned = JSON.parse(bytes);
  const assembled = JSON.parse(vendor);
  const levels = new Map();
  for (const tier of tiers) {
    if (!Array.isArray(pinned[tier]) || !Array.isArray(assembled[tier])) throw Error('Missing Codex tier: ' + tier);
    const selected = pinned[tier].filter(entry => isSelectableModelId(entry?.id));
    const ids = new Set();
    for (const entry of selected) {
      const effort = entry.thinking?.levels;
      if (ids.has(entry.id) || !Array.isArray(effort) || !effort.length ||
          !effort.every(value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value)) ||
          new Set(effort).size !== effort.length) throw Error('Invalid registry entry: ' + entry.id);
      ids.add(entry.id);
      const prior = levels.get(entry.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(effort)) throw Error('Conflicting tier strengths: ' + entry.id);
      levels.set(entry.id, effort);
    }
    const existing = new Map(assembled[tier].map(entry => [entry.id, entry]));
    const synced = selected.map(entry => {
      const metadata = { ...entry };
      // Keep descriptions from the licensed proxy catalog. Copy only registry metadata for new entries.
      delete metadata.description;
      const description = existing.get(entry.id)?.description;
      if (description !== undefined) metadata.description = description;
      return metadata;
    });
    assembled[tier] = [...assembled[tier].filter(entry => !isSelectableModelId(entry?.id)), ...synced];
  }
  const synced = Object.fromEntries([...levels.keys()].sort().map(id => [id, levels.get(id)]));
  if (JSON.stringify(synced) !== JSON.stringify(CATALOG)) {
    throw Error('Gateway model-catalog.json disagrees with the pinned registry');
  }
  return assembled;
}
