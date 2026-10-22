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
const summarize = vm.runInNewContext(`(${definition})`);
const messages = {
  'command.running': '正在处理…', 'command.done': '操作已完成', 'command.failed': '操作失败',
  'command.read': '已标记为已读', 'command.history': '记录：未读 {unread} 批 / 共 {total} 批',
  'command.history.total': '记录：共 {total} 批', 'command.on': '已开启', 'command.off': '已关闭',
  'scope.session': '按会话单独', 'scope.global': '全局统一',
  'mode.auto': '自动应答', 'mode.disable': '禁用 ask_user_question',
};
const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[key]);
const result = data => ({ name: 'afk', outcome: { kind: 'success', text: JSON.stringify(data) } });

test('history commands show counts without raw JSON, questions or identifiers', () => {
  const value = summarize(result({ total: 5, totalAll: 6, unread: 5, filter: 'unread', records: [{ id: 'fixture-private-id', questions: [{ question: 'fixture question body' }] }] }), t);
  assert.equal(value.state, 'success');
  assert.equal(value.text, '记录：未读 5 批 / 共 6 批');
  assert.doesNotMatch(value.text, /records|fixture|\{|\}/);
  const legacy = summarize(result({ total: 3, records: [] }), t);
  assert.equal(legacy.text, '记录：共 3 批');
});

test('read acknowledgements never print the complete accumulated read-id collection', () => {
  const value = summarize(result({ type: 'dsh-afk/read-v1', readIds: ['fixture-old-id', 'fixture-new-id'] }), t);
  assert.equal(value.text, '已标记为已读');
  assert.doesNotMatch(value.text, /readIds|fixture|2/); // Two accumulated IDs do not mean two newly read items.
});

test('status and saved settings use human-readable modes and accurate scope', () => {
  const local = summarize(result({ type: 'dsh-afk/settings-v1', settings: { enabled: true, mode: 'auto-reply', reply: 'fixture hidden reply' } }), t);
  assert.equal(local.text, '已开启 · 按会话单独 · 自动应答');
  const global = summarize(result({ scope: 'global', enabled: false, mode: 'disable-ask', reply: 'fixture hidden reply', total: 8, unread: 2 }), t);
  assert.equal(global.text, '已关闭 · 全局统一 · 禁用 ask_user_question');
  assert.doesNotMatch(local.text + global.text, /fixture|reply|enabled|false/);
});

test('pending and failed commands remain explicit and error text is bounded', () => {
  assert.equal(summarize({ outcome: null }, t).text, '正在处理…');
  const failed = summarize({ outcome: { kind: 'error', text: 'Permission denied' } }, t);
  assert.equal(failed.state, 'error');
  assert.match(failed.text, /Permission denied/);
  assert.ok(summarize({ outcome: { kind: 'error', text: 'x'.repeat(10_000) } }, t).text.length < 260);
  assert.equal(summarize({ outcome: { kind: 'error', text: '{"private":"fixture"}' } }, t).text, '操作失败');
});

test('unknown and malformed machine payloads are not dumped or trusted as counts', () => {
  for (const text of ['{"records":[', '{"private":"fixture"}', '["fixture"]', '{"totalAll":-1,"unread":2}', '{"totalAll":2,"unread":"fixture"}']) {
    const value = summarize({ outcome: { kind: 'success', text } }, t);
    assert.equal(value.text, '操作已完成');
    assert.doesNotMatch(value.text, /fixture|records|\{/);
  }
  assert.equal(summarize({ outcome: { kind: 'success', text: 'Human message' } }, t).text, 'Human message');
});
