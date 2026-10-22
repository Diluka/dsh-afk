import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const sourceDir = process.env.DSH_TEST_PLUGIN_DIR ?? fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.DSH_TEST_RUNTIME_DIR;
// These exact versions are the declared supported Host baseline, not values inferred from the implementation under test.
const requiredPeers = { '@deepseek-ai/dsh-typert-protocol': '0.2.1-rc.2', '@deepseek-ai/schemastery': '3.18.5', zod: '4.6.7' };

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
  const development = record(manifest.devDependencies);
  const meta = record(manifest.peerDependenciesMeta ?? {});
  for (const [name, version] of Object.entries(requiredPeers)) {
    assert.equal(development[name], version);
    assert.notEqual(meta[name] && record(meta[name]).optional, true, `${name} is required, not optional`);
  }
  // Packed delivery checks may supply a package directory without workspace tooling.
  // This contract is about the maintained workspace's package-manager policy.
  const workspace = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  assert.match(workspace, /^autoInstallPeers:\s*false\s*$/m);
});

// Node's test runner isolates this file from the other integration files. The
// two variants are awaited serially, each with unique paths and an owned Cordis
// service: no overlapping process-global resolver interception or cached plugin URL.
test('real Host runtime resolution supplies peers to dependency-free production package copies', { skip: !runtime }, async t => {
  assert.ok(runtime);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const { Context } = /** @type {typeof import('@deepseek-ai/cordis')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href));
  const { createRuntimeResolution, loadProfileDirectory, PluginPackages } = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
  for (const variant of ['installed-directory', 'external-source-link']) {
    await t.test(variant, async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-afk-peers-'));
      const home = join(root, 'home');
      const profileDir = join(home, 'profiles', 'fixture');
      const installDir = join(root, 'host-installation');
      const installAnchor = join(installDir, 'package.json');
      const profilePackage = join(profileDir, 'node_modules', 'dsh-afk');
      const copiedSourceDir = variant === 'external-source-link' ? join(root, 'external-source', 'dsh-afk') : profilePackage;
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
        if (variant === 'external-source-link') await symlink(copiedSourceDir, profilePackage, 'dir');
        assert.equal((await lstat(profilePackage)).isSymbolicLink(), variant === 'external-source-link');
        assert.equal((await manifestOf(join(copiedSourceDir, 'package.json'))).devDependencies, undefined);
        await assert.rejects(lstat(join(copiedSourceDir, 'node_modules')), { code: 'ENOENT' });
        await writeFile(join(profileDir, 'package.json'), JSON.stringify({
          name: 'production-afk-profile-fixture', private: true,
          dependencies: { 'dsh-afk': sourceManifest.version }, dsh: { profile: { bundles: ['dsh-afk'] } },
        }));
        await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n');
        /** @type {Record<string, string>} */
        const provided = {};
        /** @type {Map<string, { directory: string, resolved: string }>} */
        const providers = new Map();
        for (const [name, expectedVersion] of Object.entries(requiredPeers)) {
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
          assert.throws(() => pluginRequire.resolve(name), { code: 'MODULE_NOT_FOUND' }, 'native Node lookup cannot supply a peer from the isolated production copy');
        }
        const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
        assert.deepEqual(profile.skippedBundles, []);
        assert.equal(profile.layers.length, 1);
        assert.equal(profile.layers[0].packageName, 'dsh-afk');
        assert.equal(await realpath(profile.layers[0].packageDir), await realpath(copiedSourceDir));
        const resolution = await createRuntimeResolution({ installAnchor, profile, home });
        assert.ok(resolution.localPackageNames.includes('dsh-afk'));
        if (variant === 'external-source-link') {
          const linked = resolution.linkedRoots.find(item => item.name === 'dsh-afk');
          assert.ok(linked, 'the real resolver must recognize the out-of-profile source link');
          assert.equal(linked.realPath, await realpath(copiedSourceDir));
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
        const defaults = copiedPlugin.Config();
        assert.equal(defaults.scope.get(), 'session');
        assert.equal(defaults.global.get().enabled, false);
        assert.equal(defaults.global.get().mode, 'auto-reply');
        assert.ok(defaults.global.get().reply.trim().length > 0);
        await assert.rejects(lstat(join(copiedSourceDir, 'node_modules')), { code: 'ENOENT' }, 'real runtime interception must not install fallback links');
      } finally {
        // Dispose the only resolver owner before removing its unique fixture paths.
        await ctx.fiber.dispose();
        assert.equal(dirname(root), tmpdir());
        assert.match(basename(root), /^dsh-afk-peers-/);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
