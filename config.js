import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_REPLY, settingsOf } from './state.js';

const defaults = { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY };

// Whole-object volatility makes enabled/mode/reply one committed snapshot.
export const Config = Schema.object({
  scope: Schema.union(['session', 'global']).default('session').volatile(),
  global: Schema.object({
    enabled: Schema.boolean().default(false),
    mode: Schema.union(['auto-reply', 'disable-ask']).default('auto-reply'),
    reply: Schema.string().min(1).max(2000).pattern(/\S/).default(DEFAULT_REPLY),
  }).default(defaults).volatile(),
});

const current = value => value && typeof value.get === 'function' ? value.get() : value;

/** Read live references on every use; also accept ordinary programmatic config values. */
export function readConfig(config = {}) {
  return { scope: current(config.scope) ?? 'session', global: current(config.global) ?? defaults };
}

export function effectiveSettings(config, state) {
  const { scope, global } = readConfig(config);
  const { enabled, mode, reply } = scope === 'global' ? global : settingsOf(state);
  return { scope, enabled, mode, reply };
}
