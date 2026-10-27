import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

/** @import { Session, SessionId } from '@deepseek-ai/dsh-session' */
/** @import { InvocationDescriptor, PeerScope, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol' */
/** @import { HistoryAddress, HistoryQuery, HistoryRemote } from '../types/history.js' */
/** @typedef {Omit<import('../types/test.js').FixtureHostContext, 'remoteAccess'> & {remoteAccess: import('@deepseek-ai/dsh-api-remote-access').RemoteAccessService}} HistoryHost */

const runtime = process.env.DSH_TEST_RUNTIME_DIR;
/** @type {import('../types/test.js').RuntimeLoader} */
const load = async name => {
  assert.ok(runtime, 'Only non-skipped integration tests load the actual SDK');
  return import(pathToFileURL(createRequire(join(runtime, 'package.json')).resolve(name)).href);
};
const pluginUrl = (name = 'history.js') => process.env.DSH_TEST_PLUGIN_DIR
  ? pathToFileURL(join(process.env.DSH_TEST_PLUGIN_DIR, name)) : new URL(`../${name}`, import.meta.url);
const history = /** @type {typeof import('../history.js')} */ (await import(pluginUrl().href));
const state = /** @type {typeof import('../state.js')} */ (await import(pluginUrl('state.js').href));

/**
 * Execute the unmodified lazy factory, stopping at its first $mount to obtain
 * exactly the production Client descriptor, not a test-authored substitute.
 * React is not rendered: createElement must never be called in this extraction.
 * @returns {Promise<InvocationDescriptor>}
 */
async function clientDescriptor() {
  const source = await readFile(pluginUrl('client.js'), 'utf8');
  /** @type {{ factory: (require: (name: string) => unknown) => { apply: (ctx: {remote: {$mount: (contribution: TypertRemoteContribution) => Promise<never>}}) => Promise<void> } } | undefined} */
  let definition;
  /** @param {NonNullable<typeof definition>} value */
  const registerDefinition = value => { definition = value; };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: registerDefinition } } });
  assert.ok(definition, 'the actual lazy Client module must register its factory');
  const plugin = definition.factory(name => {
    assert.equal(name, 'react');
    return { createElement() { throw new Error('Descriptor extraction must not render React'); } };
  });
  const stop = new Error('stop after observing the production mount');
  /** @type {TypertRemoteContribution | undefined} */
  let mounted;
  await assert.rejects(plugin.apply({ remote: { async $mount(contribution) { mounted = contribution; throw stop; } } }), error => error === stop);
  assert.ok(mounted);
  assert.equal(mounted.package, 'dsh-afk');
  assert.equal(mounted.descriptors.length, 1);
  return mounted.descriptors[0];
}

