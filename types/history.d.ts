import type { SessionId } from '@deepseek-ai/dsh-session';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { AfkHistory } from './afk.d.ts';

export interface HistoryQuery {
  offset: number;
  limit: number;
  filter: 'unread' | 'all';
}
/** An authorized address, not an Agent lookup: reading must never activate an Agent. */
export interface HistoryAddress { sessionId: SessionId }
export interface HistoryRemote {
  history(sessionId: SessionId, query: HistoryQuery, signal?: AbortSignal): Promise<RemoteResult<AfkHistory>>;
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'afkHistory/history': HistoryRemote['history'];
  }
  interface TypertRemoteNamespaceMap {
    afkHistory: HistoryRemote;
  }
  interface RemoteErrorDetailsMap {
    'afk-history/unavailable': {};
    'afk-history/not-found': {};
  }
}
