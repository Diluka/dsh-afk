import test from 'node:test';
import assert from 'node:assert/strict';
import { projection, DEFAULT_REPLY, REPLY_PREFIX, BLOCK_PREFIX, LEGACY_BLOCK_MESSAGE, REQUEST_STATE_PREFIX, MARK_READ, settingsSchema, parseQuestions, historyOf, markReadOf } from '../state.js';

const questions = [{ id: 'strategy', question: '采用哪种实现？', header: '实现方式', options: [{ label: 'A (Recommended)', description: '简单' }, { label: 'B' }], multi_select: false }];
/** @type {import('../types/afk.js').AfkSettings} */
const settings = { enabled: true, mode: 'auto-reply', reply: '我不在，请选择安全方案继续。' };
/**
 * Pure-fold fixtures intentionally omit unrelated message/header/brand fields.
 * Real Session admission is tested separately; this is the single replay-fixture boundary.
 * @param {string} type
 * @param {unknown} data
 * @param {number} seq
 * @param {number} [time]
 * @returns {import('@deepseek-ai/dsh-session').SessionEvent}
 */
const event = (type, data, seq, time = 1000 + seq) => /** @type {import('@deepseek-ai/dsh-session').SessionEvent} */ (/** @type {unknown} */ ({ type, data, seq, time }));
/** @param {number} [floor] */
const init = (floor = 0) => projection.init(
  /** @type {import('@deepseek-ai/dsh-session').SessionHeader} */ (/** @type {unknown} */ ({})),
  /** @type {import('@deepseek-ai/dsh-session').SessionLogOffset} */ (floor),
);
/** @param {import('../types/afk.js').AfkSettings} [value] */
function configured(value = settings) {
  let state = init();
  state = projection.apply(state, event('command/run', { name: 'afk', args: `set ${JSON.stringify(value)}`, commandId: 'config', source: { kind: 'user' } }, 0));
  return projection.apply(state, event('command/done', { commandId: 'config', kind: 'success', text: JSON.stringify({ type: 'dsh-afk/settings-v1', settings: value }) }, 1));
}
/** @param {import('../types/afk.js').AfkState} state @param {string} [id] @param {number} [seq] */
function call(state, id = 'q1', seq = 2) {
  return projection.apply(state, event('tool/call', { name: 'ask_user_question', callId: id, arguments: JSON.stringify({ questions }) }, seq));
}
/** @param {import('../types/afk.js').AfkState} state @param {{id?: string, seq?: number, isError?: boolean, reply?: string, tagged?: boolean}} [options] */
function result(state, { id = 'q1', seq = 3, isError = false, reply = settings.reply, tagged = true } = {}) {
  return projection.apply(state, event('tool/result', {
    message: { toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'strategy', selected: [], custom: tagged ? REPLY_PREFIX + reply : reply }] }) }] },
  }, seq));
}

test('new sessions are off and auto-reply has a safe non-authorizing default', () => {
  assert.deepEqual(init().view, { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY, total: 0, unread: 0, revision: 0 });
  assert.match(DEFAULT_REPLY, /既有授权/);
  assert.match(DEFAULT_REPLY, /等待用户/);
});

test('settings only commit after matching successful user command; reads keep the wire reference stable', () => {
  const before = init();
  const started = projection.apply(before, event('command/run', { name: 'afk', args: 'on', commandId: 'x', source: { kind: 'user' } }, 0));
  assert.equal(started.view, before.view);
  const failed = projection.apply(started, event('command/done', { commandId: 'x', kind: 'error', text: 'failed' }, 1));
  assert.equal(failed.view.enabled, false);
  const noPair = projection.apply(before, event('command/done', { commandId: 'x', kind: 'success', text: JSON.stringify({ type: 'dsh-afk/settings-v1', settings }) }, 1));
  assert.equal(noPair, before);
  const read = projection.apply(before, event('command/run', { name: 'afk', args: 'history 0 20', commandId: 'read', source: { kind: 'user' } }, 0));
  assert.equal(read, before);
  const fake = projection.apply(before, event('command/run', { name: 'afk', args: 'on', commandId: 'bad', source: { kind: 'tool' } }, 0));
  assert.equal(fake, before);
});

