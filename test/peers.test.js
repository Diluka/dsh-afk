import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const sourceDir = process.env.DSH_TEST_PLUGIN_DIR ?? fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.DSH_TEST_RUNTIME_DIR;
// CI exercises the resolved `latest` and `next` releases. Adjacent releases in
// the declared compatibility range are assumed API-compatible, not enumerated.
const verifiedReleases = ['0.2.1-rc.2', '0.2.1-rc.5'];
const compatibilityRange = '>=0.2.1-alpha.3 <=0.2.1-rc.5';
const requiredPeers = { '@deepseek-ai/dsh-typert-protocol': compatibilityRange,
  '@deepseek-ai/schemastery': '3.18.5-alpha.2 || 3.18.5', zod: '4.4.3 || 4.6.7' };
const developmentPeers = { '@deepseek-ai/dsh-typert-protocol': '0.2.1-rc.5',
  '@deepseek-ai/schemastery': '3.18.5', zod: '4.6.7' };

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {string} filename */
async function manifestOf(filename) {
  return record(/** @type {unknown} */ (JSON.parse(await readFile(filename, 'utf8'))));
}
/** @param {ReturnType<typeof createRequire>} runtimeRequire */
async function runtimeVersionOf(runtimeRequire) {
  const version = (await manifestOf(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'))).version;
  assert.ok(typeof version === 'string');
  assert.ok(verifiedReleases.includes(version), 'the selected Host SDK must be one of the verified releases');
  if (process.env.DSH_TEST_RUNTIME_VERSION) assert.equal(version, process.env.DSH_TEST_RUNTIME_VERSION, 'CI must exercise the requested release, not an ancestor fallback');
  return version;
}

test('production manifest requires Host-owned peers, with exact matching development pins and no runtime dependency copies', async () => {
  const manifest = await manifestOf(join(sourceDir, 'package.json'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(record(manifest.peerDependencies), requiredPeers);
  assert.equal(record(manifest.engines).dsh, compatibilityRange);
  const development = record(manifest.devDependencies);
  const meta = record(manifest.peerDependenciesMeta ?? {});
  for (const [name, version] of Object.entries(developmentPeers)) {
    assert.equal(development[name], version);
    assert.notEqual(meta[name] && record(meta[name]).optional, true, `${name} is required, not optional`);
  }
  // Packed delivery checks may supply a package directory without workspace tooling.
  // This contract is about the maintained workspace's package-manager policy.
  const workspace = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  assert.match(workspace, /^autoInstallPeers:\s*false\s*$/m);
  assert.match(workspace, /^\s*- ['"]!@deepseek-ai\/dsh-\*['"]\s*$/m, 'dual SDK declarations must not depend on the hidden hoist pool or installation order');
});

test('the selected real SDK fixture resolves one supported release and its intended providers', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const version = await runtimeVersionOf(runtimeRequire);
  const manifest = await manifestOf(join(runtime, 'package.json'));
  const dependencies = record(manifest.dependencies ?? manifest.devDependencies ?? {});
  for (const name of Object.keys(dependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
    assert.equal(dependencies[name], version, `${name} must pin the selected release`);
    assert.equal((await manifestOf(runtimeRequire.resolve(`${name}/package.json`))).version, version, `${name} must resolve to that release`);
  }
  // Workspace SDK fixtures must install their own declared packages; an
  // equal-version ancestor fallback would otherwise pass the version checks.
  if (typeof manifest.name === 'string' && (manifest.name === 'dsh-afk' || manifest.name.startsWith('dsh-afk-runtime-'))) {
    for (const name of new Set([...Object.keys(dependencies), ...Object.keys(requiredPeers)])) {
      assert.equal(await realpath(dirname(runtimeRequire.resolve(`${name}/package.json`))), await realpath(join(runtime, 'node_modules', name)), `${name} must come from the selected workspace fixture`);
    }
  }
});

test('functional integration payload shares the selected real SDK peer providers', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const pluginRequire = createRequire(join(sourceDir, 'index.js'));
  for (const name of Object.keys(requiredPeers)) {
    assert.equal(await realpath(pluginRequire.resolve(name)), await realpath(runtimeRequire.resolve(name)), `${name} must use the selected Host provider during functional tests`);
  }
  const zodVersion = (await manifestOf(runtimeRequire.resolve('zod/package.json'))).version;
  assert.ok(zodVersion === '4.4.3' || zodVersion === '4.6.7', 'the selected Host must provide a supported Zod');
  if (process.env.DSH_TEST_ZOD_VERSION) assert.equal(zodVersion, process.env.DSH_TEST_ZOD_VERSION, 'the selected Host must exercise the requested Zod version');
  const { AfkHistoryService } = /** @type {typeof import('../history.js')} */ (await import(pathToFileURL(join(sourceDir, 'history.js')).href));
  const { TypertRemoteService } = /** @type {typeof import('@deepseek-ai/dsh-typert-protocol')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-typert-protocol')).href));
  assert.equal(Object.getPrototypeOf(AfkHistoryService), TypertRemoteService, 'the actual service must extend the selected Host ESM class, not another release');
});

test('real Host compatibility gates admit the declared boundary and verified releases and reject versions outside the bounds', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  await runtimeVersionOf(runtimeRequire);
  const { evaluatePluginCompatibility } = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
  const manifest = await manifestOf(join(sourceDir, 'package.json'));
  for (const version of ['0.2.1-alpha.3', ...verifiedReleases]) assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined);
  for (const version of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.2', '0.2.1-rc.6', '0.2.1', '0.3.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version);
    assert.ok(issue, `${version} must remain unsupported`);
    assert.equal(issue.exempted, false);
    assert.deepEqual(record(issue).requirements, { 'engines.dsh': compatibilityRange });
  }
});

test('real Host resolution interposes installation providers for a linked plugin with different development peers', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  await runtimeVersionOf(runtimeRequire);
  const boot = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
  const { Context } = /** @type {typeof import('@deepseek-ai/cordis')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href));
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-afk-linked-peers-'));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'fixture');
  const installAnchor = join(root, 'host-installation', 'package.json');
  const installModules = join(root, 'host-installation', 'node_modules');
  const linkedDir = join(root, 'external-source', 'dsh-afk');
  const ctx = new Context();
  try {
    // Production payload only: the linked copy cannot supply its own peers.
    const productionManifest = { ...(await manifestOf(join(sourceDir, 'package.json'))) };
    const sourceVersion = productionManifest.version;
    delete productionManifest.devDependencies;
    delete productionManifest.scripts;
    await mkdir(linkedDir, { recursive: true });
    await writeFile(join(linkedDir, 'package.json'), JSON.stringify(productionManifest));
    for (const filename of ['index.js', 'state.js', 'config.js', 'history.js', 'client.js', 'cordis.patch.yml']) await copyFile(join(sourceDir, filename), join(linkedDir, filename));
    await mkdir(join(profileDir, 'node_modules'), { recursive: true });
    await symlink(linkedDir, join(profileDir, 'node_modules', 'dsh-afk'), 'dir');
    // A source link can have development peers beside it. Give it physically
    // distinct copies so only the Host resolver can supply the payload peers.
    /** @type {Map<string, { directory: string, resolved: string, version: unknown }>} */
    const providers = new Map();
    for (const name of Object.keys(requiredPeers)) {
      const selected = await realpath(dirname(runtimeRequire.resolve(`${name}/package.json`)));
      const localPeer = join(root, 'development-peers', name);
      await mkdir(dirname(localPeer), { recursive: true });
      await cp(selected, localPeer, { recursive: true, dereference: true, filter: path => basename(path) !== 'node_modules' });
      await mkdir(dirname(join(linkedDir, 'node_modules', name)), { recursive: true });
      await symlink(localPeer, join(linkedDir, 'node_modules', name), 'dir');
      await mkdir(dirname(join(installModules, name)), { recursive: true });
      await symlink(selected, join(installModules, name), 'dir');
      providers.set(name, { directory: selected, resolved: runtimeRequire.resolve(name), version: (await manifestOf(join(selected, 'package.json'))).version });
    }
    /** @type {Record<string, unknown>} */
    const hostDependencies = {};
    for (const [name, provider] of providers) hostDependencies[name] = provider.version;
    await writeFile(installAnchor, JSON.stringify({ name: 'afk-peer-host-fixture', private: true, version: '1.0.0', dependencies: hostDependencies }));
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'production-afk-profile-fixture', private: true, dependencies: { 'dsh-afk': sourceVersion }, dsh: { profile: { bundles: ['dsh-afk'] } } }));
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n');
    const pluginURL = pathToFileURL(join(linkedDir, 'index.js')).href;
    const pluginRequire = createRequire(pluginURL);
    for (const [name, provider] of providers) assert.notEqual(await realpath(dirname(pluginRequire.resolve(`${name}/package.json`))), provider.directory, 'before interception, the linked development peer must be a different provider');
    const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
    assert.deepEqual(profile.skippedBundles, []);
    assert.equal(profile.layers.length, 1);
    const resolution = await boot.createRuntimeResolution({ installAnchor, profile, home });
    assert.ok(resolution.localPackageNames.includes('dsh-afk'));
    const linkedRoot = resolution.linkedRoots.find(item => item.name === 'dsh-afk');
    assert.ok(linkedRoot, 'the real resolver must recognize the out-of-profile source link');
    assert.equal(linkedRoot.realPath, await realpath(linkedDir));
    await ctx.plugin(boot.PluginPackages, { resolution });
    for (const [name, provider] of providers) assert.equal(pluginRequire.resolve(name), provider.resolved, 'CJS lookup from the linked plugin must use the exact real Host module path');
    // ESM must use the same interception instead of the adjacent development
    // peers. No server, model or Agent is started.
    /** @param {string} name */
    const directoryOf = name => { const provider = providers.get(name); assert.ok(provider); return provider.directory; };
    const state = /** @type {typeof import('../state.js')} */ (await import(pathToFileURL(join(linkedDir, 'state.js')).href));
    const historyModule = /** @type {typeof import('../history.js')} */ (await import(pathToFileURL(join(linkedDir, 'history.js')).href));
    const plugin = /** @type {typeof import('../index.js')} */ (await import(pluginURL));
    const hostZod = /** @type {typeof import('zod')} */ (await import(pathToFileURL(join(directoryOf('zod'), 'index.js')).href));
    const hostSchema = /** @type {typeof import('@deepseek-ai/schemastery')} */ (await import(pathToFileURL(join(directoryOf('@deepseek-ai/schemastery'), 'lib', 'index.mjs')).href));
    const hostTypert = /** @type {typeof import('@deepseek-ai/dsh-typert-protocol')} */ (await import(pathToFileURL(join(directoryOf('@deepseek-ai/dsh-typert-protocol'), 'lib', 'index.js')).href));
    assert.equal(state.settingsSchema.constructor, hostZod.z.ZodObject, 'the plugin Zod schema must use the Host ESM constructor');
    assert.ok(plugin.Config instanceof hostSchema.default, 'the plugin Config must use the Host Schemastery ESM constructor');
    assert.equal(Object.getPrototypeOf(historyModule.AfkHistoryService), hostTypert.TypertRemoteService, 'the linked plugin must share the Host class');
  } finally {
    // Dispose the only resolver owner before removing its unique fixture paths.
    await ctx.fiber.dispose();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.match(basename(root), /^dsh-afk-linked-peers-/);
    await rm(root, { recursive: true, force: true });
  }
});