/** @param {string} value @returns {SessionId} */
const sessionId = value => /** @type {SessionId} */ (value);
/** @param {Session} session @param {string} id @param {boolean} [answered] */
function appendQuestion(session, id, answered = false) {
  const callId = /** @type {import('@deepseek-ai/dsh-llm').ToolCallId} */ (`call-${id}`);
  session.append('tool/call', { turn: 1, step: 0, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id, question: `Fixture ${id}?`, options: [{ label: 'Continue' }] }] }) });
  if (answered) session.append('tool/result', { turn: 1, step: 0, message: {
    id: /** @type {import('@deepseek-ai/dsh-llm').MessageId} */ (`result-${id}`), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    content: [{ type: 'text', text: JSON.stringify({ answers: [{ id, selected: ['Continue'] }] }) }], isError: false,
  } }, { surfaceOp: 'append' });
}

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const [{ Context }, { default: HostRegistry }, { default: Sessions }, { default: Projections }, { default: Gateway },
    { default: RemoteAccess }, ClientRegistry, ClientGateway] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-api-gateway'),
    load('@deepseek-ai/dsh-api-remote-access'), load('@deepseek-ai/dsh-typert-registry/client'), load('@deepseek-ai/dsh-api-gateway/client'),
  ]);
  const hostContext = new Context();
  const host = /** @type {HistoryHost} */ (/** @type {unknown} */ (hostContext));
  const client = new Context();
  /** @type {import('../types/test.js').RuntimeFiber[]} */
  const fibers = [];
  /** @type {import('../types/test.js').Dispose[]} */
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  });
  for (const service of [HostRegistry, Sessions, Projections, RemoteAccess, Gateway]) fibers.push(await host.plugin(service));
  /** @type {(() => void) | undefined} */
  let unregisterProjection;
  const historyFiber = await host.plugin({
    name: 'history-query-subject', inject: ['typert', 'sessions', 'sessionProjections'],
    async apply(ctx) { unregisterProjection = ctx.sessionProjections.register(state.projection); await history.registerHistory(ctx); },
  });
  assert.ok(unregisterProjection);
  fibers.push(historyFiber);

  // Admission and network IO only: all authorization, lookup, dispatch,
  // Session storage and projection folds below are the selected real SDK services.
  const peerAbort = new AbortController();
  /** @type {Omit<PeerScope, 'principal'> & {principal: PeerScope['principal']}} */
  const peer = {
    id: /** @type {import('@deepseek-ai/dsh-typert-protocol').PeerId} */ ('history-fixture-peer'),
    ctx: hostContext, principal: { kind: 'owner' }, signal: peerAbort.signal, interactions: 'none',
    async dispose() { peerAbort.abort(); },
  };
  /** @type {{endpoint: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal}[]} */
  const calls = [];
  // The carrier can pause on an explicit gate to exercise real in-flight
  // cancellation without timers, sockets, model calls or profile access.
  /** @type {((signal: AbortSignal) => Promise<void>) | undefined} */
  let gate;
  /** @type {((value: unknown) => unknown) | undefined} */
  let rewriteResult;
  const connection = {
    interactions: 'none', isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
    rpc: {
      open: async function* () { throw new Error('Unary history must not open a stream'); },
      /** @param {string} channel @param {string} endpoint @param {{args: Readonly<Record<string, unknown>>}} payload @param {AbortSignal} signal */
      async call(channel, endpoint, payload, signal) {
        assert.equal(channel, '/api');
        assert.equal(endpoint, 'afkHistory/history');
        assert.deepEqual(Object.keys(payload.args).sort(), ['query', 'sessionId']);
        calls.push({ endpoint, args: payload.args, signal });
        await gate?.(signal);
        try {
          const value = await host.typertGateway.invoke({ namespace: 'afkHistory', method: 'history', args: payload.args, peer, signal });
          return { ok: true, value: rewriteResult ? rewriteResult(value) : value };
        } catch (error) {
          return { ok: false, error: host.typertGateway.wireStream.failure(error) };
        }
      },
    },
    openWebSocket() { throw new Error('History must not open a WebSocket'); },
    start() { throw new Error('Passive Remote must not start a Connection'); },
  };
  fibers.push(await client.plugin({ name: 'history-memory-carrier', apply(ctx) { ctx.provide('connection', connection); } }));
  // Client Registry has named apply/inject exports, not a default class.
  fibers.push(await client.plugin(ClientRegistry));
  fibers.push(await client.plugin(ClientGateway));
  const descriptor = await clientDescriptor();
  /** @type {(() => Promise<void>) | undefined} */
  let unmount;
  fibers.push(await client.plugin({ name: 'history-client-mount', inject: ['remote', 'typert'], async apply(ctx) {
    unmount = await ctx.remote.$mount({ package: 'dsh-afk', descriptors: [descriptor] });
  } }));
  /** @type {HistoryRemote | undefined} */
  let remote;
  fibers.push(await client.plugin({ name: 'history-client-consumer', inject: ['remote', 'remote.afkHistory'], apply(ctx) { remote = ctx.remote.afkHistory; } }));
  assert.ok(remote);
  assert.ok(unmount);
  const handle = remote;
  const unmountHistory = unmount;
  const a = host.sessions.create(sessionId('history-a'));
  const b = host.sessions.create(sessionId('history-b'));
  appendQuestion(a, 'a-oldest');
  appendQuestion(a, 'a-read', true);
  appendQuestion(a, 'a-newest');
  appendQuestion(b, 'b-only');
  // Materialize before taking the immutability baseline.
  const snapshot = () => [a, b].map(session => ({
    id: session.id, seq: session.seq, events: session.snapshotEvents(),
    projection: structuredClone(host.sessionProjections.stateOf(session, state.KEY)),
    checkpoint: host.sessionProjections.checkpoint(session),
  }));
  const before = structuredClone(snapshot());
  /** @type {string[]} */
  const events = [];
  const stopEvents = host.on('session/event', (_session, event) => { events.push(event.type); });
  disposers.push(() => { stopEvents(); });
  disposers.push(() => peer.dispose());
  /** @param {SessionId} id @param {HistoryQuery} query @param {AbortSignal} [signal] */
  const read = async (id, query, signal) => {
    const result = await handle.history(id, query, signal);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    assert.ok(result.ok);
    assert.equal(descriptor.result.mode, 'strict');
    if (descriptor.result.mode === 'strict') descriptor.result.create().parse(result.value);
    return result.value;
  };
  return { host, client, a, b, handle, descriptor, calls, historyFiber, unmountHistory, unregisterProjection, disposers, peer,
    snapshot, before, events, read,
    /** @param {typeof gate} next */ setGate(next) { gate = next; },
    /** @param {typeof rewriteResult} next */ setResultTransform(next) { rewriteResult = next; },
    /** @param {import('@deepseek-ai/cordis').Plugin} plugin */
    async install(plugin) { const fiber = await host.plugin(plugin); fibers.push(fiber); return fiber; },
  };
}

