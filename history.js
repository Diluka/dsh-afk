/// <reference path="./types/host.d.ts" />
/// <reference path="./types/history.d.ts" />
/** @import { Context } from '@deepseek-ai/cordis' */
/** @import { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol' */
/** @import { HistoryAddress, HistoryQuery } from './types/history.js' */
/** @import { HistoryReader } from './types/host.js' */
/** @import { AfkHistory } from './types/afk.js' */
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { KEY, recordSchema, historyOf } from './state.js';

export const historyQuerySchema = z.object({
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50), filter: z.enum(['unread', 'all']),
}).strict();
export const historyResultSchema = z.object({
  total: z.number().int().nonnegative(), totalAll: z.number().int().nonnegative(), unread: z.number().int().nonnegative(),
  ...historyQuerySchema.shape, records: z.array(recordSchema),
}).strict();

// Explicit public Typert contract: no decorator syntax, generated build or command invocation.
/** @type {InvocationDescriptor} */
export const historyDescriptor = {
  id: 'dsh-afk#history', service: 'afkHistory', namespace: 'afkHistory', method: 'history',
  invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
  parameters: [
    { name: 'afkAddress', wire: 'sessionId', source: 'lookup', lookup: 'afkHistoryAddress',
      codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string().min(1) } },
    { name: 'query', wire: 'query', source: 'json',
      codec: { mode: 'strict', typeSymbol: 'dsh-afk#HistoryQuery', create: () => historyQuerySchema } },
  ],
  result: { mode: 'strict', typeSymbol: 'dsh-afk#AfkHistory', create: () => historyResultSchema },
  description: 'Read one AFK history page without changing the Session log or activating an Agent.',
};

/** @implements {HistoryReader} */
export class AfkHistoryService extends TypertRemoteService {
  static inject = ['sessions', 'sessionProjections'];
  /** @param {Context} ctx */
  constructor(ctx) {
    super(ctx, 'afkHistory');
    // The SDK augments the same Context name for Host and Client sessions; this
    // injected Host service is the real SessionStore, never the Client facade.
    this.sessions = /** @type {import('@deepseek-ai/dsh-session').SessionStore} */ (/** @type {unknown} */ (ctx.sessions));
    this.lifetime = new AbortController();
    ctx.effect(() => () => this.lifetime.abort());
  }

  /** @param {HistoryAddress} address @param {HistoryQuery} query @param {AbortSignal} callerSignal @returns {Promise<AfkHistory>} */
  async history(address, query, callerSignal) {
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    signal.throwIfAborted();
    const { offset, limit, filter } = query;
    const live = this.sessions.get(address.sessionId);
    if (live) {
      const state = this.ctx.sessionProjections.stateOf(live, KEY);
      if (!state) throw new RemoteError('afk-history/unavailable', 'AFK history is unavailable', {});
      return structuredClone(historyOf(state, offset, limit, filter));
    }
    // Cold reads use the Host observation/restore APIs, never the Agent-restoring lookup.
    const reader = this.ctx.get('sessionQuery');
    if (!reader) throw new RemoteError('afk-history/unavailable', 'AFK history source is unavailable', {});
    const observation = await reader.observeSession(address.sessionId, { signal, projectionMode: 'none' });
    try {
      signal.throwIfAborted();
      const restored = this.ctx.sessionProjections.restore({}, observation.events,
        /** @type {import('@deepseek-ai/dsh-session').SessionLogOffset} */ (0), observation.header, observation.inheritedEventCount);
      const row = restored.checkpoint[KEY];
      if (!row) throw new RemoteError('afk-history/unavailable', 'AFK history is unavailable', {});
      // restore() seeds each usable row through stateSchema and otherwise folds init/apply,
      // so its refreshed checkpoint value is already projection state.
      const state = /** @type {import('./types/afk.js').AfkState} */ (row.val);
      return structuredClone(historyOf(state, offset, limit, filter));
    } finally {
      observation[Symbol.dispose]();
    }
  }
}

/** @param {Context} ctx */
export async function registerHistory(ctx) {
  ctx.typert.lookups.register('afkHistoryAddress', {
    parameter: 'afkAddress', wire: 'sessionId', resource: 'session',
    hostTypeSymbol: 'dsh-afk#HistoryAddress', wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: sessionId => ({ sessionId }),
  });
  ctx.typert.register({
    package: 'dsh-afk', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: [historyDescriptor],
  });
  await ctx.plugin(AfkHistoryService);
}
