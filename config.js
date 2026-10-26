/// <reference path="./types/host.d.ts" />
/** @typedef {import('./types/afk.js').AfkSettings} AfkSettings */
/** @typedef {import('./types/afk.js').AfkState} AfkState */
/** @typedef {import('./types/afk.js').AfkPreferences} AfkPreferences */
/** @typedef {import('./types/host.js').AfkConfigInput} AfkConfigInput */
/** @typedef {import('./types/host.js').EffectiveSettings} EffectiveSettings */
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_REPLY, settingsOf } from './state.js';

/** @type {AfkSettings} */
const defaults = { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY };

// Whole-object volatility makes enabled/mode/reply one committed snapshot.
export const Config = Schema.object({
  toolsEnabled: Schema.boolean().default(true).volatile(),
  scope: Schema.union(['session', 'global']).default('session').volatile(),
  global: Schema.object({
    enabled: Schema.boolean().default(false),
    mode: Schema.union(['auto-reply', 'disable-ask']).default('auto-reply'),
    reply: Schema.string().min(1).max(2000).pattern(/\S/).default(DEFAULT_REPLY),
  }).default(defaults).volatile(),
});

/**
 * @template T
 * @param {import('./types/host.js').LiveConfigValue<T>} value
 * @returns {T | import('./types/host.js').LiveConfigSnapshot<T>}
 */
const current = value => value && typeof value === 'object' && 'get' in value && typeof value.get === 'function'
  ? value.get() : /** @type {T} */ (value);

/**
 * Read live references on every use; also accept ordinary programmatic config values.
 * @param {AfkConfigInput} [config]
 * @returns {AfkPreferences}
 */
export function readConfig(config = {}) {
  return { toolsEnabled: current(config.toolsEnabled) ?? true, scope: current(config.scope) ?? 'session', global: current(config.global) ?? defaults };
}

/**
 * @param {AfkConfigInput | undefined} config
 * @param {AfkState} state
 * @returns {EffectiveSettings}
 */
export function effectiveSettings(config, state) {
  const { scope, global } = readConfig(config);
  const { enabled, mode, reply } = scope === 'global' ? global : settingsOf(state);
  return { scope, enabled, mode, reply };
}