test('history Remote: live paging/filter/session isolation changes no event, revision or read state', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const originalState = f.host.sessionProjections.stateOf(f.a, state.KEY);
  const first = await f.read(f.a.id, { offset: 0, limit: 1, filter: 'unread' });
  assert.deepEqual({ total: first.total, totalAll: first.totalAll, unread: first.unread }, { total: 2, totalAll: 3, unread: 2 });
  assert.equal(first.records[0].questions[0].id, 'a-newest');
  const older = await f.read(f.a.id, { offset: 1, limit: 1, filter: 'unread' });
  assert.equal(older.records[0].questions[0].id, 'a-oldest');
  const all = await f.read(f.a.id, { offset: 0, limit: 50, filter: 'all' });
  assert.deepEqual(all.records.map(record => [record.questions[0].id, record.read]), [['a-newest', false], ['a-read', true], ['a-oldest', false]]);
  assert.deepEqual((await f.read(f.a.id, { offset: 99, limit: 20, filter: 'all' })).records, []);
  assert.deepEqual((await f.read(f.b.id, { offset: 0, limit: 20, filter: 'unread' })).records.map(record => record.questions[0].id), ['b-only']);
  for (let index = 0; index < 4; index++) await f.read(f.a.id, { offset: 0, limit: 20, filter: 'unread' });
  // Direct in-memory transport deliberately does not serialize results: detect
  // aliasing that an actual JSON socket would otherwise conceal.
  first.records[0].questions[0].question = 'Client-local edit';
  first.records[0].read = true;
  assert.equal((await f.read(f.a.id, { offset: 0, limit: 20, filter: 'unread' })).records[0].questions[0].question, 'Fixture a-newest?');
  assert.strictEqual(f.host.sessionProjections.stateOf(f.a, state.KEY), originalState);
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.events, [], 'all Session event types, not only command events, must remain absent');
  assert.equal(f.host.get('agents'), undefined, 'no Agent service or Agent-restoring lookup was needed');
  assert.deepEqual(f.host.sessions.list().map(session => session.id), [f.a.id, f.b.id]);
});

