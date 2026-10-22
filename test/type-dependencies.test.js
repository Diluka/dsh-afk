import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const compiler = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
/** @param {string} path */
const isDeclaration = path => /\.d\.(?:ts|mts|cts)$/.test(path);
/** @param {string} path */
const isLocalFile = path => {
  const local = relative(root, path);
  return !local.startsWith('..') && !local.split(/[\\/]/).includes('node_modules');
};
/** @param {string} path */
const isLocalDeclaration = path => isDeclaration(path) && isLocalFile(path);

test('declaration imports explicitly name declarations and have no implementation back-edges or cycles', () => {
  // Check both authored paths and resolved targets with the installed compiler's
  // supported CLI, without depending on its unstable programmatic API.
  const result = spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.json'), '--traceResolution', '--pretty', 'false'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
  });
  assert.ifError(result.error);
  const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').filter(line => /error TS\d+:/.test(line)).join('\n');
  assert.equal(result.status, 0, `Compiler resolution/typecheck failed: ${diagnostics}`);
  /** @type {Map<string, Set<string>>} */
  const dependencies = new Map();
  /** @type {string | undefined} */
  let source;
  let edges = 0;
  for (const line of result.stdout.split('\n')) {
    const start = /^======== Resolving module '([^']+)' from '([^']+)'/.exec(line);
    if (start) {
      source = resolve(start[2]);
      if (isLocalDeclaration(source)) {
        assert.ok(!start[1].startsWith('.') || isDeclaration(start[1]),
          `Local declaration imports must name declaration files explicitly: ${source} -> ${start[1]}`);
        if (!dependencies.has(source)) dependencies.set(source, new Set());
      }
      continue;
    }
    const end = /^======== Module name '[^']+' was successfully resolved to '([^']+)'/.exec(line);
    if (!end || !source || !isLocalDeclaration(source)) continue;
    const target = resolve(end[1]);
    if (!isLocalFile(target)) continue;
    assert.ok(isDeclaration(target), `Declaration depends on an implementation: ${source} -> ${target}`);
    dependencies.get(source)?.add(target);
    edges++;
  }
  assert.ok(edges > 0, 'The actual compiler trace must expose local declaration dependencies');
  /** @type {Set<string>} */
  const visited = new Set();
  /** @param {string} file @param {string[]} path */
  function visit(file, path) {
    assert.ok(!path.includes(file), `Declaration dependency cycle: ${[...path, file].join(' -> ')}`);
    if (visited.has(file)) return;
    for (const target of dependencies.get(file) ?? []) visit(target, [...path, file]);
    visited.add(file);
  }
  for (const file of dependencies.keys()) visit(file, []);
});
