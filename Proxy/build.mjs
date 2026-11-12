import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CATALOG as catalog, CATALOG_SHA as catalogSha256, CATALOG_SOURCE, PROXY_POLICY_ID as patchId } from '../Gateway/src/model-settings.mjs';
import { syncCatalog } from './sync-catalog.mjs';
import { commit, extractProxySource } from './upstream.mjs';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, '.build/selectable-proxy');
const go = join(root, '.build/go-toolchain/go/bin/go');
const digest = value => createHash('sha256').update(value).digest('hex');

mkdirSync(stage, { recursive: true });
const registryFile = 'internal/registry/models/models.json';
const source = mkdtempSync(join(stage, 'source-'));
try {
  extractProxySource(join(stage, 'archives'), source);
  execFileSync('/usr/bin/patch', ['-f', '-p1', '-i', join(import.meta.dirname, 'cli-proxy.patch')],
    { cwd: source, stdio: 'inherit' });
  const registry = syncCatalog(readFileSync(join(source, registryFile)), join(root, '.build/catalogs'));
  writeFileSync(join(source, registryFile), JSON.stringify(registry, null, 2) + '\n');
  function replace(file, old, next) {
    const contents = readFileSync(join(source, file), 'utf8');
    const changed = contents.replace(old, next);
    if (changed === contents) throw Error(`Unexpected proxy source: ${file}`);
    writeFileSync(join(source, file), changed);
  }
  const executor = 'internal/runtime/executor';
  const policy = readFileSync(join(import.meta.dirname, 'model-policy.go'), 'utf8');
  const goEntries = Object.entries(catalog).map(([model, efforts]) =>
    `\t${JSON.stringify(model)}: {${efforts.map(effort => `${JSON.stringify(effort)}: true`).join(', ')}},`);
  writeFileSync(join(source, executor, 'skill_store_sol_max.go'), `${policy}\nvar desktopModelCatalog = map[string]map[string]bool{\n${goEntries.join('\n')}\n}\n`);
  cpSync(join(import.meta.dirname, 'model-policy_test.go'), join(source, executor, 'skill_store_sol_max_test.go'));
  replace(`${executor}/codex_executor_request.go`,
    /\t\/\/ skill-store-sol-low-final-http-v1:[^\n]+\n\tvar policyErr error\n\trawJSON, policyErr = skillStoreFinalSolMaxPayload\(rawJSON\)\n\tif policyErr != nil \{ return nil, nil, policyErr \}/,
    '\tif err := validateDesktopModelPolicy(req.Payload, rawJSON); err != nil {\n\t\treturn nil, nil, err\n\t}');
  replace('internal/api/server_routes.go', '"forkId": "skill-store-sol-low-final-http-v1"', `"forkId": "${patchId}"`);
  const health = join(source, 'internal/api/server_routes.go');
  const healthText = readFileSync(health, 'utf8');
  const fixed = '"model": "gpt-6.1-sol", "effort": "low", ';
  if (!healthText.includes(fixed)) throw Error('Unexpected proxy policy declaration');
  writeFileSync(health, healthText.replace(fixed, `"catalogSha256": "${catalogSha256}", "registryCommit": "${CATALOG_SOURCE.commit}", `));

  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(),
    GOOS: 'darwin', GOARCH: 'arm64', CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off',
    GOCACHE: join(stage, 'cache'), GOMODCACHE: join(stage, 'modules'),
    GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GOAUTH: 'off' };
  function run(args) {
    const result = spawnSync(go, args, { cwd: source, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('Proxy build or test failed');
  }
  run(['test', '-mod=readonly', `./${executor}`, '-run', '^TestDesktop(ModelPolicy|CatalogRegistry)$']);
  const binary = join(stage, 'cliproxyapi');
  run(['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X main.Version=${patchId} -X main.Commit=${commit} -X main.BuildDate=source-pinned`, '-o', binary, './cmd/server/']);
  writeFileSync(join(stage, 'receipt.json'), JSON.stringify({ targetOS: 'darwin', targetArch: 'arm64', sourceCommit: commit,
    goVersion: 'go1.26.0', patchId, catalogSha256, registryCommit: CATALOG_SOURCE.commit, registrySha256: CATALOG_SOURCE.sha256,
    binarySha256: digest(readFileSync(binary)) }, null, 2) + '\n');
} finally { rmSync(source, { recursive: true, force: true }); }