test('configuration validates mode, boolean and reply length without trimming the saved reply', () => {
  assert.equal(settingsSchema.safeParse({ ...settings, enabled: 'true' }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, mode: 'approve-all' }).success, false);
  for (const reply of ['', '  \n', 'x'.repeat(2001)]) assert.equal(settingsSchema.safeParse({ ...settings, reply }).success, false);
  assert.equal(settingsSchema.parse({ ...settings, reply: ' 原样\n回复 ' }).reply, ' 原样\n回复 ');
  assert.equal(configured().view.reply, settings.reply);
});

test('native question retains text/options and records the actual response, not later configuration', () => {
  let state = call(configured());
  assert.equal(state.view.total, 1);
  assert.equal(state.records[0].status, 'pending');
  state = result(state);
  assert.equal(state.records[0].status, 'auto-replied');
  assert.equal(state.records[0].reply, REPLY_PREFIX + settings.reply);
  assert.equal(state.records[0].questions[0].multiSelect, false);
  assert.deepEqual(state.records[0].questions[0].options, questions[0].options);
  state = projection.apply(state, event('command/run', { name: 'afk', args: 'set {}', commandId: 'new', source: { kind: 'user' } }, 4));
  state = projection.apply(state, event('command/done', { commandId: 'new', kind: 'success', text: JSON.stringify({ type: 'dsh-afk/settings-v1', settings: { ...settings, reply: '新的回复' } }) }, 5));
  assert.equal(state.view.reply, '新的回复');
  assert.equal(state.records[0].reply, REPLY_PREFIX + settings.reply);
  assert.deepEqual(/** @type {import('@deepseek-ai/dsh-user-questions').AskUserQuestionAnswer} */ (state.records[0].answer).answers[0].selected, []);
});

test('only an explicit AFK refusal proves a block; errors never infer intervention from local settings', () => {
  for (const text of [BLOCK_PREFIX + LEGACY_BLOCK_MESSAGE, `Error: ${BLOCK_PREFIX}${LEGACY_BLOCK_MESSAGE}`, LEGACY_BLOCK_MESSAGE, `Error: ${LEGACY_BLOCK_MESSAGE}`]) {
    let state = call(init());
    state = projection.apply(state, event('tool/result', { message: { toolCallId: 'q1', isError: true, content: [{ type: 'text', text }] } }, 3));
    assert.equal(state.records[0].status, 'blocked');
    assert.equal(state.records[0].afk, true);
    assert.equal(state.records[0].mode, 'disable-ask');
    assert.equal(state.records[0].reply, '');
    assert.equal(state.records[0].requestState, null, 'legacy logs lack request snapshots, not result evidence');
  }
  for (const value of /** @type {import('../types/afk.js').AfkSettings[]} */ ([{ ...settings, mode: 'disable-ask' }, { ...settings, enabled: false, mode: 'disable-ask' }])) {
    const ordinaryFailure = result(call(configured(value)), { isError: true, tagged: false });
    assert.equal(ordinaryFailure.records[0].afk, null);
    assert.equal(ordinaryFailure.records[0].mode, null);
    assert.equal(ordinaryFailure.records[0].status, 'failed');
  }
});

test('all normal questions are recorded while AFK is off and start unread', () => {
  const initial = init();
  const pending = call(initial);
  assert.equal(pending.view.total, 1);
  assert.equal(pending.view.unread, 1);
  assert.equal(pending.records[0].afk, null);
  assert.equal(pending.records[0].mode, null);
  assert.equal(pending.records[0].requestState, null);
  assert.equal(pending.records[0].read, false);
  const answered = result(pending, { tagged: false });
  assert.equal(answered.records[0].status, 'answered');
  assert.equal(answered.records[0].afk, false);
  assert.equal(answered.records[0].mode, null);
  assert.equal(answered.records[0].read, true);
  assert.equal(answered.view.total, 1);
  assert.equal(answered.view.unread, 0);
  assert.equal(historyOf(answered).records.length, 0);
  assert.equal(historyOf(answered, 0, 20, 'all').records[0].status, 'answered');
  const auto = result(pending);
  assert.equal(auto.records[0].status, 'auto-replied');
  assert.equal(auto.view.total, 1);
});

