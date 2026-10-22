import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Structural delivery checks, not a substitute for rendering the real Harness page.
const source = await readFile(process.env.DSH_TEST_PLUGIN_DIR
  ? join(process.env.DSH_TEST_PLUGIN_DIR, 'client.js') : new URL('../client.js', import.meta.url), 'utf8');
test('active switch thumb uses the contrasting base color instead of matching a monochrome track', () => {
  assert.match(source, /\.dsh-afk-switch\[aria-checked="true"\] \.dsh-afk-thumb \{[^}]*background: var\(--dsw-alias-bg-base\)/);
});
test('settings stay in bundle details while current-session history sits beside the AFK switch', () => {
  assert.match(source, /name: 'plugins\.bundle\.config', key: KEY/);
  assert.match(source, /name: 'conversation\.input\.left', id: KEY/);
  const toolbar = source.slice(source.indexOf('function Toolbar('), source.indexOf('function AfkSlot('));
  assert.match(toolbar, /h\(Switch,/);
  assert.match(toolbar, /dsh-afk-history-trigger/);
  assert.match(toolbar, /h\(HistoryDialog, \{ sessionId, view, allowed, language/);
  assert.doesNotMatch(toolbar, /SessionSettings/);
  const settings = source.slice(source.indexOf('function SessionSettings('), source.indexOf('function BoundSettings('));
  assert.doesNotMatch(settings, /QuestionHistory|HistoryRecord|\/afk history|history\.title/);
});
test('history window is non-modal, session-keyed, cancellable, and keyboard accessible', () => {
  const dialog = source.slice(source.indexOf('function HistoryDialog('), source.indexOf('function SessionSettings('));
  assert.match(dialog, /h\(QuestionHistory, \{ key: sessionId, sessionId/);
  assert.match(dialog, /showPopover\(\)/);
  assert.match(dialog, /'aria-modal': false/);
  assert.match(dialog, /event\.key === 'Escape'/);
  assert.doesNotMatch(source, /showModal\(|::backdrop|dsw-alias-bg-overlay/);
  assert.match(dialog, /previousFocus\.focus/);
  assert.doesNotMatch(dialog, /h\(['"]form|\/afk set|SessionSettings/);
  assert.match(source, /return \(\) => \{ active = false; controller\.abort\(\); \}/);
  assert.doesNotMatch(source, /setInterval\(|setTimeout\(/);
});
test('question history defaults to unread, marks explicit IDs read, and retains the All view', () => {
  const history = source.slice(source.indexOf('function QuestionHistory('), source.indexOf('function HistoryDialog('));
  assert.match(history, /useState\('unread'\)/);
  assert.match(history, /\['unread', 'all'\]/);
  assert.match(history, /\/afk read \$\{JSON\.stringify\(\[id\]\)\}/);
  assert.match(history, /onMarkRead: markRead/);
  assert.match(source, /view\?\.unread \?\? 0/);
});
test('global preferences use the shared Settings form and global access, never a session permission shortcut', () => {
  assert.match(source, /ctx\.configForms\.get\(KEY\)/);
  assert.match(source, /ctx\.configForms\.describe\(\)/);
  assert.match(source, /settingsMirror\.ensure\(\)/);
  assert.match(source, /preferencesForm\.mutate\(\[\{ op: 'set', path: \['global', 'enabled'\]/);
  assert.match(source, /useRemoteAccess\('settings\/mutate'\)/);
  assert.match(source, /function ScopeSettings\(/);
  assert.match(source, /disabled: \(!global && !view\) \|\| !writable \|\| saving/);
  assert.match(source, /baseRevision\.current/);
  assert.doesNotMatch(source, /ctx\.remote\.settings/);
});
test('rolling-upgrade fallback requires a typed legacy status proof bound to the same Settings snapshot', () => {
  assert.match(source, /execute\(sessionId, '\/afk', controller\.signal\)/);
  assert.match(source, /!Object\.hasOwn\(status, 'scope'\)/);
  assert.match(source, /typeof status\.enabled === 'boolean'/);
  assert.match(source, /legacyProof\?\.snapshot === preferences/);
  assert.match(source, /legacyProof\.epoch === epoch/);
  assert.match(source, /ctx\.on\('connection\/reset'/);
  assert.doesNotMatch(source, /ctx\.remote\.\$on\('connection\/reset'/);
  assert.match(source, /const status = await execute\(sessionId, '\/afk'/);
  assert.match(source, /if \(!stillCurrent\(\)\) return/);
  assert.match(source, /connectionSnapshot\(\) === epoch/);
  assert.match(source, /legacy \? allowed : ready &&/);
});
test('only AFK command rows get a custom presenter, and read actions rely on the projection update once', () => {
  assert.match(source, /name: 'conversation\.chat\.commandview', key: 'afk'/);
  assert.doesNotMatch(source, /name: 'conversation\.chat\.node'/);
  const mark = source.slice(source.indexOf('async function markRead('), source.indexOf('const data = history.data'));
  assert.doesNotMatch(mark, /setRefresh\(|setOffset\(/);
});
test('details retain the selected session and explicitly inject both Remote service levels', () => {
  assert.match(source, /ctx\.sessions\.retain\(sessionId, \{ source: 'controllerOperation'/);
  assert.match(source, /reference\.ready\.then/);
  assert.match(source, /reference\?\.release\(\)/);
  assert.match(source, /binding\.session\.projections\.faceOf\(KEY\)/);
  assert.match(source, /useSessionAccess\(sessionId, 'commands\/execute'\)/);
  assert.match(source, /inject: \['slots', 'locale', 'remote', 'remote\.commands', 'sessions', 'configForms'\]/);
});