test('history Remote: non-owner grant for A rejects B before address lookup or Session access', { skip: !runtime }, async t => {
  const f = await fixture(t);
  // The actual registry is generic over declared driver principals. This
  // fixture supplies an isolated admission identity, not a production driver.
  const access = /** @type {{registerPolicy(kind: string, policy: {bindings(): readonly import('@deepseek-ai/dsh-api-remote-access').RemoteAccessBinding[]}): () => void}} */ (/** @type {unknown} */ (f.host.remoteAccess));
  f.disposers.push(access.registerPolicy('history-test-reader', { bindings: () => [{
    role: { name: 'history-only', resource: 'session', actions: ['afkHistory/history'] }, resource: { kind: 'session', id: f.a.id },
  }] }));
  f.peer.principal = /** @type {PeerScope['principal']} */ (/** @type {unknown} */ ({ kind: 'history-test-reader' }));
  const lookup = f.host.typert.lookups.get('afkHistoryAddress');
  assert.ok(lookup);
  /** @type {string[]} */
  const lookedUp = [];
  f.disposers.push(f.host.typert.lookups.configure('afkHistoryAddress', id => { lookedUp.push(id); return /** @type {HistoryAddress | Promise<HistoryAddress | undefined> | undefined} */ (lookup.resolve(id)); }));
  const query = { offset: 0, limit: 20, filter: /** @type {const} */ ('unread') };
  assert.equal((await f.read(f.a.id, query)).totalAll, 3, 'a dedicated history grant needs no commands/execute permission');
  assert.deepEqual(lookedUp, [f.a.id]);
  const sessionReads = t.mock.method(f.host.sessions, 'get');
  const projectionReads = t.mock.method(f.host.sessionProjections, 'stateOf');
  const denied = await f.handle.history(f.b.id, query);
  assert.equal(denied.ok, false);
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, 'remote-access/denied');
  assert.deepEqual(lookedUp, [f.a.id], 'B must be refused before running its lookup');
  assert.equal(sessionReads.mock.calls.length, 0, 'authorization must run before reading even a live Session');
  assert.equal(projectionReads.mock.calls.length, 0);
  sessionReads.mock.restore();
  projectionReads.mock.restore();
  assert.equal(f.host.remoteAccess.decide({ principal: f.peer.principal, action: 'commands/execute', resources: [{ kind: 'session', id: f.a.id }] }).kind, 'deny');
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.events, []);
});

function gate() {
  /** @type {(() => void) | undefined} */
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = () => resolvePromise(undefined); });
  assert.ok(resolve);
  return { promise, resolve };
}

test('history Remote: pre-cancelled and in-flight cancelled reads leave Session state untouched', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const query = { offset: 0, limit: 20, filter: /** @type {const} */ ('unread') };
  const before = new AbortController();
  before.abort();
  const preCancelled = await f.handle.history(f.a.id, query, before.signal);
  assert.ok(!preCancelled.ok);
  assert.equal(preCancelled.error.code, 'gateway/cancelled');
  const entered = gate();
  const release = gate();
  f.setGate(async signal => { entered.resolve(); await release.promise; signal.throwIfAborted(); });
  const during = new AbortController();
  const pending = f.handle.history(f.a.id, query, during.signal);
  await entered.promise;
  assert.equal(f.calls.at(-1)?.signal.aborted, false);
  during.abort();
  assert.equal(f.calls.at(-1)?.signal.aborted, true, 'the actual generated Remote combines and propagates its caller signal');
  release.resolve();
  const cancelled = await pending;
  assert.ok(!cancelled.ok);
  assert.equal(cancelled.error.code, 'gateway/cancelled');
  f.setGate(undefined);
  assert.equal((await f.read(f.a.id, query)).unread, 2, 'a later read remains available after caller cancellation');
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.events, []);
});

test('history Remote: Client unmount aborts in-flight calls and withdraws its namespace', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const entered = gate();
  const release = gate();
  f.setGate(async signal => { entered.resolve(); await release.promise; signal.throwIfAborted(); });
  const pending = f.handle.history(f.a.id, { offset: 0, limit: 20, filter: 'unread' });
  await entered.promise;
  await f.unmountHistory();
  assert.equal(f.calls.at(-1)?.signal.aborted, true);
  assert.equal(f.client.get('remote.afkHistory'), undefined);
  assert.equal(f.client.typert.remotes.get('afkHistory/history'), undefined);
  release.resolve();
  const result = await pending;
  assert.ok(!result.ok);
  assert.match(result.error.code, /^gateway\/(cancelled|internal)$/);
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.events, []);
});