test('PTC start/result uses nested identities and actual reply, not the run_code parent output', () => {
  let state = configured();
  const base = { rootCallId: 'root', parentCallId: 'program', subCallId: 'program:ptc:1', name: 'ask_user_question', arguments: { questions } };
  state = projection.apply(state, event('tool/ptc-dispatch-start', base, 2));
  state = projection.apply(state, event('tool/ptc-dispatch', {
    ...base, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'strategy', selected: [], custom: REPLY_PREFIX + '真实PTC应答' }] }) }],
  }, 3));
  assert.equal(state.records[0].callId, 'program:ptc:1');
  assert.equal(state.records[0].reply, REPLY_PREFIX + '真实PTC应答');
  assert.equal(/** @type {import('@deepseek-ai/dsh-user-questions').AskUserQuestionAnswer} */ (state.records[0].answer).answers[0].custom, REPLY_PREFIX + '真实PTC应答');
});

test('failed auto replies are not reported as successful; late user replies replace pending outcome', () => {
  assert.equal(result(call(configured()), { isError: true }).records[0].status, 'failed');
  let state = call(configured());
  state = projection.apply(state, event('tool/result', { message: { toolCallId: 'q1', content: [{ type: 'text', text: '{"pending":true}' }] } }, 3));
  assert.equal(state.records[0].status, 'pending');
  state = projection.apply(state, event('user/message', { source: { kind: 'user-question-reply', callId: 'q1', outcome: 'answered' }, content: [{ type: 'text', text: '{"answers":[{"id":"strategy","selected":["B"]}]}' }] }, 4));
  assert.equal(state.records[0].status, 'answered');
  assert.equal(state.records[0].read, true);
  assert.equal(state.view.unread, 0);
  assert.deepEqual(/** @type {import('@deepseek-ai/dsh-user-questions').AskUserQuestionAnswer} */ (state.records[0].answer).answers[0].selected, ['B']);
});

test('complete native batches auto-read selections, custom text and explicit skips, independent of answer order', () => {
  const batch = [...questions, { id: 'details', question: 'Anything else?' }];
  const pending = projection.apply(init(), event('tool/call', { name: 'ask_user_question', callId: 'batch', arguments: JSON.stringify({ questions: batch }) }, 0));
  for (const answers of [
    [{ id: 'strategy', selected: ['B'] }, { id: 'details', selected: [], custom: 'Details' }],
    [{ id: 'details', selected: [] }, { id: 'strategy', selected: [] }],
  ]) {
    const entry = event('tool/result', { message: { toolCallId: 'batch', content: [{ type: 'text', text: JSON.stringify({ answers }) }] } }, 1);
    const state = projection.apply(pending, entry);
    assert.equal(state.records[0].read, true);
    assert.equal(state.view.unread, 0);
    assert.equal(state.view.revision, pending.view.revision + 1, 'answer and read publish together');
    assert.deepEqual(historyOf(state).records, []);
    assert.deepEqual(historyOf(state, 0, 20, 'all').records[0].answer, { answers });
    assert.equal(projection.apply(state, entry), state, 'repeated final results do not decrement again');
  }
});

