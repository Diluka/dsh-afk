import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';
import { buildTargets } from '../.github/resolve-dsh-matrix.cjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the declared DSH range excludes the incompatible 0.2.1 line and admits every release from rc.1 onward', () => {
  for (const version of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.3', '0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-alpha.3']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version)?.requirements['engines.dsh'], manifest.engines.dsh, version);
  }
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.3', '0.3.0-alpha.1', '0.3.0', '1.0.0-beta.1', '1.0.0', '9.0.0']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version);
  }
});

test('CI resolves the minimum and both moving channels without an upper bound', () => {
  // A future release beyond any release known today must become a target, not a rejection.
  assert.deepEqual(buildTargets('>=0.2.2-rc.1', { latest: '0.2.2-rc.3', next: '0.3.0' }), [
    { label: 'minimum', version: '0.2.2-rc.1' },
    { label: 'latest', version: '0.2.2-rc.3' },
    { label: 'next', version: '0.3.0' },
  ]);
});

test('CI deduplicates identical releases and prefers the earliest label', () => {
  assert.deepEqual(buildTargets('>=0.2.2-rc.1', { latest: '0.2.2-rc.1', next: '0.2.2-rc.1' }), [
    { label: 'minimum', version: '0.2.2-rc.1' },
  ]);
  assert.deepEqual(buildTargets('>=0.2.2-rc.1', { latest: '0.2.2-rc.1', next: '0.2.2-rc.3' }), [
    { label: 'minimum', version: '0.2.2-rc.1' },
    { label: 'next', version: '0.2.2-rc.3' },
  ]);
});

test('CI rejects a bounded or malformed declaration and invalid channel versions', () => {
  const tags = { latest: '0.2.2-rc.1', next: '0.2.2-rc.3' };
  for (const invalid of ['', '0.2.2-rc.1', '>=0.2.2-rc.1 <=0.2.2-rc.3', '^0.2.2-rc.1', '>=nope']) {
    assert.throws(() => buildTargets(invalid, tags), /engines\.dsh|invalid DSH minimum version/, invalid);
  }
  assert.throws(() => buildTargets('>=0.2.2-rc.1', { latest: '0.2.2-rc.1', next: 'not-a-version' }), /invalid DSH next version/);
  assert.throws(() => buildTargets('>=0.2.2-rc.1', { next: '0.2.2-rc.3' }), /invalid DSH latest version/);
});

test('every checked-in installation pins one release, and the minimum and newest shared ones are present', async () => {
  /** @param {string} directory */
  const releaseOf = async (directory) => JSON.parse(await readFile(new URL(`${directory}/node_modules/@deepseek-ai/dsh-app-boot/package.json`, import.meta.url), 'utf8')).version;
  const minimum = manifest.engines.dsh.slice(2);
  // Development dependencies track the newest tested release; the fixtures
  // supply every other release CI may select, so a target never falls back to
  // a nearby installation. Every fixture must pin exactly one release.
  const bootVersion = await releaseOf('../');
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-app-boot'], bootVersion);
  assert.equal(new Set(Object.values(manifest.devDependencies).filter(version => /^0\.\d/.test(version))).size, 1, 'all DSH development pins must share one release');
  const installations = new Map([[minimum, await releaseOf('../test/fixtures/runtime-min')], [bootVersion, bootVersion]]);
  for (const fixture of ['runtime-next']) {
    const fixtureManifest = JSON.parse(await readFile(new URL(`../test/fixtures/${fixture}/package.json`, import.meta.url), 'utf8'));
    const fixtureVersions = new Set(Object.values(fixtureManifest.dependencies).filter(version => /^0\.\d/.test(version)));
    assert.equal(fixtureVersions.size, 1, `${fixture} must pin exactly one DSH release`);
    installations.set([...fixtureVersions][0], await releaseOf(`../test/fixtures/${fixture}`));
  }
  // The installation the minimum target selects must pin the minimum itself.
  assert.equal(installations.get(minimum), minimum, 'the declared minimum needs an installation pinned to it');
});
