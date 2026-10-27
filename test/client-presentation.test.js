import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';

// Exercise the production pure formatter inside the unbuilt Client factory.
// This is not a React/GUI test and does not replace the real page verification.
const source = await readFile(process.env.DSH_TEST_PLUGIN_DIR
  ? join(process.env.DSH_TEST_PLUGIN_DIR, 'client.js') : new URL('../client.js', import.meta.url), 'utf8');
const definition = source.match(/^    function commandSummary\(node, t\) \{[\s\S]*?^    \}/m)?.[0];
assert.ok(definition, 'The production command formatter must remain testable');
// The VM evaluates only this pure formatter; assert the smallest consumed signature.
const summarize = /** @type {import('../types/test.js').Formatter} */ (/** @type {unknown} */ (vm.runInNewContext(`(${definition})`)));
/** @type {Record<string, string>} */
const messages = {
  'command.running': '正在处理…', 'command.done': '操作已完成', 'command.failed': '操作失败',
  'command.read': '已标记为已读', 'command.history': '记录：未读 {unread} 批 / 共 {total} 批',
  'command.on': '已开启', 'command.off': '已关闭',
  'scope.session': '按会话单独', 'scope.global': '全局统一',
  'mode.auto': '自动应答', 'mode.disable': '禁用 ask_user_question',
};
/** @type {import('../types/test.js').FormatterTranslate} */
const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[key]);
/** @param {unknown} data */
const result = data => ({ name: 'afk', outcome: { kind: 'success', text: JSON.stringify(data) } });

test('successful history queries stay hidden with the current page shape only', () => {
  const value = summarize(result({ total: 5, totalAll: 6, unread: 5, offset: 0, limit: 20, filter: 'unread',
    records: [{ id: 'fixture-private-id', questions: [{ question: 'fixture question body' }] }] }), t);
  assert.equal(value.state, 'success');
  assert.equal(value.hidden, true);
  assert.equal(value.text, '记录：未读 5 批 / 共 6 批');
  assert.doesNotMatch(value.text, /records|fixture|\{|\}/);
  // An older machine shape is no longer interpreted; without arguments it renders a generic completion.
  const oldShape = summarize(result({ total: 3, records: [] }), t);
  assert.equal(oldShape.text, '操作已完成');
  assert.equal(oldShape.hidden, undefined);
  // A historical command log without arguments stays hidden even before/after its outcome shape changes.
  const logged = summarize({ ...result({ total: 3, records: [] }), args: 'history 0 20' }, t);
  assert.equal(logged.hidden, true);
  assert.equal(logged.text, '');
});

test('history requests hide pending and successful receipts but never failures or mutating commands', () => {
  for (const args of ['history', ' history 0 20 unread ', 'history\t20\t20\tall']) {
    const pending = summarize({ name: 'afk', args, outcome: null }, t);
    assert.equal(pending.hidden, true, args);
    const success = summarize({ ...result({ total: 0, totalAll: 1, unread: 0, offset: 0, limit: 20, filter: 'unread', records: [] }), args }, t);
    assert.equal(success.hidden, true, args);
    const failed = summarize({ name: 'afk', args, outcome: { kind: 'error', text: 'Permission denied' } }, t);
    assert.notEqual(failed.hidden, true);
    assert.equal(failed.state, 'error');
    assert.match(failed.text, /Permission denied/);
  }
  for (const args of ['read ["fixture-id"]', 'on', 'off', 'set {"enabled":true}', 'history-other']) {
    assert.notEqual(summarize({ name: 'afk', args, outcome: null }, t).hidden, true, args);
  }
  assert.notEqual(summarize({ name: 'other', args: 'history', outcome: null }, t).hidden, true);
  const receipt = summarize({ ...result({ type: 'dsh-afk/read-v1', readIds: ['fixture-id'] }), args: 'read ["fixture-id"]' }, t);
  assert.notEqual(receipt.hidden, true);
  const settings = summarize({ ...result({ type: 'dsh-afk/settings-v1', settings: { enabled: true, mode: 'auto-reply' } }), args: 'on' }, t);
  assert.notEqual(settings.hidden, true);
});

test('read acknowledgements never print the complete accumulated read-id collection', () => {
  const value = summarize(result({ type: 'dsh-afk/read-v1', readIds: ['fixture-old-id', 'fixture-new-id'] }), t);
  assert.equal(value.text, '已标记为已读');
  assert.doesNotMatch(value.text, /readIds|fixture|2/); // Two accumulated IDs do not mean two newly read items.
});

test('status and session receipts use human-readable modes and their enforced scope', () => {
  const local = summarize(result({ type: 'dsh-afk/settings-v1', settings: { enabled: true, mode: 'auto-reply', reply: 'fixture hidden reply' } }), t);
  assert.equal(local.text, '已开启 · 按会话单独 · 自动应答');
  // The session command receipt always means the session, regardless of any invented payload scope.
  const forged = summarize(result({ type: 'dsh-afk/settings-v1', scope: 'global', settings: { enabled: false, mode: 'disable-ask' } }), t);
  assert.equal(forged.text, '已关闭 · 按会话单独 · 禁用 ask_user_question');
  const global = summarize(result({ scope: 'global', enabled: false, mode: 'disable-ask', reply: 'fixture hidden reply', total: 8, unread: 2, revision: 4 }), t);
  assert.equal(global.text, '已关闭 · 全局统一 · 禁用 ask_user_question');
  assert.doesNotMatch(local.text + forged.text + global.text, /fixture|reply|enabled|false/);
  // The previous settings shape had no type and no scope; it is not a status view any more.
  const oldShape = summarize(result({ enabled: true, mode: 'auto-reply', reply: 'fixture hidden reply' }), t);
  assert.equal(oldShape.text, '操作已完成');
});

test('pending and failed commands remain explicit and error text is bounded', () => {
  assert.equal(summarize({ outcome: null }, t).text, '正在处理…');
  const failed = summarize({ outcome: { kind: 'error', text: 'Permission denied' } }, t);
  assert.equal(failed.state, 'error');
  assert.match(failed.text, /Permission denied/);
  assert.ok(summarize({ outcome: { kind: 'error', text: 'x'.repeat(10_000) } }, t).text.length < 260);
  assert.equal(summarize({ outcome: { kind: 'error', text: '{"private":"fixture"}' } }, t).text, '操作失败');
});

test('unknown, malformed and plain-text payloads become the generic completion without dumping JSON', () => {
  for (const text of ['{"records":[', '{"private":"fixture"}', '["fixture"]', '{"totalAll":-1,"unread":2}',
    '{"totalAll":2,"unread":"fixture"}', 'Human message', 'false', 'null', '']) {
    const value = summarize({ outcome: { kind: 'success', text } }, t);
    assert.equal(value.text, '操作已完成');
    assert.doesNotMatch(value.text, /fixture|records|Human|\{/);
  }
});