test('incomplete, unrecognized, conflicting and AFK-tagged results never auto-read', () => {
  const pending = call(init());
  for (const value of [
    {}, 'User answered', { answers: [] },
    { answers: [{ id: 'other', selected: [] }] },
    { answers: [{ id: 'strategy', selected: [] }, { id: 'strategy', selected: [] }] },
    { answers: [{ id: 'strategy' }] },
    { answers: [{ id: 'strategy', selected: [123] }] },
    { answers: [{ id: 'strategy', selected: [], custom: null }] },
    { answers: [{ id: 'strategy', selected: [], author: 'human' }] },
    { pending: true, answers: [{ id: 'strategy', selected: [] }] },
    { answers: [{ id: 'strategy', selected: ['B'], custom: REPLY_PREFIX + 'automated but not the exact AFK output' }] },
  ]) {
    const state = projection.apply(pending, event('tool/result', { message: { toolCallId: 'q1', content: [{ type: 'text', text: JSON.stringify(value) }] } }, 3));
    assert.equal(state.records[0].read, false, JSON.stringify(value));
    assert.equal(state.view.unread, 1);
  }
  const batch = [...questions, { id: 'details', question: 'Anything else?' }];
  const two = projection.apply(init(), event('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: batch }) }, 2));
  for (const answers of [
    [{ id: 'strategy', selected: [] }],
    [{ id: 'strategy', selected: [] }, { id: 'details', selected: [], custom: REPLY_PREFIX + 'mixed automatic batch' }],
  ]) {
    const mixed = projection.apply(two, event('tool/result', { message: { toolCallId: 'q1', content: [{ type: 'text', text: JSON.stringify({ answers }) }] } }, 3));
    assert.equal(mixed.records[0].read, false);
    assert.equal(mixed.view.unread, 1);
  }
  for (const state of [result(pending), result(pending, { isError: true, tagged: false })]) {
    assert.equal(state.records[0].read, false);
    assert.equal(state.view.unread, 1);
  }
});

test('PTC auto-read uses the nested call identity, and failed or automatic answers remain unread', () => {
  const base = { rootCallId: 'root', parentCallId: 'program', subCallId: 'program:ptc:1', name: 'ask_user_question', arguments: { questions } };
  const pending = projection.apply(init(), event('tool/ptc-dispatch-start', base, 2));
  for (const [custom, isError, read] of /** @type {[string, boolean, boolean][]} */ ([['Human text', false, true], [REPLY_PREFIX + 'Automated', false, false], ['Human text', true, false]])) {
    const state = projection.apply(pending, event('tool/ptc-dispatch', {
      ...base, isError, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'strategy', selected: [], custom }] }) }],
    }, 3));
    assert.equal(state.records[0].read, read);
    assert.equal(state.view.unread, read ? 0 : 1);
  }
  assert.equal(projection.apply(pending, event('tool/result', {
    message: { toolCallId: 'program', content: [{ type: 'text', text: '{"answers":[{"id":"strategy","selected":[]}]}' }] },
  }, 3)), pending, 'the run_code parent cannot acknowledge its question sub-call');
});

test('only an admitted matching late reply auto-reads; ordinary messages and queued replies do not', () => {
  for (const callId of ['q1', 'program:ptc:1']) {
    let state = result(call(init(), callId), { id: callId, isError: true });
    const answer = { kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, questions, answers: [{ id: 'strategy', selected: ['B'] }] };
    const content = [{ type: 'text', text: JSON.stringify(answer) }];
    const source = { kind: 'user-question-reply', callId, outcome: 'answered' };
    for (const ignored of [
      event('user/message', { source: { kind: 'user' }, content }, 4),
      event('user/message', { source: { ...source, callId: 'another-session-call' }, content }, 4),
      event('user/message', { source: { ...source, outcome: 'cancelled' }, content }, 4),
      event('agent/inbox/spliced', { inserted: [{ source, content }] }, 4),
    ]) assert.equal(projection.apply(state, ignored), state);
    const invalid = projection.apply(state, event('user/message', { source, content: [{ type: 'text', text: '{}' }] }, 4));
    assert.equal(invalid.view.unread, 1, 'even a recognized source cannot auto-read an unreadable batch');
    const entry = event('user/message', { source, content }, 5);
    const revision = state.view.revision;
    state = projection.apply(state, entry);
    assert.equal(state.records[0].read, true);
    assert.equal(state.records[0].status, 'answered');
    assert.equal(state.view.unread, 0);
    assert.equal(state.view.revision, revision + 1);
    assert.deepEqual(state.records[0].answer, answer);
    state = projection.apply(state, entry);
    assert.equal(state.view.unread, 0, 'a repeated late reply cannot decrement twice');
    state = acknowledge(state, [state.records[0].id], 6);
    assert.equal(projection.apply(state, entry).view.unread, 0, 'manual and automatic receipts merge monotonically');
    assert.equal(projection.apply(init(10), entry).view.unread, 0, 'fork ignores inherited replies');
  }
});

