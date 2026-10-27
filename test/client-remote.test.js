import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.DSH_TEST_RUNTIME_DIR;
/** @type {import('../types/test.js').RuntimeLoader} */
const load = async name => {
  assert.ok(runtime, 'Only non-skipped real-runtime tests load SDK modules');
  return import(pathToFileURL(createRequire(join(runtime, 'package.json')).resolve(name)).href);
};

// Both Cordis containers, ClientRemote, the generated commands namespace and the
// AFK Host plugin are the installed real modules. Only the Connection carrier is
// replaced: named wire arguments are forwarded in memory to the public Host
// command entry point instead of using HTTP/auth. AFK business flows themselves
// are covered by scope.test.js and runtime.test.js.
test('real ClientRemote commands namespace requires remote.commands and carries AFK commands over the generated wire', { skip: !runtime }, async () => {
  const [
    { Context }, { default: SystemPrompt }, { default: Tools }, { default: Sessions },
    { default: Agents }, { default: Commands }, { default: Projections },
    { createScope }, TypertClient, GatewayClient, { default: commandsContribution }, afk,
    { default: TypertHost },
  ] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-commands'),
    load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-scope'),
    load('@deepseek-ai/dsh-typert-registry/client'), load('@deepseek-ai/dsh-api-gateway/client'),
    load('@deepseek-ai/dsh-commands/remote'),
    /** @type {Promise<typeof import('../index.js')>} */ (import(process.env.DSH_TEST_PLUGIN_DIR
      ? pathToFileURL(join(process.env.DSH_TEST_PLUGIN_DIR, 'index.js')).href
      : '../index.js')),
    load('@deepseek-ai/dsh-typert-registry'),
  ]);
  const hostContext = new Context();
  // The same program loads Client typings, but this Context owns a real Host SessionStore.
  const host = /** @type {import('../types/test.js').FixtureHostContext} */ (/** @type {unknown} */ (hostContext));
  const client = new Context();
  /** @type {import('../types/test.js').RuntimeFiber[]} */
  const fibers = [];
  /** @type {{agentId: string, line: string}[]} */
  const wireCalls = [];
  const signal = () => new AbortController().signal;
  try {
    for (const service of [TypertHost, SystemPrompt, Tools, Sessions, Agents, Commands, Projections]) {
      fibers.push(await host.plugin(service));
    }
    fibers.push(await host.plugin(afk));
    const agent = /** @type {import('../types/test.js').FixtureAgent} */ (/** @type {unknown} */ ({
      id: 'afk-client-remote-a',
      session: host.sessions.create(/** @type {import('@deepseek-ai/dsh-session').SessionId} */ ('afk-client-remote-a')),
    }));
    const agentScope = createScope(hostContext, agent);
    agent.ctx = agentScope.ctx;
    const registration = await host.agents.register(agent);
    try {
      // Passive, in-process Connection prevents event pumps, WebSockets, servers
      // or browser/auth access. This is the only substituted runtime boundary.
      const connection = {
        interactions: 'none',
        isLoopback: true,
        generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
        state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
        rpc: {
          open: async function* () { throw new Error('This unary fixture must not open streams'); },
          /** @param {string} channel @param {string} endpoint @param {import('../types/test.js').CommandCarrierArgs} payload @param {AbortSignal} callerSignal */
          async call(channel, endpoint, payload, callerSignal) {
            assert.equal(channel, '/api');
            assert.equal(endpoint, 'commands/execute');
            assert.deepEqual(Object.keys(payload.args).sort(), ['agentId', 'line', 'submittedAttachments']);
            assert.deepEqual(payload.args.submittedAttachments, []);
            assert.ok(callerSignal instanceof AbortSignal);
            const { agentId, line, submittedAttachments } = payload.args;
            assert.equal(agentId, agent.id, 'wire identity must resolve to this fixture’s exact Session');
            wireCalls.push({ agentId, line });
            return { ok: true, value: await host.commands.execute(agent, line, submittedAttachments, callerSignal) };
          },
        },
        openWebSocket() { throw new Error('This fixture must not open a WebSocket'); },
        start() { throw new Error('Passive ClientRemote must not start an answering Connection'); },
      };
      fibers.push(await client.plugin({ name: 'afk-client-remote-memory-connection', apply(ctx) { ctx.provide('connection', connection); } }));
      fibers.push(await client.plugin(TypertClient));
      fibers.push(await client.plugin(GatewayClient));
      fibers.push(await client.plugin({
        name: 'afk-client-remote-generated-commands',
        inject: ['remote', 'typert'],
        async apply(ctx) { await ctx.remote.$mount(commandsContribution); },
      }));
      assert.ok(client.get('remote.commands'), 'the real generated contribution must install its concrete child Service');

      /** @type {import('@deepseek-ai/cordis').Context | undefined} */
      let oldConsumer;
      fibers.push(await client.plugin({
        name: 'afk-client-remote-old-injection', inject: ['remote'],
        apply(ctx) { oldConsumer = ctx; },
      }));
      assert.throws(
        () => { assert.ok(oldConsumer); return oldConsumer.remote.commands.execute(agent.id, '/afk', [], signal()); },
        /cannot get property "remote\.commands" without inject/,
        'injecting only the parent Remote service must reproduce the actual GUI failure',
      );
      assert.equal(wireCalls.length, 0, 'the missing namespace injection must fail before any carrier or Host write');

      /** @type {import('@deepseek-ai/cordis').Context | undefined} */
      let childOnlyConsumer;
      fibers.push(await client.plugin({
        name: 'afk-client-remote-child-only-injection', inject: ['remote.commands'],
        apply(ctx) { childOnlyConsumer = ctx; },
      }));
      assert.throws(
        () => { assert.ok(childOnlyConsumer); return childOnlyConsumer.remote.commands.execute(agent.id, '/afk', [], signal()); },
        /cannot get property "remote" without inject/,
        'a child Service dependency does not implicitly inject its parent for nested property access',
      );
      assert.ok(childOnlyConsumer);
      // Generated namespaces also expose a concrete dotted child Service; its method contract is the generated remote.commands interface.
      const childContext = /** @type {import('@deepseek-ai/cordis').Context & {'remote.commands': import('@deepseek-ai/cordis').Context['remote']['commands']}} */ (childOnlyConsumer);
      const directChildRead = await childContext['remote.commands'].execute(agent.id, '/afk', [], signal());
      assert.equal(directChildRead.ok, true, directChildRead.ok ? undefined : directChildRead.error.message);
      assert.ok(directChildRead.value);
      assert.equal(JSON.parse(/** @type {string} */ (directChildRead.value.result.text)).enabled, false);

      /** @type {import('@deepseek-ai/cordis').Context | undefined} */
      let fixedConsumer;
      fibers.push(await client.plugin({
        // The GUI keeps ctx.remote.commands syntax, so it needs both traversed Services.
        name: 'afk-client-remote-fixed-injection', inject: ['remote', 'remote.commands'],
        apply(ctx) { fixedConsumer = ctx; },
      }));
      /** @param {string} line */
      const remoteExecute = line => {
        assert.ok(fixedConsumer);
        return fixedConsumer.remote.commands.execute(agent.id, line, [], signal());
      };
      /** @template {string} L @param {L} line @returns {Promise<import('../types/test.js').FixtureCommandValue<L>>} */
      const success = async line => {
        const envelope = await remoteExecute(line);
        assert.equal(envelope.ok, true, envelope.ok ? undefined : envelope.error.message);
        assert.ok(envelope.value, 'the AFK command must resolve, rather than silently returning an unknown-command miss');
        assert.equal(envelope.value.result.kind, 'success', envelope.value.result.text);
        assert.ok(typeof envelope.value.result.text === 'string');
        return /** @type {import('../types/test.js').FixtureCommandValue<L>} */ (/** @type {unknown} */ (JSON.parse(envelope.value.result.text)));
      };
      const initial = await success('/afk');
      assert.deepEqual({ scope: initial.scope, enabled: initial.enabled, total: initial.total, unread: initial.unread }, { scope: 'session', enabled: false, total: 0, unread: 0 });
      /** @type {import('../types/afk.js').AfkSettings} */
      const settings = { enabled: true, mode: 'auto-reply', reply: 'Remote reply, never human approval.' };
      assert.deepEqual((await success(`/afk set ${JSON.stringify(settings)}`)).settings, settings);
      const current = await success('/afk');
      assert.deepEqual({ enabled: current.enabled, mode: current.mode, reply: current.reply }, settings);
      // A settled business failure is a successful wire call whose result is an error.
      const invalidSettings = await remoteExecute(`/afk set ${JSON.stringify({ ...settings, reply: '   ' })}`);
      assert.equal(invalidSettings.ok, true);
      assert.ok(invalidSettings.ok && invalidSettings.value);
      assert.equal(invalidSettings.value.result.kind, 'error');
      // A thrown Host handler error is folded into the Client Remote error branch.
      const invalidPage = await remoteExecute('/afk history -1 20');
      assert.equal(invalidPage.ok, false);
      assert.ok(!invalidPage.ok);
      assert.equal(invalidPage.error.code, 'gateway/internal');
      assert.equal(GatewayClient.isRemoteFailure(invalidPage.error), true);
      assert.match(invalidPage.error.message, /offset/);
      assert.deepEqual(wireCalls.at(-2), { agentId: agent.id, line: `/afk set ${JSON.stringify({ ...settings, reply: '   ' })}` });
      assert.equal((await success('/afk')).reply, settings.reply, 'business failures must not mutate saved AFK settings');
    } finally {
      await registration?.();
      await agentScope.dispose();
    }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});
