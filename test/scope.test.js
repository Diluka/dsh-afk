import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Config, readConfig, effectiveSettings } from '../config.js';
import { projection, DEFAULT_REPLY, REPLY_PREFIX, REQUEST_STATE_PREFIX } from '../state.js';

const runtime = process.env.DSH_TEST_RUNTIME_DIR;
/** @type {import('../types/test.js').RuntimeLoader} */
const load = async name => {
  assert.ok(runtime, 'Only non-skipped real-runtime tests load SDK modules');
  return import(pathToFileURL(createRequire(join(runtime, 'package.json')).resolve(name)).href);
};
const pluginPath = pathToFileURL(join(process.env.DSH_TEST_PLUGIN_DIR ?? fileURLToPath(new URL('..', import.meta.url)), 'index.js')).href;

test('Config uses stable volatile scope and one atomic global object with validated safe defaults', () => {
  const refs = Config();
  assert.equal(typeof refs.scope.get, 'function');
  assert.equal(typeof refs.global.get, 'function');
  assert.ok(Config.dict);
  assert.equal(Config.dict.scope.meta.volatile, true);
  assert.equal(Config.dict.global.meta.volatile, true);
  assert.deepEqual(readConfig(refs), { scope: 'session', global: { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY } });
  assert.equal(readConfig({ scope: 'global', global: { enabled: true, mode: 'auto-reply', reply: 'raw' } }).global.reply, 'raw');
  // The pure config resolver does not inspect a Session header; this fixture supplies no unrelated header fields.
  const local = projection.init(/** @type {import('@deepseek-ai/dsh-session').SessionHeader} */ (/** @type {unknown} */ ({})), /** @type {import('@deepseek-ai/dsh-session').SessionLogOffset} */ (0));
  assert.deepEqual(effectiveSettings(refs, local), { scope: 'session', enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY });
  /** @type {import('../types/afk.js').AfkSettings} */
  const global = { enabled: true, mode: 'disable-ask', reply: ' 原样\n回复 ' };
  const configured = Config({ scope: 'global', global });
  assert.deepEqual(effectiveSettings(configured, local), { scope: 'global', ...global });
  // @ts-expect-error 故意不合法：未知嵌套scope字段不能覆盖真正的配置作用范围。
  assert.equal(effectiveSettings({ scope: 'global', global: { ...global, scope: 'session' } }, local).scope, 'global', 'unknown object extensions cannot overwrite the selected scope');
  for (const scope of ['all', '', true, []]) {
    // @ts-expect-error 故意不合法：验证真实Config拒绝无效作用范围。
    assert.throws(() => Config({ scope }));
  }
  for (const reply of ['', '  \n', 'x'.repeat(2001)]) assert.throws(() => Config({ global: { reply } }));
  for (const global of [{ enabled: 'true' }, { mode: 'approve-all' }, { reply: 42 }]) {
    // @ts-expect-error 故意不合法：字符串开关、未知模式与数字回复必须被真实schema拒绝。
    assert.throws(() => Config({ global }));
  }
  assert.equal(readConfig(Config({ global: { reply: 'x'.repeat(2000) } })).global.reply.length, 2000);
});