test('automatic reads survive stale manual receipts and reconstruct from the persisted event log', () => {
  let state = call(init());
  state = call(state, 'q2', 3);
  const receipt = markReadOf(state, [state.records[1].id]);
  const log = [
    event('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions }) }, 2),
    event('tool/call', { name: 'ask_user_question', callId: 'q2', arguments: JSON.stringify({ questions }) }, 3),
    event('tool/result', { message: { toolCallId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"strategy","selected":[]}]}' }] } }, 4),
    event('command/run', { name: 'afk', args: 'read ["3:q2"]', commandId: 'stale', source: { kind: 'user' } }, 5),
    event('command/done', { commandId: 'stale', kind: 'success', text: JSON.stringify(receipt) }, 6),
    event('tool/result', { message: { toolCallId: 'q2', content: [{ type: 'text', text: '{"pending":true}' }] } }, 7),
    event('user/message', { source: { kind: 'user-question-reply', callId: 'q2', outcome: 'answered' }, content: [{ type: 'text', text: '{"answers":[{"id":"strategy","selected":["B"]}]}' }] }, 8),
  ];
  const live = log.reduce((value, entry) => projection.apply(value, entry), init());
  const restored = /** @type {import('@deepseek-ai/dsh-session').SessionEvent[]} */ (JSON.parse(JSON.stringify(log)))
    .reduce((value, entry) => projection.apply(value, entry), init());
  assert.equal(live.view.unread, 0);
  assert.deepEqual(live.records.map(record => record.read), [true, true]);
  assert.equal(historyOf(live, 0, 20, 'all').total, 2);
  assert.deepEqual(restored, live);
  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(live))), live);
});

test('replaying persisted JSON reconstructs settings and history without plugin memory', () => {
  const state = result(call(configured()));
  const checked = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(checked, state);
  assert.deepEqual(projection.wire.view(checked), state.view);
});

test('fork ignores inherited AFK authority and records while unrelated events cost no new state', () => {
  const fork = init(5);
  assert.equal(projection.apply(fork, event('tool/call', { name: 'ask_user_question', callId: 'old', arguments: JSON.stringify({ questions }) }, 3)), fork);
  assert.equal(fork.view.enabled, false);
  assert.equal(projection.apply(fork, event('assistant/message', {}, 5)), fork);
});

test('history is bounded, newest first, and every batch can be paged without altering state', () => {
  let state = configured();
  for (let index = 0; index < 55; index++) state = result(call(state, `call${index}`, index * 2 + 2), { id: `call${index}`, seq: index * 2 + 3 });
  const first = historyOf(state, 0, 20);
  const second = historyOf(state, 20, 20);
  const third = historyOf(state, 40, 20);
  assert.equal(first.total, 55);
  assert.equal(first.records[0].callId, 'call54');
  const oldest = third.records.at(-1);
  assert.ok(oldest);
  assert.equal(oldest.callId, 'call0');
  assert.equal(new Set([...first.records, ...second.records, ...third.records].map(record => record.id)).size, 55);
  assert.deepEqual(historyOf(state, 999, 20).records, []);
  assert.throws(() => historyOf(state, -1, 20));
  assert.throws(() => historyOf(state, 0, 51));
});