test('history Remote: Host disposal removes descriptor/lookup/service and aborts retained service handles', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const service = f.host.afkHistory;
  await f.historyFiber.dispose();
  assert.equal(f.host.get('afkHistory'), undefined);
  assert.equal(f.host.typert.local.get('afkHistory/history'), undefined);
  assert.equal(f.host.typert.lookups.get('afkHistoryAddress'), undefined);
  await assert.rejects(service.history({ sessionId: f.a.id }, { offset: 0, limit: 20, filter: 'all' }, new AbortController().signal), /abort/i);
  const result = await f.handle.history(f.a.id, { offset: 0, limit: 20, filter: 'all' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'gateway/definition-unavailable', 'strict withdrawal must not fall back to an unvalidated SRC endpoint');
  assert.deepEqual([f.a, f.b].map(session => ({ seq: session.seq, events: session.snapshotEvents() })), f.before.map(({ seq, events }) => ({ seq, events })));
  assert.deepEqual(f.events, []);
});

/** @param {InvocationDescriptor} descriptor */
function wireShape(descriptor) {
  const { id, service, namespace, method, invocation, cancellation, parameters, result } = descriptor;
  // JSON normalization removes functions and VM-realm prototypes only; the
  // wire identities and codec modes/symbols still compare independently.
  return JSON.parse(JSON.stringify({ id, service, namespace, method, invocation, cancellation, parameters, result }));
}

test('history Remote: actual Host and Client descriptors agree and native Client parsers reject malformed wire values', { skip: !runtime }, async t => {
  const f = await fixture(t);
  assert.deepEqual(wireShape(f.descriptor), wireShape(history.historyDescriptor));
  const queryCodec = f.descriptor.parameters.find(parameter => parameter.wire === 'query')?.codec;
  const idCodec = f.descriptor.parameters.find(parameter => parameter.wire === 'sessionId')?.codec;
  assert.equal(queryCodec?.mode, 'strict');
  assert.equal(idCodec?.mode, 'strict');
  assert.equal(f.descriptor.result.mode, 'strict');
  assert.ok(queryCodec?.mode === 'strict' && idCodec?.mode === 'strict' && f.descriptor.result.mode === 'strict');
  const valid = { offset: 0, limit: 20, filter: 'all' };
  assert.deepEqual(JSON.parse(JSON.stringify(queryCodec.create().parse(valid))), valid);
  for (const value of [null, [], {}, { ...valid, extra: true }, { ...valid, offset: -1 }, { ...valid, limit: 51 }, { ...valid, filter: 'read' }]) {
    assert.throws(() => queryCodec.create().parse(value));
    assert.equal(history.historyQuerySchema.safeParse(value).success, false);
  }
  for (const value of ['', null, 1, {}, []]) assert.throws(() => idCodec.create().parse(value));
  assert.equal(idCodec.create().parse(f.a.id), f.a.id);
  const page = await f.read(f.a.id, { offset: 0, limit: 20, filter: 'all' });
  const parse = f.descriptor.result.create().parse;
  const row = page.records[0];
  for (const invalid of [null, {}, { ...page, extra: true }, { ...page, total: -1 }, { ...page, unread: 0.5 },
    { ...page, records: [{ ...row, mode: 'invented' }] }, { ...page, records: [{ ...row, afk: 'false' }] },
    { ...page, records: [{ ...row, requestState: { scope: 'session', enabled: true, mode: 'auto-reply', extra: true } }] },
    { ...page, records: [{ ...row, questions: [] }] }, { ...page, records: [{ ...row, questions: [row.questions[0], row.questions[0]] }] },
  ]) {
    assert.equal(history.historyResultSchema.safeParse(invalid).success, false);
    assert.throws(() => parse(invalid));
    f.setResultTransform(() => invalid);
    const result = await f.handle.history(f.a.id, { offset: 0, limit: 20, filter: 'all' });
    assert.ok(!result.ok, 'the actual mounted Client descriptor must decode, not just advertise a strict create() parser');
    assert.equal(result.error.code, 'gateway/internal');
    assert.match(result.error.message, /Invalid AFK history/);
  }
  f.setResultTransform(undefined);
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.events, []);
});

/**
 * Only the storage IO seam is in memory. The observed Session preparation,
 * leases, replay validation and projection restore are unmodified SDK code.
 * @param {Awaited<ReturnType<typeof fixture>>} f
 */
