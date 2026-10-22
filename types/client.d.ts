import type { Context } from '@deepseek-ai/cordis';
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client';
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { ConfigFormSnapshot, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { AfkHistory, AfkPreferences, AfkRecord } from './afk.js';
// Load the owners' actual Slot/standard-kit declarations, never runtime modules.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-api-remote-access/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote';

/** Only React is a module-table dependency of this unbuilt browser artifact. */
export interface ClientModuleMap {
  react: typeof import('react');
}
export type ClientModuleRequire = <K extends keyof ClientModuleMap>(id: K) => ClientModuleMap[K];

/** The concrete Client services this plugin consumes, without the Host sessions merge. */
export type AfkClientContext = Pick<Context, 'effect' | 'on'> & {
  locale: Pick<LocaleRuntime, 'register' | 'bind' | 'subscribe' | 'getSnapshot'>;
  configForms: Pick<ConfigForms, 'get' | 'describe'>;
  remote: Pick<ClientRemote, 'commands'>;
  sessions: Pick<ISessions, 'retain'>;
  slots: Pick<SlotRegistry, 'register' | 'inject'>;
};
export interface AfkClientModule {
  inject: string[];
  apply(ctx: AfkClientContext): void;
}
/** Plugin-specific refinement of the documented lazy factory registration protocol. */
export interface AfkClientRegistration {
  id: 'dsh-afk';
  factory(require: ClientModuleRequire): AfkClientModule;
}

declare global {
  interface Window {
    /** Present in Harness, which is the only execution environment for client.js. */
    __ModuleLoader__: { load(registration: AfkClientRegistration): void };
  }
}

export type AfkToolbarSlotProps = PropsRuntime<'conversation.input.left'>;
export type AfkBundleConfigProps = PropsRuntime<'plugins.bundle.config'>;
export type AfkCommandViewProps = PropsRuntime<'conversation.chat.commandview'>;
export type AfkPreferencesSnapshot = ConfigFormSnapshot<AfkPreferences>;
export type ReadyAfkPreferences = AfkPreferencesSnapshot & {
  status: 'ready';
  value: AfkPreferences;
  revision: number;
};
export interface LegacyProof {
  snapshot: AfkPreferencesSnapshot;
  epoch: number;
  legacy: boolean;
}
/** History presentation consumes only these fields, including from a supported legacy Host. */
export type HistoryRecordView = Pick<AfkRecord, 'id' | 'callId' | 'time' | 'questions' | 'reply' | 'read' | 'status' | 'answer'>;
export type HistoryPage = Omit<AfkHistory, 'records'> & { records: HistoryRecordView[] };
export interface HistoryLoadState {
  loading: boolean;
  data: HistoryPage | null;
  error: string;
}
export interface CommandSummary {
  state: 'running' | 'success' | 'error';
  text: string;
}