/** @param {import('../types/afk.js').AfkState} state @param {string[]} ids @param {number} [seq] */
function acknowledge(state, ids, seq = 100) {
  const commandId = `ack-${seq}`;
  const value = markReadOf(state, ids);
  state = projection.apply(state, event('command/run', { name: 'afk', args: `read ${JSON.stringify(ids)}`, commandId, source: { kind: 'user' } }, seq));
  return projection.apply(state, event('command/done', { commandId, kind: 'success', text: JSON.stringify(value) }, seq + 1));
}

test('read acknowledgement hides an item by default without deleting it from all history', () => {
  let state = result(call(init()));
  const id = state.records[0].id;
  const before = state;
  const value = markReadOf(state, [id]);
  assert.deepEqual(value, { type: 'dsh-afk/read-v1', readIds: [id] });
  assert.equal(state, before, 'preparing an acknowledgement is pure');
  state = acknowledge(state, [id]);
  assert.equal(state.view.total, 1);
  assert.equal(state.view.unread, 0);
  assert.equal(state.records[0].read, true);
  assert.deepEqual(historyOf(state), { total: 0, totalAll: 1, unread: 0, filter: 'unread', offset: 0, limit: 20, records: [] });
  const all = historyOf(state, 0, 20, 'all');
  assert.equal(all.total, 1);
  assert.equal(all.records[0].read, true);
  // @ts-expect-error 故意不合法：公开history参数不允许read过滤器。
  assert.throws(() => historyOf(state, 0, 20, 'read'));
  const revision = state.view.revision;
  state = acknowledge(state, [id], 102);
  assert.equal(state.view.revision, revision, 'repeated read clicks are idempotent');
});

test('invalid IDs and failed commands never partially acknowledge records', () => {
  const state = result(call(init()));
  const id = state.records[0].id;
  for (const ids of [[], [id, id], [id, 'other-session-id'], [''], Array.from({ length: 51 }, (_, i) => `id-${i}`)]) {
    assert.throws(() => markReadOf(state, ids));
  }
  let failed = projection.apply(state, event('command/run', { name: 'afk', args: `read ${JSON.stringify([id])}`, commandId: 'bad-ack', source: { kind: 'user' } }, 4));
  failed = projection.apply(failed, event('command/done', { commandId: 'bad-ack', kind: 'error', text: 'denied' }, 5));
  assert.equal(failed.view, state.view);
  assert.equal(failed.records[0].read, false);
});

test('concurrent complete read snapshots merge monotonically rather than resurrecting acknowledgements', () => {
  let state = result(call(init()));
  state = result(call(state, 'q2', 4), { id: 'q2', seq: 5 });
  const first = markReadOf(state, [state.records[0].id]);
  const second = markReadOf(state, [state.records[1].id]);
  for (const [index, value] of [first, second].entries()) {
    state = projection.apply(state, event('command/run', { name: 'afk', args: `read ${JSON.stringify(value.readIds)}`, commandId: `concurrent-${index}`, source: { kind: 'user' } }, 6 + index * 2));
    state = projection.apply(state, event('command/done', { commandId: `concurrent-${index}`, kind: 'success', text: JSON.stringify(value) }, 7 + index * 2));
  }
  assert.equal(state.view.unread, 0);
  assert.deepEqual(state.records.map(record => record.read), [true, true]);
});

test('a question acknowledged while pending stays read after its answer arrives', () => {
  let state = call(init());
  state = acknowledge(state, [state.records[0].id], 4);
  state = result(state, { seq: 6, tagged: false });
  assert.equal(state.records[0].status, 'answered');
  assert.equal(state.records[0].read, true);
  assert.equal(state.view.unread, 0);
});