async function coldStorage(f) {
  const [{ Session }, { SessionQueryEngine }] = await Promise.all([
    load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-query'),
  ]);
  const a = Session.create(sessionId('history-cold-a'));
  const b = Session.create(sessionId('history-cold-b'));
  appendQuestion(a, 'cold-oldest');
  appendQuestion(a, 'cold-read', true);
  appendQuestion(a, 'cold-newest');
  appendQuestion(b, 'cold-b-only');
  const sources = new Map([a, b].map(session => [session.id, {
    header: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents(),
  }]));
  const before = structuredClone([...sources]);
  /** @type {{stat: string[], open: string[], read: string[], close: string[]}} */
  const io = { stat: [], open: [], read: [], close: [] };
  /** @type {((signal: AbortSignal | undefined) => Promise<void>) | undefined} */
  let readGate;
  const persistence = {
    identity: {},
    /** @param {SessionId} id @param {{signal?: AbortSignal}} [options] */
    async stat(id, options) {
      options?.signal?.throwIfAborted();
      io.stat.push(id);
      const source = sources.get(id);
      return source && { header: structuredClone(source.header), revision: `${id}:1`, formatStatus: 'current' };
    },
    /** @param {SessionId} id @param {string} mode @param {{signal?: AbortSignal}} [options] */
    async open(id, mode, options) {
      assert.equal(mode, 'read', 'a history query may not obtain a writer');
      options?.signal?.throwIfAborted();
      io.open.push(id);
      const source = sources.get(id);
      assert.ok(source);
      return {
        header: structuredClone(source.header), inheritedEventCount: source.inheritedEventCount,
        /** @param {number} offset @param {number | undefined} limit @param {{signal?: AbortSignal}} [readOptions] */
        async read(offset, limit, readOptions) {
          assert.equal(offset, 0);
          assert.equal(limit, undefined);
          io.read.push(id);
          await readGate?.(readOptions?.signal);
          readOptions?.signal?.throwIfAborted();
          return { events: structuredClone(source.events), eventState: 'detached' };
        },
        async close() { io.close.push(id); },
        append() { throw new Error('Read-only history must not append to persistence'); },
      };
    },
    list() { throw new Error('Exact history reads must not list the persisted corpus'); },
  };
  await f.install({ name: 'history-storage-io', apply(ctx) { ctx.provide('sessionPersistence', persistence); } });
  await f.install({ name: 'history-real-session-query', inject: ['sessions'], apply(ctx) {
    // Abstract in declarations only because full-text search needs a backend.
    // Its concrete observation constructor is the released implementation;
    // no subclass or test-authored observation service replaces its behavior.
    Reflect.construct(SessionQueryEngine, [ctx, { preparedSessionCacheSize: 1 }]);
  } });
  assert.ok(f.host.sessionQuery instanceof SessionQueryEngine);
  return { a, b, io, sources, before,
    /** @param {typeof readGate} next */ setReadGate(next) { readGate = next; },
  };
}

test('history Remote: cold sessions use real observation/restore without publishing Sessions or leaking successful leases', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const cold = await coldStorage(f);
  const observations = t.mock.method(f.host.sessionQuery, 'observeSession');
  /** @type {string[]} */
  const published = [];
  const stopCreated = f.host.on('session/created', session => { published.push(session.id); });
  f.disposers.push(() => { stopCreated(); });
  const first = await f.read(cold.a.id, { offset: 0, limit: 1, filter: 'unread' });
  assert.equal(first.totalAll, 3);
  assert.equal(first.unread, 2);
  assert.equal(first.records[0].questions[0].id, 'cold-newest');
  const all = await f.read(cold.a.id, { offset: 1, limit: 2, filter: 'all' });
  assert.deepEqual(all.records.map(record => [record.questions[0].id, record.read]), [['cold-read', true], ['cold-oldest', false]]);
  assert.deepEqual(cold.io.read, [cold.a.id], 'unchanged observations reuse the actual SDK prepared cache');
  for (const call of observations.mock.calls) {
    assert.equal(call.arguments[1]?.projectionMode, 'none');
    assert.ok(call.arguments[1]?.signal instanceof AbortSignal);
    const observation = await call.result;
    assert.ok(observation);
    assert.throws(() => observation.retain(), /disposed/, 'the business service must release the real lease before resolving');
  }
  // Capacity one + A/B/A demonstrates leases did not pin old prepared entries.
  assert.equal((await f.read(cold.b.id, { offset: 0, limit: 20, filter: 'all' })).records[0].questions[0].id, 'cold-b-only');
  await f.read(cold.a.id, { offset: 0, limit: 20, filter: 'all' });
  assert.deepEqual(cold.io.read, [cold.a.id, cold.b.id, cold.a.id]);
  assert.deepEqual(cold.io.open, cold.io.close, 'every real cold read closes its persistence handle');
  assert.equal(f.host.sessions.get(cold.a.id), undefined);
  assert.equal(f.host.sessions.get(cold.b.id), undefined);
  assert.equal(f.host.get('agents'), undefined);
  assert.deepEqual(published, []);
  assert.deepEqual([...cold.sources], cold.before);
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.events, []);
});

