import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';

/** @import { AfkPreferences } from '../types/afk.d.ts' */
/** @import { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client' */
/** @typedef {Omit<AfkPreferences, 'toolsEnabled'> & { toolsEnabled?: unknown }} WirePreferences */
/** @typedef {{ status: 'ready', value: WirePreferences, revision: number, writable: boolean }} Snapshot */
/** @typedef {{ type: string, props: Record<string, unknown>, children: unknown[] }} Element */

// Like the formatter VM tests, this exercises production logic, not React, DOM,
// ConfigForms transport, or the real GUI. Hooks retain state across explicit renders.
const source = await readFile(process.env.DSH_TEST_PLUGIN_DIR
  ? join(process.env.DSH_TEST_PLUGIN_DIR, 'client.js') : new URL('../client.js', import.meta.url), 'utf8');
/** @param {RegExp} pattern */
function production(pattern) {
  const match = source.match(pattern);
  assert.ok(match, `Production definition not found: ${pattern}`);
  return match[0];
}
const definitions = [
  production(/^    const dictionaries = \{[\s\S]*?^    \};/m),
  production(/^    const profileSettingsOf = .*;$/m),
  production(/^    const failureText = [\s\S]*?;/m),
  production(/^        const preferencesReady = [\s\S]*?;/m),
  production(/^        const requireAccepted = .*;$/m),
  production(/^        function ScopeSettings\([\s\S]*?^        \}/m),
].join('\n');

/** @param {Partial<WirePreferences>} [value] @param {number} [revision] @returns {Snapshot} */
function snapshotOf(value = {}, revision = 3) {
  return { status: 'ready', value: { scope: 'session', toolsEnabled: true,
    global: { enabled: true, mode: 'disable-ask', reply: 'Preserve the shared AFK policy.' }, ...value }, revision, writable: true };
}

/** @param {Snapshot} [initial] @param {'zh' | 'en'} [language] */
function editor(initial = snapshotOf(), language = 'zh') {
  let snapshot = initial;
  let allowed = true;
  let accepted = true;
  let failure = '';
  /** @type {{ ops: readonly SettingsPathOpView[], revision: number | undefined }[]} */
  const writes = [];
  const preferencesForm = {
    getSnapshot: () => snapshot,
    /** @param {readonly SettingsPathOpView[]} ops @param {number} [revision] */
    async mutate(ops, revision) {
      writes.push({ ops: structuredClone(ops), revision });
      if (failure) throw new Error(failure);
      if (!accepted) return false; // ConfigForms has already recovered its mirror.
      const value = { ...snapshot.value };
      for (const op of ops) {
        assert.equal(op.op, 'set');
        assert.equal(op.path.length, 1, 'The profile editor must not touch nested AFK settings');
        if (op.op !== 'set') assert.fail('Expected a field set');
        if (op.path[0] === 'scope') {
          assert.ok(op.value === 'session' || op.value === 'global');
          value.scope = op.value;
        } else {
          assert.equal(op.path[0], 'toolsEnabled');
          assert.equal(typeof op.value, 'boolean');
          value.toolsEnabled = op.value;
        }
      }
      snapshot = { ...snapshot, value, revision: snapshot.revision + 1 };
      return true;
    },
  };
  /** @type {unknown[]} */
  const cells = [];
  /** @type {Map<number, { deps: readonly unknown[], cleanup?: () => void }>} */
  const effects = new Map();
  /** @type {(() => void)[]} */
  let pendingEffects = [];
  let cursor = 0;
  let rerender = false;
  const React = {
    /** @template T @param {T | (() => T)} initialValue @returns {[T, (value: T | ((previous: T) => T)) => void]} */
    useState(initialValue) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initialValue === 'function'
        ? /** @type {() => T} */ (initialValue)() : initialValue;
      return [/** @type {T} */ (cells[index]), value => {
        cells[index] = typeof value === 'function'
          ? /** @type {(previous: T) => T} */ (value)(/** @type {T} */ (cells[index])) : value;
        rerender = true;
      }];
    },
    /** @template T @param {T} value @returns {{ current: T }} */
    useRef(value) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: value };
      return /** @type {{ current: T }} */ (cells[index]);
    },
    /** @param {() => void | (() => void)} effect @param {readonly unknown[]} deps */
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = effects.get(index);
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pendingEffects.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        effects.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined });
      });
    },
    useId: () => 'afk-profile-test',
  };
  /** @param {string} type @param {Record<string, unknown> | null} props @param {...unknown} children @returns {Element} */
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const renderEditor = /** @type {(props: { preferences: Snapshot, allowed: boolean }) => Element} */ (vm.runInNewContext(
    `${definitions}\nconst t = key => dictionaries[language][key];\nScopeSettings;`,
    { React, h, preferencesForm, AbortController, language },
  ));
  /** @type {Element} */
  let tree;
  function render() {
    let rounds = 0;
    do {
      assert.ok(rounds++ < 10, 'The editor must settle after effects');
      cursor = 0; rerender = false; pendingEffects = [];
      tree = renderEditor({ preferences: snapshot, allowed });
      for (const effect of pendingEffects) effect();
    } while (rerender);
  }
  /** @param {unknown} value @returns {value is Element} */
  const isElement = value => Boolean(value && typeof value === 'object' && 'type' in value && 'children' in value);
  /** @param {Element} node @returns {Element[]} */
  const flatten = node => [node, ...node.children.filter(isElement).flatMap(flatten)];
  /** @param {string} type */
  function control(type) {
    const node = flatten(tree).find(element => element.type === type);
    assert.ok(node, `Missing ${type} control`);
    return node;
  }
  /** @param {string} type @param {string} name @param {unknown} event */
  async function dispatch(type, name, event) {
    const handler = control(type).props[name];
    assert.ok(typeof handler === 'function');
    await handler(event);
    render();
  }
  /** @param {Element} node @returns {string} */
  const textOf = node => node.children.map(value => isElement(value) ? textOf(value) : typeof value === 'string' ? value : '').join(' ');
  render();
  return {
    writes, control, snapshot: () => snapshot, text: () => textOf(tree), render,
    /** @param {boolean} checked */
    tools: checked => dispatch('input', 'onChange', { target: { checked } }),
    /** @param {'session' | 'global'} value */
    scope: value => dispatch('select', 'onChange', { target: { value } }),
    save: () => dispatch('form', 'onSubmit', { preventDefault() {} }),
    /** @param {Snapshot} value */
    replace(value) { snapshot = value; render(); },
    /** @param {boolean} value */
    allow(value) { allowed = value; render(); },
    /** @param {boolean} value */
    accept(value) { accepted = value; },
    /** @param {string} message */
    fail(message) { failure = message; },
  };
}

