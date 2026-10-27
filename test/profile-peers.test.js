import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.DSH_TEST_RUNTIME_DIR;
const child = process.env.DSH_AFK_PROFILE_PEERS_CHILD === '1';
const peers = ['zod', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol'];

/** @param {string} filename */
async function manifestOf(filename) {
  const value = /** @type {unknown} */ (JSON.parse(await readFile(filename, 'utf8')));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {string} directory */
async function versionOf(directory) {
  const version = (await manifestOf(join(directory, 'package.json'))).version;
  assert.ok(typeof version === 'string');
  return version;
}

/**
 * The neighboring Zod provider is the other release installed by the CI matrix:
 * the `rc2` fixture or the workspace root, whichever the selected Host is not.
 * @param {string} hostVersion
 */
async function alternateZod(hostVersion) {
  assert.ok(hostVersion === '4.4.3' || hostVersion === '4.6.7', 'the selected Host must provide a supported Zod');
  const candidate = hostVersion === '4.4.3' ? join(workspace, 'package.json') : join(workspace, 'test', 'runtimes', 'rc2', 'package.json');
  const directory = await realpath(dirname(createRequire(candidate).resolve('zod/package.json')));
  assert.notEqual(await versionOf(directory), hostVersion, `the alternate Zod provider (${directory}) must be the other release; refresh the workspace fixture installation`);
  return directory;
}

/**
 * A workspace SDK fixture exposes its selected peers directly; this test targets
 * the two maintained sources (`test/runtimes/rc2` and the workspace root).
 * @param {string} runtimeDir
 */
async function hostProviders(runtimeDir) {
  const require = createRequire(join(runtimeDir, 'package.json'));
  /** @type {Map<string, string>} */
  const providers = new Map();
  for (const name of peers) providers.set(name, await realpath(dirname(require.resolve(`${name}/package.json`))));
  return providers;
}

/**
 * This runs in a separate Node process. It installs the actual SDK's resolver
 * before importing either the plugin or the repository's unchanged suites.
 */
async function exerciseFixture() {
  assert.ok(runtime);
  const root = process.env.DSH_AFK_PROFILE_PEERS_ROOT;
  assert.ok(root);
  const profileDir = join(root, 'home', 'profiles', 'fixture');
  const installAnchor = join(root, 'host-installation', 'package.json');
  const pluginDir = join(profileDir, 'node_modules', 'dsh-afk');
  assert.equal(process.env.DSH_TEST_PLUGIN_DIR, pluginDir);
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  if (process.env.DSH_TEST_RUNTIME_VERSION) {
    const bootVersion = (await manifestOf(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'))).version;
    assert.equal(bootVersion, process.env.DSH_TEST_RUNTIME_VERSION, 'the requested SDK release must match');
  }
  const boot = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
  const { Context } = /** @type {typeof import('@deepseek-ai/cordis')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href));
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.deepEqual(profile.skippedBundles, []);
  assert.equal(profile.layers.length, 1);
  assert.equal(profile.layers[0].packageName, 'dsh-afk');
  const resolution = await boot.createRuntimeResolution({ installAnchor, profile, home: join(root, 'home') });
  assert.ok(resolution.localPackageNames.includes('dsh-afk'));
  for (const name of peers) assert.ok(!resolution.localPackageNames.includes(name), `${name} is a local peer, not a direct profile dependency`);
  assert.deepEqual(resolution.linkedRoots, [], 'neither the plugin nor any local peer is a linked root');
  const ctx = new Context();
  await ctx.plugin(boot.PluginPackages, { resolution });
  const pluginURL = pathToFileURL(join(pluginDir, 'index.js')).href;
  const pluginRequire = createRequire(pluginURL);
  const hostRequire = createRequire(installAnchor);
  for (const name of peers) {
    const local = join(profileDir, 'node_modules', name);
    const host = await realpath(dirname(hostRequire.resolve(`${name}/package.json`)));
    const entry = resolution.entries.find(item => item.name === name && item.scope === 'installation');
    assert.ok(entry, `${name} must also exist in the Host installation resolution`);
    assert.equal(await realpath(entry.packageDir), host);
    assert.equal((await lstat(local)).isSymbolicLink(), false, `${name} must be copied, not linked`);
    assert.notEqual(await realpath(local), host);
    assert.equal(await realpath(dirname(pluginRequire.resolve(`${name}/package.json`))), await realpath(local), `${name} must come from the profile copy, not the Host installation`);
    const selected = ctx.pluginPackages.packageOf(name, pluginURL);
    assert.ok(selected);
    assert.equal(await realpath(selected.dir), await realpath(local));
  }
  assert.equal((await lstat(pluginDir)).isSymbolicLink(), false);
  const hostZodVersion = await versionOf(dirname(hostRequire.resolve('zod/package.json')));
  const localZodVersion = await versionOf(join(profileDir, 'node_modules', 'zod'));
  assert.deepEqual(new Set([hostZodVersion, localZodVersion]), new Set(['4.4.3', '4.6.7']));
  if (process.env.DSH_TEST_ZOD_VERSION) assert.equal(hostZodVersion, process.env.DSH_TEST_ZOD_VERSION);
  // Test actual ESM classes, not only require.resolve (Zod and Schemastery
  // expose separate CommonJS entry points).
  const localZod = /** @type {typeof import('zod')} */ (await import(pathToFileURL(join(profileDir, 'node_modules', 'zod', 'index.js')).href));
  const localSchema = /** @type {typeof import('@deepseek-ai/schemastery')} */ (await import(pathToFileURL(join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')).href));
  const localTypert = /** @type {typeof import('@deepseek-ai/dsh-typert-protocol')} */ (await import(pathToFileURL(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js')).href));
  const plugin = /** @type {typeof import('../index.js')} */ (await import(pluginURL));
  const state = /** @type {typeof import('../state.js')} */ (await import(pathToFileURL(join(pluginDir, 'state.js')).href));
  const history = /** @type {typeof import('../history.js')} */ (await import(pathToFileURL(join(pluginDir, 'history.js')).href));
  assert.equal(state.settingsSchema.constructor, localZod.z.ZodObject);
  assert.ok(plugin.Config instanceof localSchema.default);
  assert.equal(Object.getPrototypeOf(history.AfkHistoryService), localTypert.TypertRemoteService);
  // Hold the root runner open until both imports have registered their tests.
  // Without this barrier, a fast first suite can trigger `after` before the
  // second suite is registered and accidentally test a disposed resolver.
  /** @type {() => void} */
  let releaseRegistration = () => {};
  const registrationComplete = new Promise(resolve => { releaseRegistration = () => resolve(undefined); });
  test('profile resolver remains active while both suites register', async () => {
    await registrationComplete;
    const selected = ctx.pluginPackages.packageOf('zod', pluginURL);
    assert.ok(selected);
    assert.equal(await realpath(selected.dir), await realpath(join(profileDir, 'node_modules', 'zod')));
  });
  after(async () => { await ctx.fiber.dispose(); });
  try {
    await import(new URL('./runtime.test.js', import.meta.url).href);
    await import(new URL('./history-query.test.js', import.meta.url).href);
  } finally {
    releaseRegistration();
  }
}

if (child) {
  await exerciseFixture();
} else {
  test('ordinary profile installation prefers copied local peers and retains real runtime behavior', { skip: !runtime, timeout: 90_000 }, async t => {
    assert.ok(runtime);
    const runtimeDir = resolve(runtime);
    const sourceDir = resolve(process.env.DSH_TEST_PLUGIN_DIR ?? workspace);
    const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-afk-profile-peers-'));
    const profileDir = join(root, 'home', 'profiles', 'fixture');
    const pluginDir = join(profileDir, 'node_modules', 'dsh-afk');
    const installModules = join(root, 'host-installation', 'node_modules');
    try {
      await mkdir(pluginDir, { recursive: true });
      const sourceManifest = await manifestOf(join(sourceDir, 'package.json'));
      assert.equal(sourceManifest.name, 'dsh-afk');
      assert.ok(typeof sourceManifest.version === 'string');
      for (const file of ['package.json', 'index.js', 'state.js', 'config.js', 'history.js', 'client.js', 'cordis.patch.yml']) await copyFile(join(sourceDir, file), join(pluginDir, file));
      const providers = await hostProviders(runtimeDir);
      const hostZod = providers.get('zod');
      assert.ok(hostZod);
      const hostZodVersion = await versionOf(hostZod);
      const alternate = await alternateZod(hostZodVersion);
      /** @type {Record<string, string>} */
      const hostDependencies = {};
      const profileDependencies = { 'dsh-afk': sourceManifest.version };
      for (const name of peers) {
        const host = providers.get(name);
        assert.ok(host);
        const localDestination = join(profileDir, 'node_modules', name);
        const hostDestination = join(installModules, name);
        await mkdir(dirname(localDestination), { recursive: true });
        await mkdir(dirname(hostDestination), { recursive: true });
        // The local copy is a profile candidate, not a link to the Host.
        await cp(name === 'zod' ? alternate : host, localDestination, { recursive: true, dereference: true, filter: path => basename(path) !== 'node_modules' });
        await symlink(host, hostDestination, 'dir');
        assert.equal((await lstat(localDestination)).isSymbolicLink(), false);
        assert.notEqual(await realpath(localDestination), await realpath(host));
        hostDependencies[name] = await versionOf(host);
      }
      await writeFile(join(root, 'host-installation', 'package.json'), JSON.stringify({ name: 'afk-host-fixture', private: true, version: '1.0.0', dependencies: hostDependencies }));
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'afk-profile-fixture', private: true, dependencies: profileDependencies, dsh: { profile: { bundles: ['dsh-afk'] } } }));
      await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n');
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...process.env, DSH_TEST_RUNTIME_DIR: runtimeDir, DSH_TEST_PLUGIN_DIR: pluginDir,
        DSH_AFK_PROFILE_PEERS_CHILD: '1', DSH_AFK_PROFILE_PEERS_ROOT: root };
      // A test-runner worker's inherited context would select Node's internal
      // binary event reporter instead of the child's explicitly requested TAP.
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test-reporter=tap', fileURLToPath(import.meta.url)], {
        cwd: workspace, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env,
      });
      assert.ifError(result.error);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, output);
      assert.match(result.stdout, /# Subtest: isolated installed DSH: real command\/projection\/tool\/scope pipeline/);
      assert.match(result.stdout, /# Subtest: history Remote: live paging\/filter\/session isolation/);
      const total = result.stdout.match(/^# tests (\d+)$/m);
      const passed = result.stdout.match(/^# pass (\d+)$/m);
      assert.ok(total && passed, output);
      assert.ok(Number(total[1]) >= 2, output);
      assert.equal(passed[1], total[1], output);
      for (const status of ['fail', 'cancelled', 'skipped', 'todo']) assert.match(result.stdout, new RegExp(`^# ${status} 0$`, 'm'), output);
      t.diagnostic(`Host Zod ${hostZodVersion}, profile Zod ${await versionOf(alternate)}; ${total[1]} child tests passed, 0 skipped`);
    } finally {
      assert.equal(dirname(root), resolve(tmpdir()));
      assert.match(basename(root), /^dsh-afk-profile-peers-/);
      await rm(root, { recursive: true, force: true });
    }
  });
}
