import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { Scope } from '@deepseek-ai/dsh-scope';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { AfkHistory, AfkReadReceipt, AfkSettings, AfkView, AfkScope } from './afk.js';
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions';

/** Dynamic imports resolve from DSH_TEST_RUNTIME_DIR; declarations follow the matching installed SDK, never a mock service. */
export interface RuntimeModules {
  '@deepseek-ai/cordis': typeof import('@deepseek-ai/cordis');
  '@deepseek-ai/cordis-plugin-loader': typeof import('@deepseek-ai/cordis-plugin-loader');
  '@deepseek-ai/dsh-system-prompt': typeof import('@deepseek-ai/dsh-system-prompt');
  '@deepseek-ai/dsh-tools': typeof import('@deepseek-ai/dsh-tools');
  '@deepseek-ai/dsh-session': typeof import('@deepseek-ai/dsh-session');
  '@deepseek-ai/dsh-agent': typeof import('@deepseek-ai/dsh-agent');
  '@deepseek-ai/dsh-commands': typeof import('@deepseek-ai/dsh-commands');
  '@deepseek-ai/dsh-session-projection': typeof import('@deepseek-ai/dsh-session-projection');
  '@deepseek-ai/dsh-user-questions': typeof import('@deepseek-ai/dsh-user-questions');
  '@deepseek-ai/dsh-tool-ask-user': typeof import('@deepseek-ai/dsh-tool-ask-user');
  '@deepseek-ai/dsh-scope': typeof import('@deepseek-ai/dsh-scope');
  '@deepseek-ai/dsh-config-editor': typeof import('@deepseek-ai/dsh-config-editor');
  '@deepseek-ai/dsh-settings': typeof import('@deepseek-ai/dsh-settings');
  '@deepseek-ai/dsh-app-boot': typeof import('@deepseek-ai/dsh-app-boot');
  '@deepseek-ai/dsh-llm': typeof import('@deepseek-ai/dsh-llm');
  '@deepseek-ai/dsh-typert-registry/client': typeof import('@deepseek-ai/dsh-typert-registry/client');
  '@deepseek-ai/dsh-api-gateway/client': typeof import('@deepseek-ai/dsh-api-gateway/client');
  '@deepseek-ai/dsh-commands/remote': typeof import('@deepseek-ai/dsh-commands/remote');
}
export type RuntimeLoader = <K extends keyof RuntimeModules>(name: K) => Promise<RuntimeModules[K]>;
export type Dispose = () => void | Promise<void>;
export type RuntimeFiber = Fiber;
export type RuntimeScope = Scope;
/** Tests deliberately omit the Agent driver/inbox/model capabilities: only id, Session and scoped Context are consumed by these real services. The construction-site unknown assertion is the explicit fixture boundary. ctx remains writable only while that fixture scope is assembled. */
export type FixtureAgent = Omit<Agent, 'ctx'> & { ctx: Context };
/** Official Client and Host packages augment one Context name although sessions is platform-specific. These fixtures install the real Host SessionStore, not the Client sessions facade. */
export type FixtureHostContext = Omit<Context, 'sessions'> & { sessions: import('@deepseek-ai/dsh-session').SessionStore };

/** Only these real tools are exercised by the generic dispatch fixture. Tool output schemas validate the canonical values before the fixture observes them. */
export interface FixtureToolValues {
  ask_user_question: AskUserQuestionAnswer;
  afk_history: AfkHistory;
  afk_mark_read: AfkReadReceipt;
}
export type FixtureToolResult<K extends keyof FixtureToolValues> = ToolExecutionResult extends infer R
  ? R extends { isError: false } ? Omit<R, 'value' | 'meta'> & { value: FixtureToolValues[K]; meta?: { dshAfkRead?: AfkReadReceipt } } : R
  : never;

/** Fixtures know which public command grammar they submitted; raw transport parsing stays unknown until this call-site contract assertion. */
type CommandInput<L extends string> = L extends `/afk ${infer Input}` ? Input : L extends '/afk' ? '' : L;
export type FixtureCommandValue<L extends string> = CommandInput<L> extends 'history' | `history ${string}` ? AfkHistory
  : CommandInput<L> extends `read ${string}` ? AfkReadReceipt
  : CommandInput<L> extends `set ${string}` | 'on' | 'off' ? { type: 'dsh-afk/settings-v1'; settings: AfkSettings }
  : AfkView & { scope: AfkScope };
export type CommandCarrierArgs = { args: { agentId: import('@deepseek-ai/dsh-session').SessionId; line: string; submittedAttachments: readonly import('@deepseek-ai/dsh-commands').CommandSubmitAttachment[] } };

/** Minimal VM-only formatter boundary: no Client factory/global runtime or React is loaded. */
export type FormatterNode = { name?: string; outcome?: { kind: string; text?: string } | null };
export type FormatterTranslate = (key: string, values?: Record<string, unknown>) => string;
export type Formatter = (node: FormatterNode, t: FormatterTranslate) => { text: string; state: string };