test('profile settings label and explain the independent history-tool switch in both languages', () => {
  const zh = editor();
  assert.match(zh.text(), /向 Agent 提供历史工具/);
  assert.match(zh.text(), /afk_history 和 afk_mark_read/);
  assert.match(zh.text(), /不随 AFK 作用范围切换/);
  assert.match(zh.text(), /关闭不影响 AFK 自动应答、界面记录或命令/);
  assert.match(zh.text(), /应用设置/);
  const en = editor(snapshotOf(), 'en');
  assert.match(en.text(), /Provide history tools to the Agent/);
  assert.match(en.text(), /independently of AFK scope/);
  assert.match(en.text(), /does not affect automatic AFK replies, history in the UI, or commands/);
});

test('a tools-only edit writes only toolsEnabled with the captured CAS revision', async () => {
  const initial = snapshotOf();
  const page = editor(initial);
  assert.equal(page.control('input').props.checked, true);
  assert.equal(page.control('button').props.disabled, true);
  await page.save();
  assert.equal(page.writes.length, 0, 'An unchanged form must not write');
  await page.tools(false);
  assert.equal(page.control('input').props.checked, false);
  assert.equal(page.writes.length, 0, 'Changing a draft must not write immediately');
  assert.equal(page.control('button').props.disabled, false);
  await page.save();
  assert.deepEqual(page.writes, [{ ops: [{ op: 'set', path: ['toolsEnabled'], value: false }], revision: 3 }]);
  assert.deepEqual(page.snapshot().value, { ...initial.value, toolsEnabled: false });
  assert.equal(page.control('button').props.disabled, true);
  assert.match(page.text(), /设置已保存/);
});

