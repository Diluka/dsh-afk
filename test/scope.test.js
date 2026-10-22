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
const load = runtime ? async name => import(pathToFileURL(createRequire(join(runtime, 'package.json')).resolve(name)).href) : undefined;
const pluginPath = pathToFileURL(join(process.env.DSH_TEST_PLUGIN_DIR ?? fileURLToPath(new URL('..', import.meta.url)), 'index.js')).href;

test('Config uses stable volatile scope and one atomic global object with validated safe defaults', () => {
  const refs = Config();
  assert.equal(typeof refs.scope.get, 'function');
  assert.equal(typeof refs.global.get, 'function');
  assert.equal(Config.dict.scope.meta.volatile, true);
  assert.equal(Config.dict.global.meta.volatile, true);
  assert.deepEqual(readConfig(refs), { scope: 'session', global: { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY } });
  assert.equal(readConfig({ scope: 'global', global: { enabled: true, mode: 'auto-reply', reply: 'raw' } }).global.reply, 'raw');
  const local = projection.init({}, 0);
  assert.deepEqual(effectiveSettings(refs, local), { scope: 'session', enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY });
  const global = { enabled: true, mode: 'disable-ask', reply: ' 原样\n回复 ' };
  const configured = Config({ scope: 'global', global });
  assert.deepEqual(effectiveSettings(configured, local), { scope: 'global', ...global });
  assert.equal(effectiveSettings({ scope: 'global', global: { ...global, scope: 'session' } }, local).scope, 'global', 'unknown object extensions cannot overwrite the selected scope');
  for (const scope of ['all', '', true, []]) assert.throws(() => Config({ scope }));
  for (const reply of ['', '  \n', 'x'.repeat(2001)]) assert.throws(() => Config({ global: { reply } }));
  for (const global of [{ enabled: 'true' }, { mode: 'approve-all' }, { reply: 42 }]) assert.throws(() => Config({ global }));
  assert.equal(readConfig(Config({ global: { reply: 'x'.repeat(2000) } })).global.reply.length, 2000);
});

