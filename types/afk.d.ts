/** JSON-shaped business contracts shared by Host projections and Client views. */
export type AfkMode = 'auto-reply' | 'disable-ask';
export type AfkScope = 'session' | 'global';
export interface AfkSettings {
  enabled: boolean;
  mode: AfkMode;
  reply: string;
}
export interface AfkRequestState {
  scope: AfkScope;
  enabled: boolean;
  mode: AfkMode;
}
export interface AfkQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export interface AfkRecord {
  id: string;
  callId: string;
  time: number;
  mode: AfkMode | null;
  afk: boolean | null;
  requestState: AfkRequestState | null;
  questions: AfkQuestion[];
  reply: string;
  read: boolean;
  status: 'pending' | 'auto-replied' | 'blocked' | 'answered' | 'failed';
  answer?: unknown;
}
export interface AfkView extends AfkSettings {
  total: number;
  unread: number;
  revision: number;
}
export interface AfkState {
  floor: number;
  view: AfkView;
  records: AfkRecord[];
  requestState: AfkRequestState | null;
  commands: string[];
  pending: { callId: string; time: number; seq: number; questions: AfkQuestion[] }[];
  marks: string[];
}
export interface AfkHistory {
  total: number;
  totalAll: number;
  unread: number;
  filter: 'unread' | 'all';
  offset: number;
  limit: number;
  records: AfkRecord[];
}
export interface AfkReadReceipt {
  type: 'dsh-afk/read-v1';
  readIds: string[];
}
export interface AfkPreferences {
  scope: AfkScope;
  global: AfkSettings;
}

/** Official merge-extensible projection tables, shared by Host and Client. */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'dsh-afk': AfkView;
  }
  interface SessionProjectionStateMap {
    'dsh-afk': AfkState;
  }
}
