/**
 * Compile-only negative checks: these are never emitted or executed.
 * Each expected error must continue to exist, so accidentally widening an
 * application boundary to `any` makes `pnpm typecheck` fail with an unused directive.
 */
import type { AfkSettings, AfkState, AfkView, AfkPreferences } from './afk.js';
import type { ClientModuleRequire, AfkClientContext, AfkToolbarSlotProps } from './client.js';
import { historyOf, settingsOf } from '../state.js';
import type { HistoryAddress, HistoryQuery } from './history.js';
import type { HistoryReader } from './host.js';
import type { AfkHistoryService } from '../history.js';

declare const state: AfkState;
declare const view: AfkView;
declare const preferences: AfkPreferences;
declare const requireClient: ClientModuleRequire;

// The compile-only test is a consumer of both layers; declarations themselves
// must not import the implementation to establish this relationship.
declare const historyService: AfkHistoryService;
declare const historyAddress: HistoryAddress;
declare const historyQuery: HistoryQuery;
const historyReader: HistoryReader = historyService;
const historyPage: Promise<import('./afk.js').AfkHistory> = historyReader.history(historyAddress, historyQuery, new AbortController().signal);
// @ts-expect-error Host readers require the authorized address object, not a wire string.
historyReader.history('session-id', historyQuery, new AbortController().signal);
// @ts-expect-error A history implementation must return a complete page, not just records.
const incompleteHistoryReader: HistoryReader = { history: async () => ({ records: [] }) };
declare const hostContext: import('./host.js').HostContext;
// @ts-expect-error The Host capability does not expose the implementation's cancellation controller.
hostContext.afkHistory.lifetime;
void historyPage;
void incompleteHistoryReader;

const settings: AfkSettings = settingsOf(state);
const page = historyOf(state, 0, 20, 'unread');
const reply: string = page.records[0].reply;
void settings;
void reply;

// @ts-expect-error Settings switches accept booleans, not truthy strings.
view.enabled = 'yes';
// @ts-expect-error Shared scope has exactly the two user-facing modes.
preferences.scope = 'all';
// @ts-expect-error History queries have only unread/all filters.
historyOf(state, 0, 20, 'recent');
// @ts-expect-error Reply text is not a numeric result even after projection.
const invalidReply: number = page.records[0].reply;
// @ts-expect-error Browser lazy factories cannot import Node's filesystem.
requireClient('node:fs');
void invalidReply;

declare const client: AfkClientContext;
declare const toolbar: AfkToolbarSlotProps;
// @ts-expect-error The generated Commands remote requires a Session id, not a number.
client.remote.commands.execute(42, '/afk', [], new AbortController().signal);
// @ts-expect-error ConfigForms only accepts the official set/unset operations.
client.configForms.get<AfkPreferences>('dsh-afk').mutate([{ op: 'approve', path: ['scope'], value: 'global' }]);
const projected = toolbar.useProjection('dsh-afk');
if (projected) {
  // @ts-expect-error The official projection table preserves the boolean view field.
  const invalidSwitch: number = projected.enabled;
  void invalidSwitch;
}
