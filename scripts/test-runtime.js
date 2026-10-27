import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run functional tests from a dependency-free payload, with the selected SDK's
// actual peer packages supplied by its disposable parent. Never modify an SDK
// installation or let the workspace's newest peers mask the historical runtime.
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.DSH_TEST_RUNTIME_DIR;
assert.ok(runtime, 'DSH_TEST_RUNTIME_DIR must select a real SDK installation');
const requestedRuntimeDir = resolve(runtime);
const sourceDir = resolve(process.env.DSH_TEST_PLUGIN_DIR ?? root);
const runtimeAnchor = join(requestedRuntimeDir, 'package.json');
const runtimeManifest = /** @type {{ name?: string }} */ (JSON.parse(await readFile(runtimeAnchor, 'utf8')));
const manifest = /** @type {{ peerDependencies: Record<string, string> }} */ (JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8')));
const fixture = await mkdtemp(join(resolve(tmpdir()), 'dsh-afk-functional-'));
try {
  let runtimeDir = requestedRuntimeDir;
  if (runtimeManifest.name === '@deepseek-ai/dsh') {
    // A CLI's Node lookup can select different peers from the Host's dependency
    // closure. Reproduce the actual installation resolution without a profile.
    const cliRequire = createRequire(runtimeAnchor);
    const { createRuntimeResolution } = /** @type {typeof import('@deepseek-ai/dsh-app-boot')} */ (await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-app-boot')).href));
    const resolution = await createRuntimeResolution({ installAnchor: runtimeAnchor, home: join(fixture, 'home') });
    runtimeDir = join(fixture, 'runtime');
    await mkdir(runtimeDir);
    await copyFile(runtimeAnchor, join(runtimeDir, 'package.json'));
    for (const entry of resolution.entries) {
      const destination = join(runtimeDir, 'node_modules', entry.name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(entry.packageDir, destination, 'dir');
    }
  }
  const runtimeRequire = createRequire(join(runtimeDir, 'package.json'));
  const pluginDir = join(fixture, 'plugin');
  await mkdir(pluginDir);
  for (const file of ['package.json', 'index.js', 'state.js', 'config.js', 'history.js', 'client.js', 'cordis.patch.yml']) {
    await copyFile(join(sourceDir, file), join(pluginDir, file));
  }
  for (const name of Object.keys(manifest.peerDependencies)) {
    const providerDir = await realpath(dirname(runtimeRequire.resolve(`${name}/package.json`)));
    const destination = join(fixture, 'node_modules', name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(providerDir, destination, 'dir');
  }
  const tests = (await readdir(join(root, 'test'))).filter(file => file.endsWith('.test.js')).sort();
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map(file => join(root, 'test', file))], {
    cwd: root,
    env: { ...process.env, DSH_TEST_RUNTIME_DIR: runtimeDir, DSH_TEST_PLUGIN_DIR: pluginDir },
    stdio: 'inherit',
    timeout: 180_000,
  });
  assert.ifError(result.error);
  process.exitCode = result.status ?? 1;
} finally {
  assert.equal(dirname(fixture), resolve(tmpdir()));
  assert.match(basename(fixture), /^dsh-afk-functional-/);
  await rm(fixture, { recursive: true, force: true });
}
