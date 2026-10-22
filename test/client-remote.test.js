import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.DSH_TEST_RUNTIME_DIR;
const load = runtime
  ? async name => import(pathToFileURL(createRequire(join(runtime, 'package.json')).resolve(name)).href)
  : undefined;

// This is not a React/DOM stand-in. Both Cordis containers, the ClientRemote
// implementation, generated namespace contribution, Host command registry, AFK
// plugin, session projection and tool execution are the installed real modules.
// Only the Connection carrier is replaced: named wire arguments are forwarded
// in memory to the public Host command entry point instead of using HTTP/auth.
test('real rc.2 ClientRemote commands namespace requires remote.commands and executes isolated AFK operations', { skip: !runtime }, async () => {
  const [
    { Context }, { default: SystemPrompt }, { default: Tools }, { default: Sessions },
    { default: Agents }, { default: Commands }, { default: Projections },
    { default: UserQuestions }, ask, { createScope }, TypertClient, GatewayClient,
    { default: commandsContribution }, afk,
  ] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'),
    load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-commands'),
    load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-user-questions'),
    load('@deepseek-ai/dsh-tool-ask-user'), load('@deepseek-ai/dsh-scope'),
    load('@deepseek-ai/dsh-typert-registry/client'), load('@deepseek-ai/dsh-api-gateway/client'),
    load('@deepseek-ai/dsh-commands/remote'),
    import(process.env.DSH_TEST_PLUGIN_DIR
      ? pathToFileURL(join(process.env.DSH_TEST_PLUGIN_DIR, 'index.js')).href
      : '../index.js'),
  ]);
  const host = new Context();
  const client = new Context();
  const hostFibers = [];
  const clientFibers = [];
  const agentScopes = [];
  const agentRegistrations = [];
  const wireCalls = [];
  const agents = new Map();
  const signal = () => new AbortController().signal;
  try {
    for (const service of [SystemPrompt, Tools, Sessions, Agents, Commands, Projections, UserQuestions]) {
      hostFibers.push(await host.plugin(service));
    }
    hostFibers.push(await host.plugin(ask));
    host.on('user-questions/request', async request => ({ answers: request.questions.map(question => ({ id: question.id, selected: ['Human choice'] })) }));
    const afkFiber = await host.plugin(afk);
    hostFibers.push(afkFiber);
    for (const id of ['afk-client-remote-a', 'afk-client-remote-b']) {
      const agent = { id, session: host.sessions.create(id) };
      const scope = createScope(host, agent);
      agentScopes.push(scope);
      agent.ctx = scope.ctx;
      agents.set(id, agent);
      agentRegistrations.push(await host.agents.register(agent));
    }
    const a = agents.get('afk-client-remote-a');
    const b = agents.get('afk-client-remote-b');

    // Passive, in-process Connection prevents event pumps, WebSockets, servers
    // or browser/auth access. This is the only substituted runtime boundary.
    const connection = {
      interactions: 'none',
      isLoopback: true,
      generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
      state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
      rpc: {
        open: async function* () { throw new Error('This unary fixture must not open streams'); },
        async call(channel, endpoint, payload, callerSignal) {
          assert.equal(channel, '/api');
          assert.equal(endpoint, 'commands/execute');
          assert.deepEqual(Object.keys(payload.args).sort(), ['agentId', 'line', 'submittedAttachments']);
          assert.deepEqual(payload.args.submittedAttachments, []);
          assert.ok(callerSignal instanceof AbortSignal);
          const { agentId, line, submittedAttachments } = payload.args;
          const agent = agents.get(agentId);
          assert.ok(agent, 'wire identity must resolve to one of this fixture’s exact sessions');
          wireCalls.push({ agentId, line });
          const value = await host.commands.execute(agent, line, submittedAttachments, callerSignal);
          return { ok: true, value };
        },
      },
      openWebSocket() { throw new Error('This fixture must not open a WebSocket'); },
      start() { throw new Error('Passive ClientRemote must not start an answering Connection'); },
    };
    clientFibers.push(await client.plugin({
      name: 'afk-client-remote-memory-connection',
      apply(ctx) { ctx.provide('connection', connection); },
    }));
    clientFibers.push(await client.plugin(TypertClient));
    clientFibers.push(await client.plugin(GatewayClient));
    clientFibers.push(await client.plugin({
      name: 'afk-client-remote-generated-commands',
      inject: ['remote', 'typert'],
      async apply(ctx) { await ctx.remote.$mount(commandsContribution); },
    }));
    assert.ok(client.get('remote.commands'), 'the real generated contribution must install its concrete child Service');

    let oldConsumer;
    clientFibers.push(await client.plugin({
      name: 'afk-client-remote-old-injection', inject: ['remote'],
      apply(ctx) { oldConsumer = ctx; },
    }));
    assert.throws(
      () => oldConsumer.remote.commands.execute(a.id, '/afk', [], signal()),
      /cannot get property "remote\.commands" without inject/,
      'injecting only the parent Remote service must reproduce the actual GUI failure',
    );
    assert.equal(wireCalls.length, 0, 'the missing namespace injection must fail before any carrier or Host write');

    let childOnlyConsumer;
    clientFibers.push(await client.plugin({
      name: 'afk-client-remote-child-only-injection', inject: ['remote.commands'],
      apply(ctx) { childOnlyConsumer = ctx; },
    }));
    assert.throws(
      () => childOnlyConsumer.remote.commands.execute(a.id, '/afk', [], signal()),
      /cannot get property "remote" without inject/,
      'a child Service dependency does not implicitly inject its parent for nested property access',
    );
    const directChildRead = await childOnlyConsumer['remote.commands'].execute(a.id, '/afk', [], signal());
    assert.equal(directChildRead.ok, true, directChildRead.error?.message);
    assert.equal(JSON.parse(directChildRead.value.result.text).enabled, false);

    let fixedConsumer;
    clientFibers.push(await client.plugin({
      // The GUI keeps ctx.remote.commands syntax, so it needs both traversed Services.
      name: 'afk-client-remote-fixed-injection', inject: ['remote', 'remote.commands'],
      apply(ctx) { fixedConsumer = ctx; },
    }));
    const remoteExecute = (agentId, line) => fixedConsumer.remote.commands.execute(agentId, line, [], signal());
    const success = async (agentId, line) => {
      const envelope = await remoteExecute(agentId, line);
      assert.equal(envelope.ok, true, envelope.error?.message);
      assert.ok(envelope.value, 'the AFK command must resolve, rather than silently returning an unknown-command miss');
      assert.equal(envelope.value.result.kind, 'success', envelope.value.result.text);
      return JSON.parse(envelope.value.result.text);
    };
    const initialA = await success(a.id, '/afk');
    const initialB = await success(b.id, '/afk');
    assert.equal(initialA.enabled, false);
    assert.equal(initialB.enabled, false);
    assert.equal(initialA.scope, 'session');
    assert.equal(initialB.scope, 'session');
    assert.equal(initialA.total, 0);
    assert.equal(initialB.total, 0);
    const ordinaryArgs = { questions: [{ id: 'off-question', question: 'An ordinary question while AFK is off?' }] };
    b.session.append('tool/call', { turn: 1, step: 0, callId: 'ordinary-off-call', name: 'ask_user_question', arguments: JSON.stringify(ordinaryArgs) });
    const ordinary = await host.tools.execute({ callId: 'ordinary-off-call', name: 'ask_user_question', arguments: ordinaryArgs, agent: b, signal: signal() });
    assert.equal(ordinary.isError, false);
    b.session.append('tool/result', { turn: 1, step: 0, message: { id: 'ordinary-off-result', role: 'tool', source: { kind: 'tool', callId: 'ordinary-off-call' }, toolCallId: 'ordinary-off-call', content: ordinary.content, isError: ordinary.isError } }, { surfaceOp: 'append' });
    const ordinaryHistory = await success(b.id, '/afk history 0 20');
    assert.equal(ordinaryHistory.total, 1);
    assert.equal(ordinaryHistory.unread, 1);
    assert.equal(ordinaryHistory.records[0].afk, false);
    assert.equal(ordinaryHistory.records[0].read, false);
    assert.equal(ordinaryHistory.records[0].status, 'answered');

    const replyA = 'Client namespace A: user away, continue within existing authority.';
    const replyB = 'Client namespace B: leave the decision for the user.';
    const setA = { enabled: true, mode: 'auto-reply', reply: replyA };
    const written = await success(a.id, `/afk set ${JSON.stringify(setA)}`);
    assert.deepEqual(written.settings, setA);
    assert.equal((await success(a.id, '/afk')).reply, replyA);
    assert.equal((await success(a.id, '/afk')).enabled, true);
    assert.equal((await success(b.id, '/afk')).enabled, false);
    assert.notEqual((await success(b.id, '/afk')).reply, replyA);

    // Populate the archive through the actual Tool and final Session events,
    // then page it using the real generated Client namespace and Host command.
    for (let index = 0; index < 3; index++) {
      const callId = `afk-client-remote-call-${index}`;
      const args = { questions: [{ id: `question-${index}`, question: `Fixture question ${index}?`, options: [{ label: 'Recommended' }, { label: 'Alternative' }] }] };
      a.session.append('tool/call', { turn: 1, step: index, callId, name: 'ask_user_question', arguments: JSON.stringify(args) });
      const outcome = await host.tools.execute({ callId, name: 'ask_user_question', arguments: args, agent: a, signal: signal() });
      assert.equal(outcome.isError, false);
      assert.deepEqual(outcome.value.answers[0].selected, []);
      assert.ok(outcome.value.answers[0].custom.endsWith(replyA));
      a.session.append('tool/result', {
        turn: 1, step: index,
        message: { id: `afk-client-remote-result-${index}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: outcome.content, isError: outcome.isError },
      }, { surfaceOp: 'append' });
    }
    const first = await success(a.id, '/afk history 0 2');
    const second = await success(a.id, '/afk history 2 2');
    assert.equal(first.total, 3);
    assert.equal(first.offset, 0);
    assert.equal(first.limit, 2);
    assert.equal(first.records.length, 2);
    assert.equal(first.records[0].questions[0].id, 'question-2');
    assert.equal(first.records[1].questions[0].id, 'question-1');
    assert.equal(first.records[0].status, 'auto-replied');
    assert.ok(first.records[0].reply.endsWith(replyA));
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0].questions[0].id, 'question-0');
    assert.equal((await success(b.id, '/afk history 0 2')).total, 1);
    const newestId = first.records[0].id;
    const ack = await success(a.id, `/afk read ${JSON.stringify([newestId])}`);
    assert.equal(ack.type, 'dsh-afk/read-v1');
    assert.deepEqual(ack.readIds, [newestId]);
    const remaining = await success(a.id, '/afk history 0 2');
    assert.equal(remaining.filter, 'unread');
    assert.equal(remaining.total, 2);
    assert.equal(remaining.totalAll, 3);
    assert.equal(remaining.unread, 2);
    assert.equal(remaining.records[0].questions[0].id, 'question-1');
    assert.equal(remaining.records.some(record => record.id === newestId), false);
    const allHistory = await success(a.id, '/afk history 0 2 all');
    assert.equal(allHistory.total, 3);
    assert.equal(allHistory.records[0].read, true);
    const afterAck = await success(a.id, '/afk');
    await success(a.id, `/afk read ${JSON.stringify([newestId])}`);
    assert.deepEqual(await success(a.id, '/afk'), afterAck, 'a repeated read click must be idempotent');
    const crossSession = await remoteExecute(b.id, `/afk read ${JSON.stringify([newestId])}`);
    assert.equal(crossSession.ok, false);
    assert.match(crossSession.error.message, /Unknown question record/);
    assert.equal((await success(b.id, '/afk')).unread, 1);
    const beforeInvalidRead = await success(a.id, '/afk');
    for (const raw of ['{}', '[]', JSON.stringify(newestId), '[42]', newestId]) {
      const invalidRead = await remoteExecute(a.id, `/afk read ${raw}`);
      assert.equal(invalidRead.ok, false, 'read accepts only a non-empty JSON string array, not a plain ID or object');
    }
    assert.deepEqual(await success(a.id, '/afk'), beforeInvalidRead);

    const beforeBadSave = await success(a.id, '/afk');
    const invalidSettings = await remoteExecute(a.id, `/afk set ${JSON.stringify({ ...setA, reply: '   ' })}`);
    assert.equal(invalidSettings.ok, true, 'a settled business failure is not a carrier failure');
    assert.equal(invalidSettings.value.result.kind, 'error');
    assert.match(invalidSettings.value.result.text, /AFK/);
    const invalidPage = await remoteExecute(a.id, '/afk history -1 20');
    assert.equal(invalidPage.ok, false, 'a thrown Host handler error is folded into the Client Remote error branch');
    assert.equal(invalidPage.error.code, 'gateway/internal');
    assert.equal(GatewayClient.isRemoteFailure(invalidPage.error), true);
    assert.match(invalidPage.error.message, /offset/);
    assert.deepEqual(await success(a.id, '/afk'), beforeBadSave, 'business failures must not mutate saved AFK settings or archive');

    await success(b.id, `/afk set ${JSON.stringify({ enabled: false, mode: 'disable-ask', reply: replyB })}`);
    assert.equal((await success(b.id, '/afk')).reply, replyB);
    assert.equal((await success(b.id, '/afk')).mode, 'disable-ask');
    assert.equal((await success(a.id, '/afk')).reply, replyA);
    assert.equal((await success(a.id, '/afk')).mode, 'auto-reply');
    await success(a.id, '/afk off');
    assert.equal((await success(a.id, '/afk')).enabled, false);
    assert.equal((await success(a.id, '/afk history 0 2')).total, 2, 'turning AFK off must not erase unread history');
    assert.equal((await success(a.id, '/afk history 0 20 all')).total, 3, 'read acknowledgements must not delete records');
    // Programmatic plugin mounting is a supported config entry point; the real
    // Loader/Settings mutation path is covered separately by scope.test.js.
    const savedA = { ...host.sessionProjections.stateOf(a.session, 'dsh-afk').view };
    const savedB = { ...host.sessionProjections.stateOf(b.session, 'dsh-afk').view };
    await afkFiber.dispose();
    const globalSettings = { enabled: true, mode: 'auto-reply', reply: 'Remote global reply, never human approval.' };
    hostFibers.push(await host.plugin(afk, { scope: 'global', global: globalSettings }));
    for (const agent of [a, b]) {
      const current = await success(agent.id, '/afk');
      assert.deepEqual({ scope: current.scope, enabled: current.enabled, mode: current.mode, reply: current.reply }, { scope: 'global', ...globalSettings });
      for (const input of ['on', 'off', `set ${JSON.stringify(setA)}`]) {
        const refused = await remoteExecute(agent.id, `/afk ${input}`);
        assert.equal(refused.ok, true, 'lack of global settings authority is a settled business error');
        assert.equal(refused.value.result.kind, 'error');
        assert.match(refused.value.result.text, /全局设置 UI/);
      }
    }
    assert.deepEqual(host.sessionProjections.stateOf(a.session, 'dsh-afk').view, savedA);
    assert.deepEqual(host.sessionProjections.stateOf(b.session, 'dsh-afk').view, savedB);
    assert.equal((await success(a.id, '/afk history 0 20 all')).totalAll, 3);
    assert.equal((await success(b.id, '/afk history')).totalAll, 1);
    const aBeforeReadB = await success(a.id, '/afk history 0 20 all');
    const bRecord = (await success(b.id, '/afk history')).records[0];
    await success(b.id, `/afk read ${JSON.stringify([bRecord.id])}`);
    assert.equal((await success(b.id, '/afk history')).unread, 0);
    assert.deepEqual(await success(a.id, '/afk history 0 20 all'), aBeforeReadB, 'global settings do not merge Session read receipts');
    const globalCall = 'remote-global-call';
    const globalArgs = { questions: [{ id: 'global-question', question: 'Global while local AFK is off?' }] };
    b.session.append('tool/call', { turn: 2, step: 0, callId: globalCall, name: 'ask_user_question', arguments: JSON.stringify(globalArgs) });
    const automatic = await host.tools.execute({ callId: globalCall, name: 'ask_user_question', arguments: globalArgs, agent: b, signal: signal() });
    assert.equal(automatic.isError, false);
    assert.ok(automatic.value.answers[0].custom.endsWith(globalSettings.reply));
    b.session.append('tool/result', { turn: 2, step: 0, message: { id: 'remote-global-result', role: 'tool', source: { kind: 'tool', callId: globalCall }, toolCallId: globalCall, content: automatic.content, isError: automatic.isError } }, { surfaceOp: 'append' });
    const globalHistory = await success(b.id, '/afk history');
    assert.equal(globalHistory.records[0].afk, true);
    assert.equal(globalHistory.records[0].mode, 'auto-reply');
    assert.equal(globalHistory.records[0].requestState, null, 'no model Loop ran in this fixture, so no request snapshot is invented');
    assert.equal((await success(a.id, '/afk history 0 20 all')).totalAll, 3);
    assert.ok(wireCalls.some(call => call.agentId === a.id));
    assert.ok(wireCalls.some(call => call.agentId === b.id));
  } finally {
    for (const fiber of clientFibers.reverse()) await fiber.dispose();
    for (const dispose of agentRegistrations.reverse()) await dispose?.();
    for (const scope of agentScopes.reverse()) await scope.dispose();
    for (const fiber of hostFibers.reverse()) await fiber.dispose();
  }
});