// Real Loader + root Include + ConfigEditor + Settings; only launcher-owned
// profile data and Session/Agent fixtures are supplied. No server, model, browser,
// user profile, foreign API wrapper or production test switch participates.
test('real volatile Settings persist atomically without remount; scope controls current/future/fork/restored agents and keeps Session data isolated', { skip: !runtime }, async () => {
  assert.ok(runtime);
  const [
    { Context }, { default: Loader }, { default: SystemPrompt }, { default: Tools },
    { default: Sessions }, { default: Agents }, { default: Commands }, { default: Projections },
    { default: UserQuestions }, ask, { createScope }, { default: ConfigEditor },
    { default: Settings }, { mountRootInclude, readProfilePatches }, { createUserMessage }, { default: Typert },
  ] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-commands'), load('@deepseek-ai/dsh-session-projection'),
    load('@deepseek-ai/dsh-user-questions'), load('@deepseek-ai/dsh-tool-ask-user'), load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-config-editor'),
    load('@deepseek-ai/dsh-settings'), load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-typert-registry'),
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'dsh-afk-scope-'));
  const home = join(dir, 'home');
  const profileDir = join(home, 'profiles', 'fixture');
  await mkdir(profileDir, { recursive: true });
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const basePath = join(dir, 'cordis.yml');
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'afk-scope-fixture', private: true, dsh: { profile: { bundles: [] } } }));
  await writeFile(basePath, '[]\n');
  await writeFile(patchPath, JSON.stringify([{ insert: [{ id: 'dsh-afk', name: pluginPath, config: {} }] }]));
  const profile = { name: 'fixture', home, dir: profileDir, patchPath, installAnchor: join(runtime, 'package.json'), cwd: dir, overlays: [], startedBundles: [], telemetryDisabledEnv: undefined };
  const ctx = new Context();
  // This real Context mounts Host Sessions; isolate the official Client/Host declaration collision at this boundary.
  const host = /** @type {import('../types/test.js').FixtureHostContext} */ (/** @type {unknown} */ (ctx));
  /** @type {import('../types/test.js').Dispose[]} */
  const registrations = [];
  /** @type {import('../types/test.js').RuntimeScope[]} */
  const scopes = [];
  const signal = () => new AbortController().signal;
  try {
    ctx.baseUrl = pathToFileURL(dir + '/').href;
    ctx.provide('profileContext', profile);
    for (const service of [Loader, Typert, SystemPrompt, Tools, Sessions, Agents, Commands, Projections, UserQuestions]) await ctx.plugin(service);
    await ctx.plugin(ask);
    let humanRequests = 0;
    ctx.on('user-questions/request', async request => {
      humanRequests++;
      return { answers: request.questions.map(question => ({ id: question.id, selected: ['Human'] })) };
    });
    /** @param {string} id @param {import('@deepseek-ai/dsh-session').Session} [session] */
    const agentFor = async (id, session = host.sessions.create(/** @type {import('@deepseek-ai/dsh-session').SessionId} */ (id))) => {
      // Deliberately no Agent driver/model: this fixture exercises only id, Session and scoped Context.
      const agent = /** @type {import('../types/test.js').FixtureAgent} */ (/** @type {unknown} */ ({ id, session }));
      const scope = createScope(ctx, agent);
      scopes.push(scope);
      agent.ctx = scope.ctx;
      registrations.push(await ctx.agents.register(agent));
      return agent;
    };
    // Already registered at AFK activation, not only future agent/created.
    const a = await agentFor('scope-a');
    const b = await agentFor('scope-b');
    const included = await mountRootInclude(ctx, basePath, readProfilePatches('dsh', profile), pathToFileURL(join(runtime, 'package.json')).href);
    await ctx.loader.await();
    assert.ok(included?.subgroup);
    const tree = included.subgroup.tree;
    const entry = tree.resolve('dsh-afk');
    assert.ok(entry.fiber);
    assert.equal(entry.fiber.state, 2);
    const fiber = entry.fiber;
    const refs = /** @type {ReturnType<typeof Config>} */ (/** @type {unknown} */ (fiber.config)); // This entry's real Config constructed these stable references.
    await ctx.plugin(ConfigEditor);
    await ctx.plugin(Settings);
    const document = () => {
      const descriptor = ctx.settings.describe().find(row => row.ns === 'dsh-afk');
      assert.ok(descriptor);
      return descriptor;
    };
    const initial = document();
    assert.ok(initial, 'Settings must address the standard profile namespace, not include:dsh-afk');
    assert.ok(initial.value && typeof initial.value === 'object');
    assert.deepEqual(Object.keys(initial.value).sort(), ['global', 'scope']);
    assert.deepEqual(initial.value, { scope: 'session', global: { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY } });
    /** @param {import('@deepseek-ai/dsh-agent').Agent} agent @param {string} [input] */
    const command = async (agent, input = '') => {
      const execution = await ctx.commands.execute(agent, `/afk ${input}`, [], signal());
      assert.ok(execution);
      return execution;
    };
    /** @template {string} [L=''] @param {import('@deepseek-ai/dsh-agent').Agent} agent @param {L} [input] @returns {Promise<import('../types/test.js').FixtureCommandValue<L>>} */
    const success = async (agent, input = /** @type {L} */ ('')) => {
      const result = await command(agent, input);
      assert.equal(result.result.kind, 'success', result.result.text);
      assert.ok(typeof result.result.text === 'string');
      return /** @type {import('../types/test.js').FixtureCommandValue<L>} */ (/** @type {unknown} */ (JSON.parse(result.result.text)));
    };
    const localA = { enabled: true, mode: 'disable-ask', reply: 'Local A stays saved.' };
    const localB = { enabled: false, mode: 'auto-reply', reply: 'Local B stays saved.' };
    await success(a, `set ${JSON.stringify(localA)}`);
    await success(b, `set ${JSON.stringify(localB)}`);
    assert.equal(ctx.tools.get('ask_user_question', a), undefined);
    assert.ok(ctx.tools.get('ask_user_question', b));
    /** @param {import('@deepseek-ai/dsh-agent').Agent} agent */
    const projectionOf = agent => {
      const state = ctx.sessionProjections.stateOf(agent.session, 'dsh-afk');
      assert.ok(state);
      return state;
    };
    /** @param {import('@deepseek-ai/dsh-agent').Agent} agent */
    const viewBefore = agent => ({ ...projectionOf(agent).view });
    const savedA = viewBefore(a);
    const savedB = viewBefore(b);
    /** @type {{paths: readonly (readonly string[])[], scope: import('../types/afk.js').AfkScope, global: import('../types/afk.js').AfkSettings}[]} */
    const changes = [];
    // The observer lives on the exact owning fiber, just as the production listener does.
    fiber.ctx.on('loader/volatile-update', paths => changes.push({ paths, scope: refs.scope.get(), global: refs.global.get() }));
    /** @param {readonly import('@deepseek-ai/dsh-settings').SettingsPathOp[]} ops */
    const set = async ops => {
      const before = document();
      await ctx.settings.mutate('dsh-afk', ops, before.revision);
      const after = document();
      assert.ok(after.revision > before.revision);
      assert.equal(entry.fiber, fiber, 'volatile settings must not remount AFK');
      const currentRefs = /** @type {ReturnType<typeof Config>} */ (/** @type {unknown} */ (fiber.config));
      assert.equal(currentRefs.scope, refs.scope, 'scope reference identity remains stable');
      assert.equal(currentRefs.global, refs.global, 'global reference identity remains stable');
      return after;
    };
    assert.equal(entry.options.name, pluginPath, 'entry identity must match the persisted insertion');
    const global = { enabled: true, mode: 'auto-reply', reply: 'Global safe reply ${not_interpolated}' };
    const activated = await set([{ op: 'set', path: ['scope'], value: 'global' }, { op: 'set', path: ['global'], value: global }]);
    const lastChange = changes.at(-1);
    assert.ok(lastChange);
    assert.equal(lastChange.scope, 'global');
    assert.deepEqual(lastChange.global, global, 'the event sees every field already committed');
    assert.equal(lastChange.paths.length, 2, 'one atomic Settings transaction commits both refs');
    assert.ok(ctx.tools.get('ask_user_question', a), 'switching scope lifts local disable mask');
    for (const agent of [a, b]) {
      const current = await success(agent);
      assert.deepEqual({ scope: current.scope, enabled: current.enabled, mode: current.mode, reply: current.reply }, { scope: 'global', ...global });
      assert.equal(current.total, 0);
    }
    assert.deepEqual(viewBefore(a), savedA);
    assert.deepEqual(viewBefore(b), savedB);
    const persisted = await readFile(patchPath, 'utf8');
    assert.match(persisted, /scope: global/);
    assert.match(persisted, /Global safe reply/);
    /** @param {import('@deepseek-ai/dsh-agent').Agent} agent */
    const observeRequest = async agent => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent });
      const context = assembly.contexts.find(row => row.name === 'dsh-afk');
      assert.ok(context);
      assert.equal(context.interpolate, false);
      assert.match(context.text, /never grants permission/);
      assert.equal(context.text.includes(global.reply), false, 'reply text is not duplicated into runtime context');
      const first = context.text.split('\n')[0];
      assert.ok(first.startsWith(REQUEST_STATE_PREFIX));
      const requestState = JSON.parse(first.slice(REQUEST_STATE_PREFIX.length));
      // Same message construction/source shape used by Loop, without starting a model.
      // Loop owns the runtime-context source augmentation but is intentionally not started/imported in this fixture.
      const snapshotInput = /** @type {Parameters<typeof createUserMessage>[0]} */ (/** @type {unknown} */ ({ content: [{ type: 'text', text: context.text }], source: { kind: 'runtime-context', form: 'snapshot', sections: assembly.contexts.map(({ name, text }) => ({ name, text })) } }));
      agent.session.append('user/message', createUserMessage(snapshotInput), { surfaceOp: 'append' });
      return requestState;
    };
    let serial = 0;
    /**
     * The real tool schema checks its result; raw args intentionally reach the real dispatcher.
     * @template {keyof import('../types/test.js').FixtureToolValues} [K='ask_user_question']
     * @param {import('@deepseek-ai/dsh-agent').Agent} agent @param {K} [name] @param {unknown} [args] @param {() => Promise<void>} [beforeResult]
     * @returns {Promise<import('../types/test.js').FixtureToolResult<K>>}
     */
    const runTool = async (agent, name = /** @type {K} */ ('ask_user_question'), args = { questions: [{ id: 'choice', question: 'Proceed?' }] }, beforeResult) => {
      const callId = /** @type {import('@deepseek-ai/dsh-llm').ToolCallId} */ (`${agent.id}:call:${++serial}`);
      agent.session.append('tool/call', { turn: 1, step: serial, callId, name, arguments: JSON.stringify(args) });
      if (beforeResult) await beforeResult();
      const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: signal() });
      agent.session.append('tool/result', { turn: 1, step: serial, message: { id: /** @type {import('@deepseek-ai/dsh-llm').MessageId} */ (`${callId}:result`), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: result.content, isError: result.isError }, ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append' });
      return /** @type {import('../types/test.js').FixtureToolResult<K>} */ (/** @type {unknown} */ (result));
    };
    const observed = await observeRequest(a);
    assert.deepEqual(observed, { scope: 'global', enabled: true, mode: 'auto-reply' });
    const automatic = await runTool(a);
    assert.equal(automatic.isError, false);
    assert.equal(automatic.value.answers[0].custom, REPLY_PREFIX + global.reply);
    assert.equal(humanRequests, 0);
    assert.equal(projectionOf(a).records[0].afk, true);
    assert.deepEqual(projectionOf(a).records[0].requestState, observed);
    assert.equal(projectionOf(a).view.reply, localA.reply, 'global execution does not overwrite local projection settings');
    const future = await agentFor('scope-future');
    const fork = await agentFor('scope-fork', host.sessions.fork(a.session, undefined, /** @type {import('@deepseek-ai/dsh-session').SessionId} */ ('scope-fork')));
    const restored = await agentFor('scope-restored', host.sessions.create(/** @type {import('@deepseek-ai/dsh-session').SessionId} */ ('scope-restored'), { seed: a.session.snapshotEvents() }));
    assert.equal(projectionOf(fork).view.enabled, false, 'the fork still inherits no local AFK authority');
    for (const agent of [future, fork, restored]) {
      assert.equal((await success(agent)).scope, 'global');
      const replied = await runTool(agent);
      assert.equal(replied.isError, false);
      assert.equal(replied.value.answers[0].custom, REPLY_PREFIX + global.reply);
    }
    for (const input of ['on', 'off', `set ${JSON.stringify(localB)}`]) {
      const rejected = await command(a, input);
      assert.equal(rejected.result.kind, 'error');
      assert.match(rejected.result.text, /全局设置 UI/);
    }
    assert.equal(document().revision, activated.revision, 'Session commands cannot elevate into global Settings authority');
    assert.deepEqual(document().value, activated.value);
    assert.equal(projectionOf(a).view.enabled, true);
    assert.equal(projectionOf(a).view.mode, 'disable-ask');
    const aHistory = await success(a, 'history 0 20 all');
    assert.equal(aHistory.totalAll, 1);
    assert.equal((await success(b, 'history')).totalAll, 0);
    assert.equal((await success(fork, 'history')).totalAll, 1, 'inherited records are ignored; only this child’s own ask is recorded');
    await assert.rejects(command(b, `read ${JSON.stringify([aHistory.records[0].id])}`), /Unknown question record/);
    await success(a, `read ${JSON.stringify([aHistory.records[0].id])}`);
    assert.equal((await success(a, 'history')).unread, 0);
    assert.equal((await success(fork, 'history')).unread, 1);
    const revised = await set([{ op: 'set', path: ['global', 'reply'], value: 'Newest global reply.' }]);
    const newest = await runTool(b);
    assert.equal(newest.isError, false);
    assert.equal(newest.value.answers[0].custom, REPLY_PREFIX + 'Newest global reply.');
    const beforeConflict = await readFile(patchPath, 'utf8');
    await assert.rejects(ctx.settings.mutate('dsh-afk', [{ op: 'set', path: ['global', 'enabled'], value: false }], activated.revision), error => error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT');
    assert.equal(await readFile(patchPath, 'utf8'), beforeConflict);
    /** @type {[string[], unknown][]} */
    const invalidEdits = [[['global', 'reply'], ' \n'], [['global', 'reply'], ''], [['global', 'reply'], 'x'.repeat(2001)], [['global', 'enabled'], 'yes'], [['global', 'mode'], 'approve-all'], [['scope'], 'all']];
    for (const [path, value] of invalidEdits) {
      await assert.rejects(ctx.settings.mutate('dsh-afk', [{ op: 'set', path, value }], revised.revision));
      assert.equal(await readFile(patchPath, 'utf8'), beforeConflict, 'invalid candidates roll back before persistence');
      assert.equal(document().revision, revised.revision);
      assert.deepEqual(document().value, revised.value);
      assert.equal(entry.fiber, fiber);
    }
    await set([{ op: 'set', path: ['global', 'mode'], value: 'disable-ask' }]);
    for (const agent of [a, b, future, fork, restored]) assert.equal(ctx.tools.get('ask_user_question', agent), undefined, 'mode commit refreshes every existing agent mask');
    const later = await agentFor('scope-later-disabled');
    assert.equal(ctx.tools.get('ask_user_question', later), undefined, 'future attaches read current refs');
    const hidden = await runTool(b);
    assert.equal(hidden.isError, true);
    const hiddenRecord = projectionOf(b).records.at(-1);
    assert.ok(hiddenRecord);
    assert.equal(hiddenRecord.status, 'blocked');
    assert.equal(hiddenRecord.afk, true, 'the real pipeline runs AFK guard before hidden-tool dispatch');
    assert.equal(hiddenRecord.mode, 'disable-ask');
    await set([{ op: 'set', path: ['global', 'enabled'], value: false }]);
    for (const agent of [a, b, future, fork, restored, later]) assert.ok(ctx.tools.get('ask_user_question', agent), 'global off ignores saved local enable flags');
    const offPrompt = await ctx.systemPrompt.assemble({ scope: b });
    const offContext = offPrompt.contexts.find(row => row.name === 'dsh-afk');
    assert.ok(offContext);
    assert.deepEqual(JSON.parse(offContext.text.slice(REQUEST_STATE_PREFIX.length)), { scope: 'global', enabled: false, mode: 'disable-ask' });
    // A request that saw off can race with a subsequent Settings/scope update.
    // Same Loop-owned snapshot source boundary as observeRequest; no Agent loop is loaded.
    const offSnapshot = /** @type {Parameters<typeof createUserMessage>[0]} */ (/** @type {unknown} */ ({ content: [{ type: 'text', text: 'current runtime context' }], source: { kind: 'runtime-context', form: 'snapshot', sections: offPrompt.contexts.map(({ name, text }) => ({ name, text })) } }));
    b.session.append('user/message', createUserMessage(offSnapshot), { surfaceOp: 'append' });
    const ordinary = await runTool(b);
    assert.equal(ordinary.isError, false);
    assert.equal(ordinary.value.answers[0].custom, undefined);
    const ordinaryRecord = projectionOf(b).records.at(-1);
    assert.ok(ordinaryRecord);
    assert.equal(ordinaryRecord.afk, false, 'global off dispatches the ordinary human question despite saved local preferences');
    assert.equal(humanRequests, 1);
    const raced = await runTool(b, 'ask_user_question', undefined, async () => {
      await set([{ op: 'set', path: ['scope'], value: 'session' }]);
      const restoredB = await success(b);
      assert.deepEqual({ enabled: restoredB.enabled, mode: restoredB.mode, reply: restoredB.reply }, localB, 'returning to Session preserves each local setting before new edits');
      await success(b, `set ${JSON.stringify({ enabled: true, mode: 'auto-reply', reply: 'Raced local result.' })}`);
    });
    assert.equal(raced.isError, false);
    assert.equal(raced.value.answers[0].custom, REPLY_PREFIX + 'Raced local result.');
    const racedRecord = projectionOf(b).records.at(-1);
    assert.ok(racedRecord);
    assert.deepEqual(racedRecord.requestState, { scope: 'global', enabled: false, mode: 'disable-ask' });
    assert.equal(racedRecord.afk, true);
    assert.equal(racedRecord.mode, 'auto-reply');
    assert.deepEqual({ enabled: projectionOf(a).view.enabled, mode: projectionOf(a).view.mode, reply: projectionOf(a).view.reply }, localA);
    assert.equal(ctx.tools.get('ask_user_question', a), undefined);
    assert.ok(ctx.tools.get('ask_user_question', fork), 'switching back to session restores fork default off');
    assert.equal((await success(restored)).reply, localA.reply, 'replayed local settings survive global detour');
    assert.equal(ctx.tools.get('ask_user_question', restored), undefined);
    const sessionFork = await agentFor('scope-session-fork', host.sessions.fork(a.session, undefined, /** @type {import('@deepseek-ai/dsh-session').SessionId} */ ('scope-session-fork')));
    assert.equal((await success(sessionFork)).enabled, false, 'a newly forked Session defaults off under default scope');
    assert.equal((await runTool(sessionFork)).isError, false);
    assert.equal(humanRequests, 2);
    await set([{ op: 'set', path: ['scope'], value: 'global' }, { op: 'set', path: ['global'], value: { enabled: true, mode: 'disable-ask', reply: 'Persisted global policy.' } }]);
    await tree.remove('dsh-afk');
    await ctx.loader.await();
    for (const agent of [a, b, future, fork, restored, later, sessionFork]) assert.ok(ctx.tools.get('ask_user_question', agent), 'unload releases masks on every agent');
    assert.equal(ctx.commands.find(a, 'afk'), undefined);
    assert.equal(ctx.tools.get('afk_history', a), undefined);
    assert.equal(ctx.tools.get('afk_mark_read', a), undefined);
    assert.equal(ctx.sessionProjections.stateOf(a.session, 'dsh-afk'), undefined);
    assert.equal((await ctx.systemPrompt.assemble({ scope: a })).contexts.some(row => row.name === 'dsh-afk'), false);
    // A fresh Host reads the actual persisted patch, not the former entry's memory.
    const next = new Context();
    const nextHost = /** @type {import('../types/test.js').FixtureHostContext} */ (/** @type {unknown} */ (next)); // Fresh Host uses the same isolated SessionStore face.
    /** @type {import('../types/test.js').Dispose | undefined} */
    let nextRegistration;
    /** @type {import('../types/test.js').RuntimeScope | undefined} */
    let nextScope;
    try {
      next.baseUrl = pathToFileURL(dir + '/').href;
      next.provide('profileContext', profile);
      for (const service of [Loader, Typert, SystemPrompt, Tools, Sessions, Agents, Commands, Projections, UserQuestions]) await next.plugin(service);
      await next.plugin(ask);
      const reloaded = await mountRootInclude(next, basePath, readProfilePatches('dsh', profile), pathToFileURL(join(runtime, 'package.json')).href);
      await next.loader.await();
      assert.ok(reloaded?.subgroup);
      const loaded = reloaded.subgroup.tree.resolve('dsh-afk');
      assert.ok(loaded.fiber);
      assert.equal(loaded.fiber.state, 2);
      assert.notEqual(loaded.fiber, fiber);
      const fresh = /** @type {import('../types/test.js').FixtureAgent} */ (/** @type {unknown} */ ({ id: 'scope-restarted', session: nextHost.sessions.create(/** @type {import('@deepseek-ai/dsh-session').SessionId} */ ('scope-restarted')) }));
      nextScope = createScope(next, fresh);
      fresh.ctx = nextScope.ctx;
      nextRegistration = await next.agents.register(fresh);
      const current = await next.commands.execute(fresh, '/afk', [], signal());
      assert.ok(current);
      assert.ok(typeof current.result.text === 'string');
      assert.equal(JSON.parse(current.result.text).reply, 'Persisted global policy.');
      assert.equal(JSON.parse(current.result.text).scope, 'global');
      assert.equal(next.tools.get('ask_user_question', fresh), undefined);
    } finally {
      await nextRegistration?.();
      await nextScope?.dispose();
      await next.fiber.dispose();
    }
  } finally {
    for (const dispose of registrations.reverse()) await dispose?.();
    for (const scope of scopes.reverse()) await scope.dispose();
    await ctx.fiber.dispose();
    assert.equal(dirname(dir), tmpdir());
    assert.match(basename(dir), /^dsh-afk-scope-/);
    await rm(dir, { recursive: true, force: true });
  }
});