test('native and PTC mark-read tools persist only final success, including spilled content', () => {
  const initial = result(call(init()));
  const value = markReadOf(initial, [initial.records[0].id]);
  let native = projection.apply(initial, event('tool/call', { name: MARK_READ, callId: 'mark-native', arguments: '{}' }, 4));
  native = projection.apply(native, event('tool/result', { message: { toolCallId: 'mark-native', content: [{ type: 'text', text: 'spilled' }] }, meta: { dshAfkRead: value } }, 5));
  assert.equal(native.view.unread, 0);
  const start = { name: MARK_READ, rootCallId: 'root', parentCallId: 'program', subCallId: 'mark-ptc', arguments: {} };
  let ptc = projection.apply(initial, event('tool/ptc-dispatch-start', start, 4));
  ptc = projection.apply(ptc, event('tool/ptc-dispatch', { ...start, isError: false, content: [], meta: { dshAfkRead: value } }, 5));
  assert.equal(ptc.view.unread, 0);
  let failed = projection.apply(initial, event('tool/call', { name: MARK_READ, callId: 'mark-failed', arguments: '{}' }, 4));
  failed = projection.apply(failed, event('tool/result', { message: { toolCallId: 'mark-failed', isError: true, content: [] }, meta: { dshAfkRead: value } }, 5));
  assert.equal(failed.view.unread, 1);
  const unpaired = projection.apply(initial, event('tool/result', { message: { toolCallId: 'not-mark-read', content: [{ type: 'text', text: JSON.stringify(value) }] } }, 4));
  assert.equal(unpaired, initial);
});

test('version-four replay backfills legacy questions and reconstructs persisted read state', () => {
  const log = [
    event('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions }) }, 0),
    event('tool/result', { message: { toolCallId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"strategy","selected":["B"]}]}' }] } }, 1),
    event('command/run', { name: 'afk', args: 'read ["0:q1"]', commandId: 'ack', source: { kind: 'user' } }, 2),
    event('command/done', { commandId: 'ack', kind: 'success', text: '{"type":"dsh-afk/read-v1","readIds":["0:q1"]}' }, 3),
    event('tool/call', { name: 'ask_user_question', callId: 'q2', arguments: JSON.stringify({ questions }) }, 4),
  ];
  const persisted = /** @type {import('@deepseek-ai/dsh-session').SessionEvent[]} */ (/** @type {unknown} */ (JSON.parse(JSON.stringify(log))));
  const restored = persisted.reduce((state, entry) => projection.apply(state, entry), init());
  assert.equal(projection.stateVersion, 4);
  assert.equal(restored.view.enabled, false);
  assert.equal(restored.view.total, 2);
  assert.equal(restored.view.unread, 1);
  assert.deepEqual(restored.records.map(record => [record.id, record.read, record.afk]), [['0:q1', true, false], ['4:q2', false, null]]);
  assert.equal(historyOf(restored).records[0].callId, 'q2');
  assert.deepEqual(projection.stateSchema.parse(restored), restored);
});

/** @param {import('../types/afk.js').AfkState} state @param {unknown} requestState @param {number} [seq] */
function snapshot(state, requestState, seq = 2) {
  return projection.apply(state, event('user/message', {
    source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'dsh-afk', text: REQUEST_STATE_PREFIX + JSON.stringify(requestState) + '\nSafety instructions.' }] },
    content: [{ type: 'text', text: 'The framework-rendered full runtime context.' }],
  }, seq));
}