test('history Remote: cold lookup denial precedes storage IO and cold cancellation closes read handles', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const cold = await coldStorage(f);
  f.peer.principal = /** @type {PeerScope['principal']} */ (/** @type {unknown} */ ({ kind: 'ungranted-history-reader' }));
  const denied = await f.handle.history(cold.a.id, { offset: 0, limit: 20, filter: 'all' });
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, 'remote-access/denied');
  assert.deepEqual(cold.io, { stat: [], open: [], read: [], close: [] });
  f.peer.principal = { kind: 'owner' };
  const entered = gate();
  const release = gate();
  cold.setReadGate(async signal => { entered.resolve(); await release.promise; signal?.throwIfAborted(); });
  const controller = new AbortController();
  const pending = f.handle.history(cold.a.id, { offset: 0, limit: 20, filter: 'all' }, controller.signal);
  await entered.promise;
  controller.abort();
  release.resolve();
  const cancelled = await pending;
  assert.ok(!cancelled.ok);
  assert.equal(cancelled.error.code, 'gateway/cancelled');
  assert.deepEqual(cold.io.open, cold.io.close, 'SessionQuery must close its real persistence read even when IO aborts');
  cold.setReadGate(undefined);
  assert.equal((await f.read(cold.a.id, { offset: 0, limit: 20, filter: 'all' })).totalAll, 3);
  assert.equal(f.host.sessions.get(cold.a.id), undefined);
  assert.deepEqual([...cold.sources], cold.before);
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.events, []);
});

test('history Remote: cold failure after observation still disposes its acquired lease', { skip: !runtime }, async t => {
  const f = await fixture(t);
  const cold = await coldStorage(f);
  f.unregisterProjection();
  const failed = await f.handle.history(cold.a.id, { offset: 0, limit: 20, filter: 'all' });
  assert.ok(!failed.ok);
  assert.equal(failed.error.code, 'afk-history/unavailable');
  assert.deepEqual(cold.io.open, cold.io.close);
  assert.equal(f.host.sessions.get(cold.a.id), undefined);
  assert.deepEqual([...cold.sources], cold.before);
  assert.deepEqual([f.a, f.b].map(session => ({ seq: session.seq, events: session.snapshotEvents() })), f.before.map(({ seq, events }) => ({ seq, events })));
  assert.deepEqual(f.events, []);
});

test('history Remote: Host unload cancels an in-flight cold observation and closes storage IO', { skip: !runtime, timeout: 5000 }, async t => {
  const f = await fixture(t);
  const cold = await coldStorage(f);
  const entered = gate();
  const aborted = gate();
  const release = gate();
  cold.setReadGate(async signal => {
    assert.ok(signal);
    signal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve();
    try { await release.promise; signal.throwIfAborted(); }
    finally { signal.removeEventListener('abort', aborted.resolve); }
  });
  const pending = f.handle.history(cold.a.id, { offset: 0, limit: 20, filter: 'unread' });
  await entered.promise;
  const disposing = f.historyFiber.dispose();
  await aborted.promise;
  release.resolve();
  await disposing;
  const result = await pending;
  assert.ok(!result.ok);
  assert.match(result.error.message, /abort/i);
  assert.deepEqual(cold.io.open, cold.io.close);
  assert.equal(f.host.sessions.get(cold.a.id), undefined);
  assert.deepEqual([...cold.sources], cold.before);
  assert.deepEqual([f.a, f.b].map(session => ({ seq: session.seq, events: session.snapshotEvents() })), f.before.map(({ seq, events }) => ({ seq, events })));
  assert.deepEqual(f.events, []);
});
