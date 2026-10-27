import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
 * The other supported Zod is an existing, installed workspace SDK provider, not
 * a constructed package. Both versions are installed by the existing matrix.
 * @param {string} hostVersion
 */
async function alternateZod(hostVersion) {
  const expected = hostVersion === '4.4.3' ? '4.6.7' : '4.4.3';
  assert.ok(hostVersion === '4.4.3' || hostVersion === '4.6.7', 'the selected Host must provide a supported Zod');
  for (const dir of [join(workspace, 'test', 'runtimes', 'alpha3'), workspace, join(workspace, 'test', 'runtimes', 'rc4-zod443')]) {
    const require = createRequire(join(dir, 'package.json'));
    let path;
    try {
      path = require.resolve('zod/package.json');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    const directory = await realpath(dirname(path));
    if (await versionOf(directory) === expected) return directory;
  }
  assert.fail(`an existing real SDK provider of Zod ${expected} is required for this test`);
}

/** Copy the selected payload's production files, never its development tree.
 * The runtime entry intentionally supplies only the required runtime files;
 * copy optional published assets whenever that payload actually contains them.
 * @param {string} sourceDir
 * @param {string} destination
 * @param {Record<string, unknown>} manifest
 */
async function copyProductionPayload(sourceDir, destination, manifest) {
  const required = ['package.json', 'index.js', 'state.js', 'config.js', 'history.js', 'client.js', 'cordis.patch.yml'];
  const published = manifest.files;
  assert.ok(Array.isArray(published));
  /** @type {Set<string>} */
  const optional = new Set();
  for (const entry of published) {
    assert.ok(typeof entry === 'string');
    if (entry === 'locale/*.json') {
      let names;
      try {
        names = await readdir(join(sourceDir, 'locale'));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) if (name.endsWith('.json')) optional.add(`locale/${name}`);
    } else {
      assert.ok(!entry.includes('*'), `unsupported production file pattern: ${entry}`);
      optional.add(entry);
    }
  }
  for (const file of new Set([...required, ...optional])) {
    assert.match(file, /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/);
    assert.ok(!file.split('/').includes('..'), 'production paths must stay inside the payload');
    const source = join(sourceDir, file);
    try {
      assert.ok((await stat(source)).isFile(), `${file} must be a file`);
    } catch (error) {
      if (!required.includes(file) && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

/**
 * A CLI's installation graph can choose a peer different from plain Node
 * lookup. Workspace SDK fixtures expose their selected peers directly.
 * @param {string} runtimeDir
 * @param {string} home
 */
async function hostProviders(runtimeDir, home) {
  const anchor = join(runtimeDir, 'package.json');
  const require = createRequire(anchor);
  const boot = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href));
  const bootVersion = (await manifestOf(require.resolve('@deepseek-ai/dsh-app-boot/package.json'))).version;
  if (process.env.DSH_TEST_RUNTIME_VERSION) assert.equal(bootVersion, process.env.DSH_TEST_RUNTIME_VERSION, 'the requested SDK release must match');
  const runtimeName = (await manifestOf(anchor)).name;
  if (runtimeName === 'dsh-afk' || (typeof runtimeName === 'string' && runtimeName.startsWith('dsh-afk-runtime-'))) {
    for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/cordis', ...peers]) {
      const direct = await realpath(join(runtimeDir, 'node_modules', name));
      const resolved = await realpath(dirname(require.resolve(`${name}/package.json`)));
      assert.equal(resolved, direct, `${name} must come from the selected SDK, not an ancestor`);
    }
  }
  const cli = runtimeName === '@deepseek-ai/dsh';
  const resolution = cli ? await boot.createRuntimeResolution({ installAnchor: anchor, home }) : undefined;
  /** @type {Map<string, string>} */
  const providers = new Map();
  for (const name of peers) {
    const entry = resolution?.entries.find(item => item.name === name && item.scope === 'installation');
    if (cli) assert.ok(entry, `the actual CLI installation closure must supply ${name}`);
    const directory = entry ? entry.packageDir : dirname(require.resolve(`${name}/package.json`));
    providers.set(name, await realpath(directory));
  }
  return { providers, bootVersion, installationEntries: resolution?.entries };
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
  const { Context } = /** @type {typeof import('@deepseek-ai/cordis')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href));
  const { createRuntimeResolution, loadProfileDirectory, PluginPackages } = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
  const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.deepEqual(profile.skippedBundles, []);
  assert.equal(profile.layers.length, 1);
  assert.equal(profile.layers[0].packageName, 'dsh-afk');
  assert.equal(await realpath(profile.layers[0].packageDir), await realpath(pluginDir));
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: join(root, 'home') });
  assert.ok(resolution.localPackageNames.includes('dsh-afk'));
  for (const name of peers) assert.ok(!resolution.localPackageNames.includes(name), `${name} is a local peer, not a direct profile dependency`);
  assert.deepEqual(resolution.linkedRoots, [], 'neither the plugin nor any local peer is a linked root');
  const ctx = new Context();
  await ctx.plugin(PluginPackages, { resolution });

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
    assert.equal(await realpath(dirname(pluginRequire.resolve(`${name}/package.json`))), await realpath(local));
    const selected = ctx.pluginPackages.packageOf(name, pluginURL);
    assert.ok(selected);
    assert.equal(await realpath(selected.dir), await realpath(local));
  }
  assert.equal((await lstat(pluginDir)).isSymbolicLink(), false);
  const localZodDir = join(profileDir, 'node_modules', 'zod');
  const localSchemaDir = join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery');
  const localTypertDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol');
  const hostZodDir = dirname(hostRequire.resolve('zod/package.json'));
  const hostSchemaDir = dirname(hostRequire.resolve('@deepseek-ai/schemastery/package.json'));
  const hostTypertDir = dirname(hostRequire.resolve('@deepseek-ai/dsh-typert-protocol/package.json'));
  const hostZodVersion = await versionOf(hostZodDir);
  const localZodVersion = await versionOf(localZodDir);
  assert.deepEqual(new Set([hostZodVersion, localZodVersion]), new Set(['4.4.3', '4.6.7']));
  if (process.env.DSH_TEST_ZOD_VERSION) assert.equal(hostZodVersion, process.env.DSH_TEST_ZOD_VERSION);

  // Test actual ESM classes, not only require.resolve (Zod and Schemastery
  // expose separate CommonJS entry points).
  const localZod = /** @type {typeof import('zod')} */ (await import(pathToFileURL(join(localZodDir, 'index.js')).href));
  const hostZod = /** @type {typeof import('zod')} */ (await import(pathToFileURL(join(hostZodDir, 'index.js')).href));
  const localSchema = /** @type {typeof import('@deepseek-ai/schemastery')} */ (await import(pathToFileURL(join(localSchemaDir, 'lib', 'index.mjs')).href));
  const hostSchema = /** @type {typeof import('@deepseek-ai/schemastery')} */ (await import(pathToFileURL(join(hostSchemaDir, 'lib', 'index.mjs')).href));
  const localTypert = /** @type {typeof import('@deepseek-ai/dsh-typert-protocol')} */ (await import(pathToFileURL(join(localTypertDir, 'lib', 'index.js')).href));
  const hostTypert = /** @type {typeof import('@deepseek-ai/dsh-typert-protocol')} */ (await import(pathToFileURL(join(hostTypertDir, 'lib', 'index.js')).href));
  const plugin = /** @type {typeof import('../index.js')} */ (await import(pluginURL));
  const state = /** @type {typeof import('../state.js')} */ (await import(pathToFileURL(join(pluginDir, 'state.js')).href));
  const history = /** @type {typeof import('../history.js')} */ (await import(pathToFileURL(join(pluginDir, 'history.js')).href));
  assert.equal(state.settingsSchema.constructor, localZod.z.ZodObject);
  assert.notEqual(state.settingsSchema.constructor, hostZod.z.ZodObject);
  assert.ok(plugin.Config instanceof localSchema.default);
  assert.ok(!(plugin.Config instanceof hostSchema.default));
  assert.equal(Object.getPrototypeOf(history.AfkHistoryService), localTypert.TypertRemoteService);
  assert.notEqual(Object.getPrototypeOf(history.AfkHistoryService), hostTypert.TypertRemoteService);

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
    assert.equal(await realpath(selected.dir), await realpath(localZodDir));
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
    const installDir = join(root, 'host-installation');
    try {
      await mkdir(pluginDir, { recursive: true });
      await mkdir(join(installDir, 'node_modules'), { recursive: true });
      const sourceManifest = await manifestOf(join(sourceDir, 'package.json'));
      assert.equal(sourceManifest.name, 'dsh-afk');
      assert.ok(typeof sourceManifest.version === 'string');
      await copyProductionPayload(sourceDir, pluginDir, sourceManifest);
      const { providers, bootVersion, installationEntries } = await hostProviders(runtimeDir, join(root, 'home'));
      const hostZod = providers.get('zod');
      assert.ok(hostZod);
      const hostZodVersion = await versionOf(hostZod);
      const alternate = await alternateZod(hostZodVersion);
      /** @type {Record<string, string>} */
      const hostDependencies = {};
      // Preserve the full selected installation table for real CLI runtimes;
      // a peer-rooted subset can pick different transitive providers.
      if (installationEntries) {
        for (const entry of installationEntries) {
          const destination = join(installDir, 'node_modules', entry.name);
          await mkdir(dirname(destination), { recursive: true });
          await symlink(entry.packageDir, destination, 'dir');
          // The SDK permits an installation entry without a package version.
          hostDependencies[entry.name] = entry.version ?? '*';
        }
      }
      /** @type {Record<string, string>} */
      const profileDependencies = { 'dsh-afk': sourceManifest.version };
      for (const name of peers) {
        const host = providers.get(name);
        assert.ok(host);
        const localSource = name === 'zod' ? alternate : host;
        const destination = join(profileDir, 'node_modules', name);
        const hostDestination = join(installDir, 'node_modules', name);
        await mkdir(dirname(destination), { recursive: true });
        await mkdir(dirname(hostDestination), { recursive: true });
        // The local copy is a profile candidate, not a link to the Host.
        await cp(localSource, destination, { recursive: true, dereference: true, filter: path => basename(path) !== 'node_modules' });
        if (installationEntries) {
          assert.equal(await realpath(hostDestination), host);
        } else {
          await symlink(host, hostDestination, 'dir');
        }
        assert.equal((await lstat(destination)).isSymbolicLink(), false);
        assert.notEqual(await realpath(destination), await realpath(host));
        hostDependencies[name] = await versionOf(host);
      }
      await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'afk-host-fixture', private: true, version: '1.0.0', dependencies: hostDependencies }));
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
      t.diagnostic(`SDK ${bootVersion}: Host Zod ${hostZodVersion}, profile Zod ${await versionOf(alternate)}; ${total[1]} child tests passed, 0 skipped`);
    } finally {
      assert.equal(dirname(root), resolve(tmpdir()));
      assert.match(basename(root), /^dsh-afk-profile-peers-/);
      await rm(root, { recursive: true, force: true });
    }
  });
}
