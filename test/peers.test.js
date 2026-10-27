import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const sourceDir = process.env.DSH_TEST_PLUGIN_DIR ?? fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.DSH_TEST_RUNTIME_DIR;
// Published releases within the verified API boundaries, independent of the manifest.
// Keep the upper bound fixed instead of following npm's moving tags or future releases.
const supportedRuntimes = ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4'];
const compatibilityRange = '>=0.2.1-alpha.3 <=0.2.1-rc.4';
const commonPeers = { '@deepseek-ai/schemastery': '3.18.5', zod: '4.6.7' };
const requiredPeers = { '@deepseek-ai/dsh-typert-protocol': compatibilityRange,
  '@deepseek-ai/schemastery': '3.18.5-alpha.2 || 3.18.5', zod: '4.4.3 || 4.6.7' };
const developmentPeers = { '@deepseek-ai/dsh-typert-protocol': '0.2.1-rc.4', ...commonPeers };

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {string} filename */
async function manifestOf(filename) {
  return record(/** @type {unknown} */ (JSON.parse(await readFile(filename, 'utf8'))));
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

test('runtime entry uses the Host CLI resolution instead of a different Node-visible peer', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-afk-cli-resolution-'));
  const cli = join(root, 'cli');
  const harness = join(root, 'harness');
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const workspace = fileURLToPath(new URL('..', import.meta.url));
  const oldRequire = createRequire(join(workspace, 'test', 'runtimes', 'alpha3', 'package.json'));
  const newRequire = createRequire(join(workspace, 'package.json'));
  try {
    await mkdir(join(cli, 'node_modules', 'first-provider', 'node_modules'), { recursive: true });
    await mkdir(join(harness, 'scripts'), { recursive: true });
    await mkdir(join(harness, 'test'), { recursive: true });
    await writeFile(join(harness, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const oldZod = await realpath(dirname(oldRequire.resolve('zod/package.json')));
    const newZod = await realpath(dirname(newRequire.resolve('zod/package.json')));
    assert.notEqual(oldZod, newZod);
    await symlink(oldZod, join(cli, 'node_modules', 'first-provider', 'node_modules', 'zod'), 'dir');
    await symlink(newZod, join(cli, 'node_modules', 'zod'), 'dir');
    await writeFile(join(cli, 'node_modules', 'first-provider', 'package.json'), JSON.stringify({ name: 'first-provider', version: '1.0.0', dependencies: { zod: '4.4.3' } }));
    const dependencies = { 'first-provider': '1.0.0', '@deepseek-ai/dsh-app-boot': 'fixture',
      '@deepseek-ai/dsh-typert-protocol': 'fixture', '@deepseek-ai/schemastery': 'fixture' };
    await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'fixture', dependencies }));
    for (const name of Object.keys(dependencies).filter(name => name.startsWith('@'))) {
      const destination = join(cli, 'node_modules', name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(await realpath(dirname(runtimeRequire.resolve(`${name}/package.json`))), destination, 'dir');
    }
    const cliRequire = createRequire(join(cli, 'package.json'));
    assert.equal(await realpath(dirname(cliRequire.resolve('zod/package.json'))), newZod, 'plain Node lookup must differ from the Host graph');
    await copyFile(join(workspace, 'scripts', 'test-runtime.js'), join(harness, 'scripts', 'test-runtime.js'));
    await writeFile(join(harness, 'test', 'carrier.test.js'), `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { realpath } from 'node:fs/promises';
      import { dirname, join } from 'node:path';
      import test from 'node:test';
      test('CLI carrier and plugin use the resolved Host provider', async () => {
        const host = createRequire(join(process.env.DSH_TEST_RUNTIME_DIR, 'package.json'));
        const plugin = createRequire(join(process.env.DSH_TEST_PLUGIN_DIR, 'index.js'));
        const expected = process.env.AFK_EXPECT_HOST_ZOD;
        for (const req of [host, plugin]) assert.equal(await realpath(dirname(req.resolve('zod/package.json'))), expected);
      });
    `);
    const child = spawnSync(process.execPath, [join(harness, 'scripts', 'test-runtime.js')], {
      cwd: harness, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, DSH_TEST_RUNTIME_DIR: cli, DSH_TEST_PLUGIN_DIR: sourceDir, AFK_EXPECT_HOST_ZOD: oldZod },
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.match(basename(root), /^dsh-afk-cli-resolution-/);
    await rm(root, { recursive: true, force: true });
  }
});

/** @param {ReturnType<typeof createRequire>} runtimeRequire */
async function runtimeVersionOf(runtimeRequire) {
  const metadata = await manifestOf(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'));
  const version = metadata.version;
  assert.ok(typeof version === 'string');
  assert.ok(supportedRuntimes.includes(version), 'the selected Host SDK must be a supported release');
  if (process.env.DSH_TEST_RUNTIME_VERSION) assert.equal(version, process.env.DSH_TEST_RUNTIME_VERSION, 'CI must exercise the requested release, not an ancestor fallback');
  return version;
}

test('the selected real SDK uses one supported DSH release throughout its declared packages', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const version = await runtimeVersionOf(runtimeRequire);
  const manifest = await manifestOf(join(runtime, 'package.json'));
  // Production CLI installations do not install the published manifest's devDependencies.
  // Workspace SDK fixtures, in contrast, intentionally provide their SDKs as devDependencies.
  const dependencies = record(manifest.dependencies ?? manifest.devDependencies ?? {});
  const expectedZodByFixture = new Map([
    ['dsh-afk', '4.6.7'], ['dsh-afk-runtime-alpha3', '4.4.3'], ['dsh-afk-runtime-rc2', '4.6.7'],
    ['dsh-afk-runtime-rc3', '4.6.7'], ['dsh-afk-runtime-rc4-zod443', '4.4.3'],
  ]);
  const expectedZod = typeof manifest.name === 'string' ? expectedZodByFixture.get(manifest.name) : undefined;
  const actualZod = (await manifestOf(runtimeRequire.resolve('zod/package.json'))).version;
  if (expectedZod) assert.equal(actualZod, expectedZod, 'the selected fixture must exercise its intended Zod provider');
  if (process.env.DSH_TEST_ZOD_VERSION) assert.equal(actualZod, process.env.DSH_TEST_ZOD_VERSION, 'the selected Host must exercise the requested Zod version');
  const expectedSchemaByFixture = new Map([
    ['dsh-afk', '3.18.5'], ['dsh-afk-runtime-alpha3', '3.18.5-alpha.2'], ['dsh-afk-runtime-rc2', '3.18.5'],
    ['dsh-afk-runtime-rc3', '3.18.5'], ['dsh-afk-runtime-rc4-zod443', '3.18.5'],
  ]);
  const expectedSchema = typeof manifest.name === 'string' ? expectedSchemaByFixture.get(manifest.name) : undefined;
  const actualSchema = (await manifestOf(runtimeRequire.resolve('@deepseek-ai/schemastery/package.json'))).version;
  if (expectedSchema) assert.equal(actualSchema, expectedSchema, 'the selected fixture must exercise its intended Schemastery provider');
  const names = Object.keys(dependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'));
  assert.ok(names.includes('@deepseek-ai/dsh-app-boot'));
  for (const name of names) {
    assert.equal(dependencies[name], version, `${name} must pin the selected release`);
    const installed = await manifestOf(runtimeRequire.resolve(`${name}/package.json`));
    assert.equal(installed.version, version, `${name} must resolve to that release`);
  }
  // Workspace SDK fixtures must actually install their own declared packages;
  // a same-version ancestor fallback would otherwise pass the version check.
  if (manifest.name === 'dsh-afk' || (typeof manifest.name === 'string' && manifest.name.startsWith('dsh-afk-runtime-'))) {
    for (const name of new Set([...names, ...Object.keys(requiredPeers)])) {
      /** @type {string} */
      const direct = await realpath(join(runtime, 'node_modules', name));
      const resolved = await realpath(dirname(runtimeRequire.resolve(`${name}/package.json`)));
      assert.equal(resolved, direct, `${name} must resolve from the selected workspace installation`);
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
  const { AfkHistoryService } = /** @type {typeof import('../history.js')} */ (await import(pathToFileURL(join(sourceDir, 'history.js')).href));
  const { TypertRemoteService } = /** @type {typeof import('@deepseek-ai/dsh-typert-protocol')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-typert-protocol')).href));
  assert.equal(Object.getPrototypeOf(AfkHistoryService), TypertRemoteService, 'the actual service must extend the selected Host ESM class, not another release');
});

test('real Host compatibility gates admit the bounded supported releases without exemptions and reject versions outside the boundaries', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const selectedVersion = await runtimeVersionOf(runtimeRequire);
  const { evaluatePluginCompatibility } = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
  const manifest = await manifestOf(join(sourceDir, 'package.json'));
  for (const version of supportedRuntimes) assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined);
  for (const version of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-rc.5', '0.2.1', '0.3.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version);
    assert.ok(issue, `${version} must remain unsupported`);
    assert.equal(issue.exempted, false);
    // alpha.3 checks DSH peers; alpha.4 introduced engines.dsh and renamed this result field.
    const legacyGate = selectedVersion === '0.2.1-alpha.3';
    assert.deepEqual(record(issue)[legacyGate ? 'peers' : 'requirements'], legacyGate
      ? { '@deepseek-ai/dsh-typert-protocol': compatibilityRange } : { 'engines.dsh': compatibilityRange });
  }
});

// Node's test runner isolates this file from the other integration files. The
// variants are awaited serially, each with unique paths and an owned Cordis
// service: no overlapping process-global resolver interception or cached plugin URL.
test('real Host runtime resolution supplies peers to installed and linked plugin copies', { skip: !runtime }, async t => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const version = await runtimeVersionOf(runtimeRequire);
  const zodVersion = (await manifestOf(runtimeRequire.resolve('zod/package.json'))).version;
  assert.ok(zodVersion === '4.4.3' || zodVersion === '4.6.7', 'the Host must provide a supported Zod version');
  const schemaVersion = (await manifestOf(runtimeRequire.resolve('@deepseek-ai/schemastery/package.json'))).version;
  assert.ok(schemaVersion === '3.18.5-alpha.2' || schemaVersion === '3.18.5', 'the Host must provide a supported Schemastery version');
  const expectedPeers = { '@deepseek-ai/dsh-typert-protocol': version,
    '@deepseek-ai/schemastery': schemaVersion, zod: zodVersion };
  const { Context } = /** @type {typeof import('@deepseek-ai/cordis')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href));
  const { createRuntimeResolution, loadProfileDirectory, PluginPackages } = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
  for (const variant of ['installed-directory', 'external-source-link', 'external-source-link-with-development-peers']) {
    await t.test(variant, async () => {
      const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-afk-peers-'));
      const home = join(root, 'home');
      const profileDir = join(home, 'profiles', 'fixture');
      const installDir = join(root, 'host-installation');
      const installAnchor = join(installDir, 'package.json');
      const profilePackage = join(profileDir, 'node_modules', 'dsh-afk');
      const linked = variant !== 'installed-directory';
      const developmentPeersPresent = variant === 'external-source-link-with-development-peers';
      const copiedSourceDir = linked ? join(root, 'external-source', 'dsh-afk') : profilePackage;
      const ctx = new Context();
      try {
        await mkdir(copiedSourceDir, { recursive: true });
        await mkdir(join(profileDir, 'node_modules'), { recursive: true });
        await mkdir(join(installDir, 'node_modules'), { recursive: true });
        const sourceManifest = await manifestOf(join(sourceDir, 'package.json'));
        // Production payload only: neither installed dependencies nor dev dependencies
        // can accidentally satisfy a peer from this copied package or its ancestors.
        const productionManifest = { ...sourceManifest };
        delete productionManifest.devDependencies;
        delete productionManifest.scripts;
        await writeFile(join(copiedSourceDir, 'package.json'), JSON.stringify(productionManifest));
        for (const filename of ['index.js', 'state.js', 'config.js', 'history.js', 'client.js', 'cordis.patch.yml']) {
          await copyFile(join(sourceDir, filename), join(copiedSourceDir, filename));
        }
        if (linked) await symlink(copiedSourceDir, profilePackage, 'dir');
        assert.equal((await lstat(profilePackage)).isSymbolicLink(), linked);
        assert.equal((await manifestOf(join(copiedSourceDir, 'package.json'))).devDependencies, undefined);
        // A source link can have development dependencies beside it. Supply peers
        // from a *different* supported SDK to prove the Host intercepts them first.
        if (developmentPeersPresent) {
          const workspace = fileURLToPath(new URL('..', import.meta.url));
          const candidates = [workspace, join(workspace, 'test', 'runtimes', 'alpha3')].map(dir => createRequire(join(dir, 'package.json')));
          for (const name of Object.keys(requiredPeers)) {
            const selected = await realpath(dirname(runtimeRequire.resolve(`${name}/package.json`)));
            let alternate;
            for (const candidate of candidates) {
              const directory = await realpath(dirname(candidate.resolve(`${name}/package.json`)));
              if (directory !== selected) { alternate = directory; break; }
            }
            assert.ok(alternate, `${name} must have a distinct development provider`);
            const destination = join(copiedSourceDir, 'node_modules', name);
            await mkdir(dirname(destination), { recursive: true });
            await symlink(alternate, destination, 'dir');
          }
        } else {
          await assert.rejects(lstat(join(copiedSourceDir, 'node_modules')), { code: 'ENOENT' });
        }
        await writeFile(join(profileDir, 'package.json'), JSON.stringify({
          name: 'production-afk-profile-fixture', private: true,
          dependencies: { 'dsh-afk': sourceManifest.version }, dsh: { profile: { bundles: ['dsh-afk'] } },
        }));
        await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n');
        /** @type {Record<string, string>} */
        const provided = {};
        /** @type {Map<string, { directory: string, resolved: string }>} */
        const providers = new Map();
        for (const [name, expectedVersion] of Object.entries(expectedPeers)) {
          const packageManifest = runtimeRequire.resolve(`${name}/package.json`);
          const metadata = await manifestOf(packageManifest);
          assert.equal(metadata.version, expectedVersion, `the selected real Host must provide the supported ${name} baseline`);
          provided[name] = expectedVersion;
          const directory = await realpath(dirname(packageManifest));
          const destination = join(installDir, 'node_modules', name);
          await mkdir(dirname(destination), { recursive: true });
          await symlink(directory, destination, 'dir');
          providers.set(name, { directory, resolved: runtimeRequire.resolve(name) });
        }
        await writeFile(installAnchor, JSON.stringify({ name: 'afk-peer-host-fixture', private: true, version: '1.0.0', dependencies: provided }));
        const pluginURL = pathToFileURL(join(copiedSourceDir, 'index.js')).href;
        const pluginRequire = createRequire(pluginURL);
        for (const name of Object.keys(requiredPeers)) {
          if (developmentPeersPresent) {
            assert.notEqual(await realpath(pluginRequire.resolve(name)), await realpath(runtimeRequire.resolve(name)), 'before interception, the linked development peer must be a different provider');
          } else {
            assert.throws(() => pluginRequire.resolve(name), { code: 'MODULE_NOT_FOUND' }, 'native Node lookup cannot supply a peer from the isolated production copy');
          }
        }
        const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
        assert.deepEqual(profile.skippedBundles, []);
        assert.equal(profile.layers.length, 1);
        assert.equal(profile.layers[0].packageName, 'dsh-afk');
        assert.equal(await realpath(profile.layers[0].packageDir), await realpath(copiedSourceDir));
        const resolution = await createRuntimeResolution({ installAnchor, profile, home });
        assert.ok(resolution.localPackageNames.includes('dsh-afk'));
        if (linked) {
          const linkedRoot = resolution.linkedRoots.find(item => item.name === 'dsh-afk');
          assert.ok(linkedRoot, 'the real resolver must recognize the out-of-profile source link');
          assert.equal(linkedRoot.realPath, await realpath(copiedSourceDir));
        } else {
          assert.equal(resolution.linkedRoots.some(item => item.name === 'dsh-afk'), false);
        }
        await ctx.plugin(PluginPackages, { resolution });
        const hostRequire = createRequire(installAnchor);
        for (const [name, provider] of providers) {
          const entry = resolution.entries.find(item => item.name === name);
          assert.ok(entry);
          assert.equal(entry.scope, 'installation');
          assert.equal(entry.declarer, installAnchor);
          assert.equal(await realpath(entry.packageDir), provider.directory);
          assert.equal(pluginRequire.resolve(name), provider.resolved, 'CJS lookup from the copied plugin must use the exact real Host module path');
          assert.equal(pluginRequire.resolve(name), hostRequire.resolve(name));
          const selected = ctx.pluginPackages.packageOf(name, pluginURL);
          assert.ok(selected);
          assert.equal(await realpath(selected.dir), provider.directory);
        }
        // ESM must use that same native interception, not a hand-written resolver
        // or dev-node_modules fallback. No server, model or Agent is started.
        const copiedPlugin = /** @type {typeof import('../index.js')} */ (await import(pluginURL));
        const copiedState = /** @type {typeof import('../state.js')} */ (await import(pathToFileURL(join(copiedSourceDir, 'state.js')).href));
        assert.equal(typeof copiedPlugin.apply, 'function');
        assert.equal(copiedState.projection.key, 'dsh-afk');
        // The two libraries expose different ESM and CJS entries. Checking
        // require.resolve alone cannot prove the plugin's ESM schemas share the Host.
        const zodProvider = providers.get('zod');
        const schemaProvider = providers.get('@deepseek-ai/schemastery');
        assert.ok(zodProvider && schemaProvider);
        const hostZod = /** @type {typeof import('zod')} */ (await import(pathToFileURL(join(zodProvider.directory, 'index.js')).href));
        const hostSchema = /** @type {typeof import('@deepseek-ai/schemastery')} */ (await import(pathToFileURL(join(schemaProvider.directory, 'lib/index.mjs')).href));
        assert.equal(copiedState.settingsSchema.constructor, hostZod.z.ZodObject, 'the plugin Zod schema must use the Host ESM constructor');
        assert.ok(copiedPlugin.Config instanceof hostSchema.default, 'the plugin Config must use the Host Schemastery ESM constructor');
        const defaults = copiedPlugin.Config();
        assert.equal(defaults.scope.get(), 'session');
        assert.equal(defaults.global.get().enabled, false);
        assert.equal(defaults.global.get().mode, 'auto-reply');
        assert.ok(defaults.global.get().reply.trim().length > 0);
        const copiedHistory = /** @type {typeof import('../history.js')} */ (await import(pathToFileURL(join(copiedSourceDir, 'history.js')).href));
        const { TypertRemoteService } = /** @type {typeof import('@deepseek-ai/dsh-typert-protocol')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-typert-protocol')).href));
        assert.equal(Object.getPrototypeOf(copiedHistory.AfkHistoryService), TypertRemoteService, 'the linked plugin must share the Host class even when its development peers exist');
        if (!developmentPeersPresent) {
          await assert.rejects(lstat(join(copiedSourceDir, 'node_modules')), { code: 'ENOENT' }, 'real runtime interception must not install fallback links');
        }
      } finally {
        // Dispose the only resolver owner before removing its unique fixture paths.
        await ctx.fiber.dispose();
        assert.equal(dirname(root), resolve(tmpdir()));
        assert.match(basename(root), /^dsh-afk-peers-/);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
