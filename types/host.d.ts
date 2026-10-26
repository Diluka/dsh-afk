import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolResult } from '@deepseek-ai/dsh-tools';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import type { AfkScope, AfkSettings, AfkHistory } from './afk.d.ts';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { TypertLookup } from '@deepseek-ai/dsh-typert-protocol';
import type { HistoryAddress, HistoryQuery } from './history.d.ts';
// Include the SDK's Host declaration augmentations.
import '@deepseek-ai/schemastery';
import '@deepseek-ai/cordis-plugin-loader';
import '@deepseek-ai/dsh-commands';
import '@deepseek-ai/dsh-system-prompt';
import '@deepseek-ai/dsh-settings';
import '@deepseek-ai/dsh-typert-registry';
import '@deepseek-ai/dsh-session-query';

/** Host capability contract. Implementations depend on it, never the reverse. */
export interface HistoryReader {
  history(address: HistoryAddress, query: HistoryQuery, signal: AbortSignal): Promise<AfkHistory>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    afkHistory: HistoryReader;
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    afkHistoryAddress: TypertLookup<HistoryAddress, SessionId>;
  }
}

/** The read face of Schemastery's official volatile output. */
export type LiveConfigValue<T> = T | Pick<ReturnType<Schemastery<T, T, 'volatile-defined'>>, 'get'>;
export type LiveConfigSnapshot<T> = ReturnType<ReturnType<Schemastery<T, T, 'volatile-defined'>>['get']>;
/** Plugin-owned config accepts Loader live references or plain programmatic values. */
export type AfkConfigInput = Partial<{
  toolsEnabled: LiveConfigValue<boolean>;
  scope: LiveConfigValue<AfkScope>;
  global: LiveConfigValue<AfkSettings>;
}>;
export type EffectiveSettings = AfkSettings & { scope: AfkScope };
export type HostContext = Context;
export type HostAgent = Agent;
export type AgentEffects = {
  sync(): void;
  dispose(): void | Promise<void>;
  ready?: Fiber & PromiseLike<Fiber>;
};

/** Final Session results may omit isError for successful native messages. */
export type LoggedToolResult = Pick<ToolResult, 'meta'> & { content: Readonly<ToolResult['content']>; isError?: boolean };
export type LogCoordinates = { seq: number; time: number };
export type AfkProjection = ProjectionDefinition<'dsh-afk'> & {
  wire: NonNullable<ProjectionDefinition<'dsh-afk'>['wire']>;
};