test('scope-only and combined edits submit only related fields in a single mutation', async () => {
  const page = editor();
  await page.scope('global');
  await page.save();
  assert.deepEqual(page.writes, [{ ops: [{ op: 'set', path: ['scope'], value: 'global' }], revision: 3 }]);
  await page.scope('session');
  await page.tools(false);
  await page.save();
  assert.deepEqual(page.writes[1], { ops: [
    { op: 'set', path: ['scope'], value: 'session' },
    { op: 'set', path: ['toolsEnabled'], value: false },
  ], revision: 4 });
  assert.deepEqual(page.snapshot().value.global, snapshotOf().value.global);
});

test('lack of settings write permission disables both controls and refuses a staged save', async () => {
  const page = editor();
  await page.tools(false);
  page.allow(false);
  for (const type of ['input', 'select', 'button']) assert.equal(page.control(type).props.disabled, true, type);
  await page.save();
  assert.equal(page.writes.length, 0);
  assert.match(page.text(), /当前连接没有此操作的执行权限/);
});

test('a Host without a boolean toolsEnabled cannot edit or submit that field, while scope still works', async () => {
  for (const legacyValue of [undefined, null, 'true']) {
    const initial = snapshotOf({ toolsEnabled: legacyValue });
    if (legacyValue === undefined) delete initial.value.toolsEnabled;
    const page = editor(initial);
    assert.equal(page.control('input').props.disabled, true);
    assert.equal(page.control('select').props.disabled, false);
    assert.match(page.text(), /当前后台尚未提供历史工具开关/);
    await page.tools(false); // Even a direct stale handler call must not stage this unsupported field.
    await page.save();
    assert.equal(page.writes.length, 0);
    await page.scope('global');
    await page.save();
    assert.deepEqual(page.writes, [{ ops: [{ op: 'set', path: ['scope'], value: 'global' }], revision: 3 }]);
    assert.equal(page.snapshot().value.toolsEnabled, legacyValue);
  }
});

test('losing and restoring Host support clears the tools draft and uses the latest boolean and revision', async () => {
  const page = editor();
  await page.tools(false);
  const legacy = snapshotOf({}, 4);
  delete legacy.value.toolsEnabled;
  page.replace(legacy);
  assert.equal(page.control('input').props.disabled, true);
  assert.equal(page.control('button').props.disabled, true);
  await page.save();
  assert.equal(page.writes.length, 0);

  page.replace(snapshotOf({ scope: 'global', toolsEnabled: true }, 5));
  assert.equal(page.control('input').props.disabled, false);
  assert.equal(page.control('input').props.checked, true);
  assert.equal(page.control('select').props.value, 'global');
  assert.equal(page.control('button').props.disabled, true, 'The unsupported tools draft must not become dirty again');
  await page.save();
  assert.equal(page.writes.length, 0, 'Restoring support must not submit the discarded draft');

  await page.tools(false);
  await page.save();
  assert.deepEqual(page.writes, [{ ops: [{ op: 'set', path: ['toolsEnabled'], value: false }], revision: 5 }]);
});

test('CAS conflicts load the latest scope and tools, clear the stale draft, and fence a retry at the new revision', async () => {
  const page = editor();
  await page.scope('global');
  await page.tools(false);
  page.replace(snapshotOf({ scope: 'session', toolsEnabled: true }, 7));
  page.accept(false);
  await page.save();
  assert.equal(page.writes[0].revision, 3, 'External changes must not silently rebase a dirty draft');
  assert.equal(page.control('select').props.value, 'session');
  assert.equal(page.control('input').props.checked, true);
  assert.equal(page.control('button').props.disabled, true);
  assert.match(page.text(), /配置已被其他位置更新/);
  assert.doesNotMatch(page.text(), /设置已保存/);
  page.accept(true);
  await page.tools(false);
  await page.save();
  assert.deepEqual(page.writes[1], { ops: [{ op: 'set', path: ['toolsEnabled'], value: false }], revision: 7 });
});

test('transport errors preserve the editable draft and surface the error without claiming a save', async () => {
  const page = editor();
  await page.tools(false);
  page.fail('Fixture settings transport failure');
  await page.save();
  assert.equal(page.control('input').props.checked, false);
  assert.equal(page.control('button').props.disabled, false);
  assert.match(page.text(), /Fixture settings transport failure/);
  assert.doesNotMatch(page.text(), /设置已保存/);
  page.fail('');
  await page.save();
  assert.deepEqual(page.writes[1], page.writes[0]);
  assert.match(page.text(), /设置已保存/);
});