// Real Loader + root Include + ConfigEditor + Settings; only launcher-owned
// profile data and Session/Agent fixtures are supplied. No server, model, browser,
// user profile, foreign API wrapper or production test switch participates.
test('real volatile Settings persist atomically without remount; scope controls current/future/fork/restored agents and keeps Session data isolated', { skip: !runtime }, async () => {
  const [
    { Context }, { default: Loader }, { default: SystemPrompt }, { default: Tools },
    { default: Sessions }, { default: Agents }, { default: Commands }, { default: Projections },
    { default: UserQuestions }, ask, { createScope }, { default: ConfigEditor },
    { default: Settings }, { mountRootInclude, readProfilePatches }, { createUserMessage },
  ] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-commands'), load('@deepseek-ai/dsh-session-projection'),
    load('@deepseek-ai/dsh-user-questions'), load('@deepseek-ai/dsh-tool-ask-user'), load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-config-editor'),
    load('@deepseek-ai/dsh-settings'), load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-llm'),
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
  const registrations = [];
  const scopes = [];
  const signal = () => new AbortController().signal;
  try {
    ctx.baseUrl = pathToFileURL(dir + '/').href;
    ctx.provide('profileContext', profile);
    for (const service of [Loader, SystemPrompt, Tools, Sessions, Agents, Commands, Projections, UserQuestions]) await ctx.plugin(service);
    await ctx.plugin(ask);
    let humanRequests = 0;
    ctx.on('user-questions/request', async request => {
      humanRequests++;
      return { answers: request.questions.map(question => ({ id: question.id, selected: ['Human'] })) };
    });
    const agentFor = async (id, session = ctx.sessions.create(id)) => {
      const agent = { id, session };
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
    const tree = included.subgroup.tree;
    const entry = tree.resolve('dsh-afk');
    assert.equal(entry.fiber.state, 2);
    const fiber = entry.fiber;
    const refs = fiber.config;
    await ctx.plugin(ConfigEditor);
    await ctx.plugin(Settings);
    const document = () => ctx.settings.describe().find(row => row.ns === 'dsh-afk');
    const initial = document();
    assert.ok(initial, 'Settings must address the standard profile namespace, not include:dsh-afk');
    assert.deepEqual(Object.keys(initial.value).sort(), ['global', 'scope']);
    assert.deepEqual(initial.value, { scope: 'session', global: { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY } });
    const command = (agent, input = '') => ctx.commands.execute(agent, `/afk ${input}`, [], signal());
    const success = async (agent, input = '') => {
      const result = await command(agent, input);
      assert.equal(result.result.kind, 'success', result.result.text);
      return JSON.parse(result.result.text);
    };
    const localA = { enabled: true, mode: 'disable-ask', reply: 'Local A stays saved.' };
    const localB = { enabled: false, mode: 'auto-reply', reply: 'Local B stays saved.' };
    await success(a, `set ${JSON.stringify(localA)}`);
    await success(b, `set ${JSON.stringify(localB)}`);
    assert.equal(ctx.tools.get('ask_user_question', a), undefined);
    assert.ok(ctx.tools.get('ask_user_question', b));
    const projectionOf = agent => ctx.sessionProjections.stateOf(agent.session, 'dsh-afk');
    const viewBefore = agent => ({ ...projectionOf(agent).view });
    const savedA = viewBefore(a);
    const savedB = viewBefore(b);
    const changes = [];
    // The observer lives on the exact owning fiber, just as the production listener does.
    fiber.ctx.on('loader/volatile-update', paths => changes.push({ paths, scope: refs.scope.get(), global: refs.global.get() }));
    const set = async ops => {
      const before = document();
      await ctx.settings.mutate('dsh-afk', ops, before.revision);
      const after = document();
      assert.ok(after.revision > before.revision);
      assert.equal(entry.fiber, fiber, 'volatile settings must not remount AFK');
      assert.equal(entry.fiber.config.scope, refs.scope, 'scope reference identity remains stable');
      assert.equal(entry.fiber.config.global, refs.global, 'global reference identity remains stable');
      return after;
    };
    assert.equal(entry.options.name, pluginPath, 'entry identity must match the persisted insertion');
    const global = { enabled: true, mode: 'auto-reply', reply: 'Global safe reply ${not_interpolated}' };
    const activated = await set([{ op: 'set', path: ['scope'], value: 'global' }, { op: 'set', path: ['global'], value: global }]);
    assert.equal(changes.at(-1).scope, 'global');
    assert.deepEqual(changes.at(-1).global, global, 'the event sees every field already committed');
    assert.equal(changes.at(-1).paths.length, 2, 'one atomic Settings transaction commits both refs');
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
    const observeRequest = async agent => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent });
      const context = assembly.contexts.find(row => row.name === 'dsh-afk');
      assert.equal(context.interpolate, false);
      assert.match(context.text, /never grants permission/);
      assert.equal(context.text.includes(global.reply), false, 'reply text is not duplicated into runtime context');
      const first = context.text.split('\n')[0];
      assert.ok(first.startsWith(REQUEST_STATE_PREFIX));
      const requestState = JSON.parse(first.slice(REQUEST_STATE_PREFIX.length));
      // Same message construction/source shape used by Loop, without starting a model.
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: context.text }], source: { kind: 'runtime-context', form: 'snapshot', sections: assembly.contexts.map(({ name, text }) => ({ name, text })) } }), { surfaceOp: 'append' });
      return requestState;
    };
    let serial = 0;
    const runTool = async (agent, name = 'ask_user_question', args = { questions: [{ id: 'choice', question: 'Proceed?' }] }, beforeResult) => {
      const callId = `${agent.id}:call:${++serial}`;
      agent.session.append('tool/call', { turn: 1, step: serial, callId, name, arguments: JSON.stringify(args) });
      if (beforeResult) await beforeResult();
      const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: signal() });
      agent.session.append('tool/result', { turn: 1, step: serial, message: { id: `${callId}:result`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: result.content, isError: result.isError }, ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append' });
      return result;
    };
    const observed = await observeRequest(a);
    assert.deepEqual(observed, { scope: 'global', enabled: true, mode: 'auto-reply' });
    const automatic = await runTool(a);
    assert.equal(automatic.value.answers[0].custom, REPLY_PREFIX + global.reply);
    assert.equal(humanRequests, 0);
    assert.equal(projectionOf(a).records[0].afk, true);
    assert.deepEqual(projectionOf(a).records[0].requestState, observed);
    assert.equal(projectionOf(a).view.reply, localA.reply, 'global execution does not overwrite local projection settings');
    const future = await agentFor('scope-future');
    const fork = await agentFor('scope-fork', ctx.sessions.fork(a.session, undefined, 'scope-fork'));
    const restored = await agentFor('scope-restored', ctx.sessions.create('scope-restored', { seed: a.session.snapshotEvents() }));
    assert.equal(projectionOf(fork).view.enabled, false, 'the fork still inherits no local AFK authority');
    for (const agent of [future, fork, restored]) {
      assert.equal((await success(agent)).scope, 'global');
      assert.equal((await runTool(agent)).value.answers[0].custom, REPLY_PREFIX + global.reply);
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
    assert.equal((await runTool(b)).value.answers[0].custom, REPLY_PREFIX + 'Newest global reply.');
    const beforeConflict = await readFile(patchPath, 'utf8');
    await assert.rejects(ctx.settings.mutate('dsh-afk', [{ op: 'set', path: ['global', 'enabled'], value: false }], activated.revision), error => error.code === 'SETTINGS_CONFLICT');
    assert.equal(await readFile(patchPath, 'utf8'), beforeConflict);
    for (const [path, value] of [[['global', 'reply'], ' \n'], [['global', 'reply'], ''], [['global', 'reply'], 'x'.repeat(2001)], [['global', 'enabled'], 'yes'], [['global', 'mode'], 'approve-all'], [['scope'], 'all']]) {
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
    assert.equal(projectionOf(b).records.at(-1).status, 'blocked');
    assert.equal(projectionOf(b).records.at(-1).afk, true, 'the real pipeline runs AFK guard before hidden-tool dispatch');
    assert.equal(projectionOf(b).records.at(-1).mode, 'disable-ask');
    await set([{ op: 'set', path: ['global', 'enabled'], value: false }]);
    for (const agent of [a, b, future, fork, restored, later]) assert.ok(ctx.tools.get('ask_user_question', agent), 'global off ignores saved local enable flags');
    const offPrompt = await ctx.systemPrompt.assemble({ scope: b });
    assert.deepEqual(JSON.parse(offPrompt.contexts.find(row => row.name === 'dsh-afk').text.slice(REQUEST_STATE_PREFIX.length)), { scope: 'global', enabled: false, mode: 'disable-ask' });
    // A request that saw off can race with a subsequent Settings/scope update.
    b.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'current runtime context' }], source: { kind: 'runtime-context', form: 'snapshot', sections: offPrompt.contexts.map(({ name, text }) => ({ name, text })) } }), { surfaceOp: 'append' });
    const ordinary = await runTool(b);
    assert.equal(ordinary.isError, false);
    assert.equal(ordinary.value.answers[0].custom, undefined);
    assert.equal(projectionOf(b).records.at(-1).afk, false, 'global off dispatches the ordinary human question despite saved local preferences');
    assert.equal(humanRequests, 1);
    const raced = await runTool(b, 'ask_user_question', undefined, async () => {
      await set([{ op: 'set', path: ['scope'], value: 'session' }]);
      const restoredB = await success(b);
      assert.deepEqual({ enabled: restoredB.enabled, mode: restoredB.mode, reply: restoredB.reply }, localB, 'returning to Session preserves each local setting before new edits');
      await success(b, `set ${JSON.stringify({ enabled: true, mode: 'auto-reply', reply: 'Raced local result.' })}`);
    });
    assert.equal(raced.value.answers[0].custom, REPLY_PREFIX + 'Raced local result.');
    assert.deepEqual(projectionOf(b).records.at(-1).requestState, { scope: 'global', enabled: false, mode: 'disable-ask' });
    assert.equal(projectionOf(b).records.at(-1).afk, true);
    assert.equal(projectionOf(b).records.at(-1).mode, 'auto-reply');
    assert.deepEqual({ enabled: projectionOf(a).view.enabled, mode: projectionOf(a).view.mode, reply: projectionOf(a).view.reply }, localA);
    assert.equal(ctx.tools.get('ask_user_question', a), undefined);
    assert.ok(ctx.tools.get('ask_user_question', fork), 'switching back to session restores fork default off');
    assert.equal((await success(restored)).reply, localA.reply, 'replayed local settings survive global detour');
    assert.equal(ctx.tools.get('ask_user_question', restored), undefined);
    const sessionFork = await agentFor('scope-session-fork', ctx.sessions.fork(a.session, undefined, 'scope-session-fork'));
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
    assert.equal(projectionOf(a), undefined);
    assert.equal((await ctx.systemPrompt.assemble({ scope: a })).contexts.some(row => row.name === 'dsh-afk'), false);
    // A fresh Host reads the actual persisted patch, not the former entry's memory.
    const next = new Context();
    let nextRegistration;
    let nextScope;
    try {
      next.baseUrl = pathToFileURL(dir + '/').href;
      next.provide('profileContext', profile);
      for (const service of [Loader, SystemPrompt, Tools, Sessions, Agents, Commands, Projections, UserQuestions]) await next.plugin(service);
      await next.plugin(ask);
      const reloaded = await mountRootInclude(next, basePath, readProfilePatches('dsh', profile), pathToFileURL(join(runtime, 'package.json')).href);
      await next.loader.await();
      const loaded = reloaded.subgroup.tree.resolve('dsh-afk');
      assert.equal(loaded.fiber.state, 2);
      assert.notEqual(loaded.fiber, fiber);
      const fresh = { id: 'scope-restarted', session: next.sessions.create('scope-restarted') };
      nextScope = createScope(next, fresh);
      fresh.ctx = nextScope.ctx;
      nextRegistration = await next.agents.register(fresh);
      const current = await next.commands.execute(fresh, '/afk', [], signal());
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
