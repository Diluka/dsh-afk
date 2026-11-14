// Resolve one CI target per distinct DSH release: the declared `engines.dsh`
// minimum plus the npm `latest` and `next` channels. The declaration has no
// upper bound, so a newer channel release is a target to test rather than a
// reason to reject it by version number.
const { appendFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** @param {string} version */
function isVersion(version) {
  if (typeof version !== 'string' || version.length > 256) return false;
  const match = versionPattern.exec(version);
  return !!match && match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part)))
    && !(match[4] || '').split('.').some((part) => /^0\d+$/.test(part));
}

/**
 * @param {unknown} range
 * @param {{ latest?: string, next?: string } | undefined} tags
 */
function buildTargets(range, tags) {
  const minimum = typeof range === 'string' && /^>=(\S+)$/.exec(range.trim());
  if (!minimum) throw new Error('engines.dsh must declare one inclusive minimum without an upper bound');
  const candidates = [
    { label: 'minimum', version: minimum[1] },
    { label: 'latest', version: tags?.latest },
    { label: 'next', version: tags?.next },
  ];
  for (const { label, version } of candidates) {
    if (!isVersion(/** @type {string} */ (version))) {
      throw new Error(`invalid DSH ${label} version: ${String(version)}`);
    }
  }

  const seen = new Set();
  const targets = [];
  for (const { label, version } of candidates) {
    if (seen.has(/** @type {string} */ (version))) continue;
    seen.add(/** @type {string} */ (version));
    targets.push({ label, version });
  }
  return targets;
}

if (require.main === module) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const tags = JSON.parse(execFileSync('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json', '--prefer-online'], { encoding: 'utf8' }));
  const targets = buildTargets(manifest.engines?.dsh, tags);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `targets=${JSON.stringify(targets)}\n`);
  console.log('DSH test targets:', targets);
}

module.exports = { buildTargets };
