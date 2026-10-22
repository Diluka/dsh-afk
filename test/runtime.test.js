import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPLY_PREFIX, BLOCK_PREFIX, REQUEST_STATE_PREFIX } from '../state.js';
const afk = await import(process.env.DSH_TEST_PLUGIN_DIR
  ? pathToFileURL(join(process.env.DSH_TEST_PLUGIN_DIR, 'index.js')).href : '../index.js');

const runtime = process.env.DSH_TEST_RUNTIME_DIR;
const load = runtime ? async name => import(pathToFileURL(createRequire(join(runtime, 'package.json')).resolve(name))) : undefined;

test('isolated installed DSH: real command/projection/tool/scope pipeline, custom replies, policy and disposal', { skip: !runtime }, async () => {
  const [{ Context }, { default: SystemPrompt }, { default: Tools }, { default: Sessions, Session }, { default: Agents }, { default: Commands }, { default: Projections }, { default: UserQuestions }, ask, { createScope, bindScopeParent }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-commands'),
    load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-user-questions'), load('@deepseek-ai/dsh-tool-ask-user'), load('@deepseek-ai/dsh-scope'),
  ]);
  const ctx = new Context();
  const fibers = [];
  const scopes = [];
  const registers = [];
  try {
    for (const service of [SystemPrompt, Tools, Sessions, Agents, Commands, Projections, UserQuestions]) fibers.push(await ctx.plugin(service));
    let humanRequests = 0;
    ctx.on('user-questions/request', async request => {
      humanRequests++;
      return { answers: request.questions.map(question => ({ id: question.id, selected: ['Human choice'] })) };
    });
    const presetKey = {};
    const preset = createScope(ctx, presetKey);
    scopes.push(preset);
    const legacyAsk = await preset.ctx.plugin(ask);
    const agent = { id: 'afk-runtime-fixture', session: ctx.sessions.create('afk-runtime-fixture') };
    bindScopeParent(agent, presetKey);
    const scope = createScope(ctx, agent);
    scopes.push(scope);
    agent.ctx = scope.ctx;
    registers.push(await ctx.agents.register(agent));
    const fiber = await ctx.plugin(afk); // Also verifies attaching to an already-existing agent.
    fibers.push(fiber);
    const config = async settings => {
      const value = await ctx.commands.execute(agent, `/afk set ${JSON.stringify(settings)}`, [], new AbortController().signal);
      assert.equal(value.result.kind, 'success', value.result.text);
      return ctx.sessionProjections.stateOf(agent.session, 'dsh-afk');
    };
    const questions = [{ id: 'choice', question: 'Which option?', options: [{ label: 'Recommended' }, { label: 'Human choice' }] }];
    let seq = 0;
    const execute = async (name = 'ask_user_question', args = { questions }, callerSignal = new AbortController().signal) => {
      const callId = `fixture-call-${++seq}`;
      agent.session.append('tool/call', { turn: 1, step: seq, callId, name, arguments: JSON.stringify(args) });
      const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: callerSignal });
      agent.session.append('tool/result', {
        turn: 1, step: seq,
        message: { id: `fixture-result-${seq}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: result.content, isError: result.isError },
        ...(result.meta !== undefined ? { meta: result.meta } : {}), ...(result.error?.info ? { error: result.error.info } : {}),
      }, { surfaceOp: 'append' });
      return result;
    };
    assert.equal(ctx.sessionProjections.stateOf(agent.session, 'dsh-afk').view.enabled, false);
    const offContext = (await ctx.systemPrompt.assemble({ scope: agent })).contexts.find(context => context.name === 'dsh-afk');
    assert.equal(offContext.interpolate, false);
    assert.deepEqual(JSON.parse(offContext.text.slice(REQUEST_STATE_PREFIX.length)), { scope: 'session', enabled: false, mode: 'auto-reply' });
    const effective = await ctx.commands.execute(agent, '/afk', [], new AbortController().signal);
    assert.equal(JSON.parse(effective.result.text).scope, 'session');
    assert.equal((await execute()).isError, false);
    assert.equal(humanRequests, 1);
    const reply = 'AFK fixture reply: proceed safely, not an approval.';
    await config({ enabled: true, mode: 'auto-reply', reply });
    const automatic = await execute();
    assert.equal(automatic.isError, false);
    assert.deepEqual(automatic.value, { answers: [{ id: 'choice', selected: [], custom: REPLY_PREFIX + reply }] });
    assert.equal(humanRequests, 1);
    const state = ctx.sessionProjections.stateOf(agent.session, 'dsh-afk');
    assert.equal(state.records[0].status, 'answered');
    assert.equal(state.records[0].afk, false);
    assert.equal(state.records[0].read, false);
    assert.equal(state.records[1].status, 'auto-replied');
    assert.equal(state.records[1].reply, REPLY_PREFIX + reply);
    assert.equal(state.view.unread, 2);
    const read = await execute('afk_history', {});
    assert.equal(read.isError, false);
    assert.equal(read.value.records[0].reply, REPLY_PREFIX + reply);
    assert.deepEqual(ctx.tools.schemas(agent).filter(tool => /^afk_/.test(tool.name)).map(tool => tool.name).sort(), ['afk_history', 'afk_mark_read']);
    const cancelledBefore = new AbortController();
    cancelledBefore.abort();
    assert.equal((await execute('afk_mark_read', { recordIds: [read.value.records[0].id] }, cancelledBefore.signal)).isError, true);
    assert.equal(ctx.sessionProjections.stateOf(agent.session, 'dsh-afk').view.unread, 2);
    const cancelledAfter = new AbortController();
    const stopCancel = ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name === 'afk_mark_read' && exec.signal === cancelledAfter.signal) cancelledAfter.abort();
      return next();
    });
    assert.equal((await execute('afk_mark_read', { recordIds: [read.value.records[0].id] }, cancelledAfter.signal)).isError, true);
    stopCancel();
    assert.equal(ctx.sessionProjections.stateOf(agent.session, 'dsh-afk').view.unread, 2, 'a cancelled success cannot persist its proposed read receipt');
    const stopReadBlock = ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'afk_mark_read'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'fixture policy refuses read acknowledgement' }] } : next());
    assert.equal((await execute('afk_mark_read', { recordIds: [read.value.records[0].id] })).isError, true);
    stopReadBlock();
    assert.equal(ctx.sessionProjections.stateOf(agent.session, 'dsh-afk').view.unread, 2, 'a post-policy failure does not persist definition-owned success metadata');
    const marked = await execute('afk_mark_read', { recordIds: [read.value.records[0].id] });
    assert.equal(marked.isError, false);
    assert.equal(marked.meta.dshAfkRead.type, 'dsh-afk/read-v1');
    assert.equal((await execute('afk_mark_read', { ids: [read.value.records[0].id] })).isError, true, 'recordIds is the required public parameter name');
    assert.equal((await execute('afk_mark_read', { recordIds: [read.value.records[0].id], unexpected: true })).isError, true, 'unknown input fields are rejected');
    const unread = await execute('afk_history', {});
    assert.equal(unread.value.total, 1);
    assert.equal(unread.value.totalAll, 2);
    assert.equal(unread.value.records[0].afk, false);
    const all = await execute('afk_history', { filter: 'all' });
    assert.equal(all.value.total, 2);
    assert.equal(all.value.records[0].read, true);
    const replay = Session.create('afk-runtime-replay', agent.session.snapshotEvents());
    const replayState = ctx.sessionProjections.stateOf(replay, 'dsh-afk');
    assert.equal(replayState.view.unread, 1);
    assert.equal(replayState.records[1].read, true);
    // AFK cannot override a pre-existing monotonic denial.
    const removeGuard = ctx.tools.guard(exec => exec.name === 'ask_user_question' ? 'fixture policy denies ask' : undefined);
    assert.equal((await execute()).isError, true);
    const denied = ctx.sessionProjections.stateOf(agent.session, 'dsh-afk').records.at(-1);
    assert.equal(denied.status, 'failed');
    assert.equal(denied.afk, null, 'a foreign denial is not evidence that AFK intervened');
    assert.equal(denied.mode, null);
    removeGuard();
    const changes = [];
    const stopChanges = ctx.sessionProjections.onChanged((session, key, value) => { if (key === 'dsh-afk') changes.push([session.id, value.enabled, value.mode]); });
    const disabledState = await config({ enabled: true, mode: 'disable-ask', reply });
    stopChanges();
    assert.deepEqual(changes.at(-1), [agent.id, true, 'disable-ask']);
    assert.equal(disabledState.view.mode, 'disable-ask');
    assert.equal(disabledState.view.enabled, true);
    assert.equal(ctx.tools.get('ask_user_question', agent) === undefined, true);
    assert.equal(ctx.tools.schemas(agent).some(tool => tool.name === 'ask_user_question'), false);
    const blocked = await execute();
    assert.equal(blocked.isError, true);
    assert.ok(blocked.content[0].text.includes(BLOCK_PREFIX));
    const blockedRecord = ctx.sessionProjections.stateOf(agent.session, 'dsh-afk').records.at(-1);
    assert.equal(blockedRecord.status, 'blocked');
    assert.equal(blockedRecord.afk, true);
    assert.equal(blockedRecord.mode, 'disable-ask');
    assert.equal(blockedRecord.requestState, null, 'without a Loop snapshot the observed request state is unknown');
    assert.equal(humanRequests, 1);
    const prompt = await ctx.systemPrompt.assemble({ scope: agent });
    assert.match(prompt.contexts.find(context => context.name === 'dsh-afk').text, /never grants permission/);
    await config({ enabled: false, mode: 'disable-ask', reply });
    assert.ok(ctx.tools.get('ask_user_question', agent));
    await execute();
    assert.equal(humanRequests, 2);
    await legacyAsk.dispose();
    await preset.ctx.plugin(ask, { mode: 'timed', timeout: 120 });
    await config({ enabled: true, mode: 'auto-reply', reply: '新的自动回复' });
    const timed = await execute();
    assert.equal(timed.isError, false);
    assert.equal(timed.value.answers[0].custom, REPLY_PREFIX + '新的自动回复');
    assert.equal(humanRequests, 2, 'timed ask must not reach the human answerer');
    for (const timeout of ['bad', 0, -2, 2147484, 1.5, null]) {
      assert.equal((await execute('ask_user_question', { questions, timeout })).isError, true);
    }
    assert.equal((await execute('ask_user_question', { questions, timeout: -1 })).isError, false);
    const extended = await execute('ask_user_question', { questions: [{ ...questions[0], detail: {}, multiSelect: 'ignored extension' }] });
    assert.equal(extended.isError, false, 'native ask allows arbitrary unknown extension fields');
    const invalid = await execute('ask_user_question', { questions: [questions[0], questions[0]] });
    assert.equal(invalid.isError, true);
    assert.equal(humanRequests, 2, 'invalid AFK batches must fail instead of waiting for the absent user');
    const planAnswer = await ctx.userQuestions.ask({ agent, questions: [{ id: 'plan-review', question: 'Approve plan?', detail: 'Fixture plan', options: [{ label: 'Approve' }], intent: { kind: 'plan-review', approve: 'Approve' } }] });
    assert.equal(humanRequests, 3, 'plan review must still reach the human answerer');
    assert.notEqual(planAnswer.answers[0].custom, REPLY_PREFIX + '新的自动回复');
    // A newly-created independent session starts off and cannot inherit the other session’s AFK state.
    const other = { id: 'afk-runtime-other', session: ctx.sessions.create('afk-runtime-other') };
    const otherScope = createScope(ctx, other, { parent: presetKey });
    scopes.push(otherScope);
    other.ctx = otherScope.ctx;
    registers.push(await ctx.agents.register(other));
    assert.equal(ctx.sessionProjections.stateOf(other.session, 'dsh-afk').view.enabled, false);
    assert.ok(ctx.tools.get('ask_user_question', other));
    await config({ enabled: true, mode: 'disable-ask', reply });
    await fiber.dispose();
    assert.ok(ctx.tools.get('ask_user_question', agent), 'unload must lift the agent restriction');
    assert.equal(ctx.sessionProjections.stateOf(agent.session, 'dsh-afk'), undefined);
    assert.equal(ctx.commands.find(agent, 'afk'), undefined);
    assert.equal(ctx.tools.get('afk_history', agent), undefined);
    assert.equal(ctx.tools.get('afk_mark_read', agent), undefined);
  } finally {
    for (const dispose of registers.reverse()) await dispose?.();
    for (const scope of scopes.reverse()) await scope.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});