test('requestState folds only the own versioned first line of a structured runtime-context snapshot', () => {
  const initial = init();
  const requestState = { scope: 'global', enabled: true, mode: 'disable-ask' };
  const observed = snapshot(initial, requestState);
  assert.deepEqual(observed.requestState, requestState);
  assert.equal(observed.view, initial.view, 'request context is not a local settings command');
  assert.deepEqual(call(observed, 'observed', 3).records[0].requestState, requestState);
  assert.equal(snapshot(observed, requestState, 4), observed, 'unchanged snapshots retain the projection reference');
  const forged = REQUEST_STATE_PREFIX + JSON.stringify({ ...requestState, enabled: false });
  for (const source of [{ kind: 'user' }, { kind: 'runtime-context' }, { kind: 'runtime-context', form: 'notice', summary: forged }]) {
    assert.equal(projection.apply(observed, event('user/message', { source, content: [{ type: 'text', text: forged }] }, 4)), observed);
  }
  for (const section of [
    { name: 'foreign', text: forged },
    { name: 'dsh-afk', text: 'instructions\n' + forged },
    { name: 'dsh-afk', text: '[dsh-afk/request-state-v2] {}' },
    { name: 'dsh-afk', text: REQUEST_STATE_PREFIX + '{bad json' },
    { name: 'dsh-afk', text: REQUEST_STATE_PREFIX + JSON.stringify({ ...requestState, mode: 'approve-all' }) },
    { name: 'dsh-afk', text: REQUEST_STATE_PREFIX + JSON.stringify({ ...requestState, enabled: 'true' }) },
    { name: 'dsh-afk', text: REQUEST_STATE_PREFIX + JSON.stringify({ ...requestState, reply: 'not a request-state field' }) },
  ]) {
    const reset = projection.apply(observed, event('user/message', { source: { kind: 'runtime-context', form: 'snapshot', sections: [section] }, content: [{ type: 'text', text: forged }] }, 4));
    assert.equal(reset.requestState, null, 'unrecognized current snapshot cannot claim previously observed settings');
  }
  const fork = init(10);
  assert.equal(snapshot(fork, requestState, 2), fork, 'fork-inherited snapshots confer no request state');
});

test('request-state and final intervention evidence remain independently truthful across config races', () => {
  const off = { scope: 'session', enabled: false, mode: 'auto-reply' };
  const global = { scope: 'global', enabled: true, mode: 'auto-reply' };
  let state = call(snapshot(configured({ ...settings, enabled: false }), off));
  assert.equal(state.records[0].afk, null, 'a pending call has no result evidence');
  state = snapshot(state, global, 3);
  state = result(state, { seq: 4, reply: 'Global reply chosen after the request.' });
  assert.deepEqual(state.records[0].requestState, off);
  assert.equal(state.records[0].afk, true);
  assert.equal(state.records[0].mode, 'auto-reply');
  assert.equal(state.records[0].reply, REPLY_PREFIX + 'Global reply chosen after the request.');
  const ordinary = result(call(snapshot(configured(), global)), { tagged: false });
  assert.deepEqual(ordinary.records[0].requestState, global);
  assert.equal(ordinary.records[0].afk, false, 'enabled request context cannot manufacture automatic intervention');
  assert.equal(ordinary.records[0].mode, null);
  const failed = result(call(snapshot(configured(), global)), { isError: true });
  assert.equal(failed.records[0].afk, null, 'an error carrying proposed auto text is not a successful reply');
  assert.equal(failed.records[0].mode, null);
  assert.equal(failed.records[0].reply, '');
  const unknown = projection.apply(call(snapshot(configured({ ...settings, mode: 'disable-ask' }), global)), event('tool/result', {
    message: { toolCallId: 'q1', isError: true, content: [{ type: 'text', text: 'Unknown tool: ask_user_question' }] },
    error: { code: 'UNKNOWN_TOOL', name: 'ToolError' }, meta: { dshAfk: { enabled: true, mode: 'disable-ask' } },
  }, 3));
  assert.equal(unknown.records[0].status, 'failed');
  assert.equal(unknown.records[0].afk, null, 'neither UNKNOWN_TOOL nor foreign metadata proves this plugin blocked it');
  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(state))), state);
});

test('malformed or duplicate-id question inputs do not crash the pure fold', () => {
  const state = configured();
  assert.equal(parseQuestions({ questions: [null] }), undefined);
  assert.equal(parseQuestions({ questions: [questions[0], questions[0]] }), undefined);
  const extended = parseQuestions({ questions: [{ ...questions[0], detail: {}, multiSelect: 'ignored extension' }] });
  assert.ok(extended);
  assert.equal(extended[0].question, questions[0].question);
  assert.equal(projection.apply(state, event('tool/call', { name: 'ask_user_question', callId: 'bad', arguments: 'not json' }, 2)), state);
});
