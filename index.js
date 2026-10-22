import { ASK, KEY, MARK_READ, REPLY_PREFIX, BLOCK_PREFIX, LEGACY_BLOCK_MESSAGE, REQUEST_STATE_PREFIX, projection, parseQuestions, settingsSchema, settingsOf, historyOf, markReadOf } from './state.js';
import { effectiveSettings, readConfig } from './config.js';
export { Config } from './config.js';

export const inject = ['agents', 'commands', 'tools', 'sessionProjections', 'systemPrompt'];

/** AFK only owns ordinary ask_user_question calls; approval and plan review stay human-only. */
export async function apply(ctx, config) {
  // This bundle owns its configuration page; retain standard Settings reads/writes.
  const owner = ctx.fiber;
  ctx.inject(['settings'], scoped => {
    scoped.effect(() => scoped.settings.configure({ auto: false }, owner));
  });
  ctx.sessionProjections.register(projection);
  const stateOf = agent => {
    const state = agent && ctx.sessionProjections.stateOf(agent.session, KEY);
    if (!state) throw new Error('AFK state is unavailable for this session');
    return state;
  };
  const effective = agent => effectiveSettings(config, stateOf(agent));
  const history = (agent, offset = 0, limit = 20, filter = 'unread') => historyOf(stateOf(agent), offset, limit, filter);
  const markRead = (agent, recordIds) => markReadOf(stateOf(agent), recordIds);

  ctx.commands.register({
    name: 'afk',
    description: 'AFK：设置离开模式和自动应答语，查看当前会话全部提问或标记已读。',
    input: { hint: 'on | off | set {"enabled":false,"mode":"auto-reply","reply":"…"} | history [offset] [limit] [unread|all] | read <JSON recordIds[]>' },
    handler({ agent, rawInput, signal }) {
      if (signal.aborted) throw new Error('AFK command was cancelled');
      const input = rawInput.trim();
      if (!input) return { kind: 'success', text: JSON.stringify({ ...stateOf(agent).view, ...effective(agent) }) };
      if (/^history(?:\s|$)/.test(input)) {
        const [, offset = '0', limit = '20', filter = 'unread', ...extra] = input.split(/\s+/);
        if (extra.length) throw new Error('Usage: /afk history [offset] [limit] [unread|all]');
        return { kind: 'success', text: JSON.stringify(history(agent, Number(offset), Number(limit), filter)) };
      }
      if (/^read\s/.test(input)) {
        const recordIds = JSON.parse(input.slice(4).trim());
        return { kind: 'success', text: JSON.stringify(markRead(agent, recordIds)) };
      }
      // Session command authority cannot mutate a profile-wide Settings value.
      if (readConfig(config).scope === 'global') {
        return { kind: 'error', text: 'AFK 当前使用全局作用范围。请在插件全局设置 UI 修改开关、模式或回复；会话 /afk on、off、set 无权修改全局设置。' };
      }
      const current = settingsOf(stateOf(agent));
      const candidate = input === 'on' ? { ...current, enabled: true }
        : input === 'off' ? { ...current, enabled: false }
        : input.startsWith('set ') ? JSON.parse(input.slice(4)) : undefined;
      const parsed = settingsSchema.safeParse(candidate);
      if (!parsed.success) return { kind: 'error', text: 'AFK 设置无效：enabled 必须是布尔值；mode 为 auto-reply / disable-ask；reply 为 1–2000 字的非空文本。' };
      // The Commands service commits this complete value as command/done before resolving to the UI.
      return { kind: 'success', text: JSON.stringify({ type: 'dsh-afk/settings-v1', settings: parsed.data }) };
    },
  });

  // Read-only counterpart of the UI history action. The agent cannot enable AFK or change its reply.
  ctx.tools.register({
    name: 'afk_history',
    description: 'Read this session’s question history, whether AFK was enabled or not, with recorded answers and outcomes. Returns newest-first pages; does not change settings or read status.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        offset: { type: 'integer', minimum: 0, description: 'Number of newest question batches to skip; defaults to 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Question batches per page; defaults to 20.' },
        filter: { type: 'string', enum: ['unread', 'all'], description: 'Read-status filter; defaults to unread. Use all to include acknowledged questions.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) { return history(exec.agent, args?.offset ?? 0, args?.limit ?? 20, args?.filter ?? 'unread'); },
    isConcurrencySafe: () => true,
  });

  ctx.tools.register({
    name: MARK_READ,
    description: 'Mark selected question-history records as read when the user asks to acknowledge them. Read items disappear from the default unread view but remain available with filter all.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['recordIds'],
      properties: { recordIds: { type: 'array', items: { type: 'string' }, description: '1–50 distinct record IDs returned by afk_history, belonging to this session.' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['type', 'readIds'],
        properties: { type: { type: 'string', const: 'dsh-afk/read-v1' }, readIds: { type: 'array', items: { type: 'string' } } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ dshAfkRead: value }),
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'recordIds')) {
        throw new Error('Provide an object containing only recordIds');
      }
      return markRead(exec.agent, args.recordIds);
    },
    isConcurrencySafe: () => true,
  });

  // tools/execute runs only AFTER the existing pre-policy and monotonic guards.
  // Claiming this exact tool keeps legacy, timed and PTC calls consistent, without touching approval requests.
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== ASK || !exec.agent || exec.signal.aborted) return next();
    const settings = effective(exec.agent);
    if (!settings.enabled || settings.mode !== 'auto-reply') return next();
    const timeout = exec.arguments?.timeout;
    const timed = Object.hasOwn(ctx.tools.get(ASK, exec.agent)?.parameters?.properties ?? {}, 'timeout');
    if (timed && timeout !== undefined && timeout !== -1
      && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483)) {
      const message = 'AFK: timeout must be -1 or an integer between 1 and 2147483 seconds.';
      return { isError: true, error: { message }, content: [{ type: 'text', text: message }] };
    }
    const questions = parseQuestions(exec.arguments);
    if (!questions) {
      const message = 'AFK: invalid question batch. Supply non-empty questions with distinct string IDs; do not wait for the absent user.';
      return { isError: true, error: { message }, content: [{ type: 'text', text: message }] };
    }
    const value = { answers: questions.map(question => ({ id: question.id, selected: [], custom: REPLY_PREFIX + settings.reply })) };
    return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] };
  }, { prepend: true });

  ctx.tools.guard(exec => {
    if (exec.name !== ASK || !exec.agent) return undefined;
    const { enabled, mode } = effective(exec.agent);
    return enabled && mode === 'disable-ask'
      ? BLOCK_PREFIX + LEGACY_BLOCK_MESSAGE
      : undefined;
  });

  // Scope effects have two owners: the exact agent and this plugin. Either teardown lifts the mask.
  const agents = new Map();
  const attach = agent => {
    if (agents.has(agent)) return agents.get(agent).ready;
    const entry = { sync() {}, dispose() {}, ready: undefined };
    agents.set(agent, entry);
    // Agent contexts do not implicitly expose every Host dependency. Inject a scoped consumer.
    const fiber = agent.ctx.inject(['tools'], scoped => {
      let release;
      let masked = false;
      entry.sync = () => {
        const { enabled, mode } = effective(agent);
        const wanted = enabled && mode === 'disable-ask';
        if (wanted === masked) return;
        release?.();
        release = undefined;
        masked = wanted;
        if (!wanted || !scoped.tools.get(ASK, agent)) return;
        try {
          // rc.2 masks inherited preset tools at the agent layer (not the preset's own layer).
          release = scoped.tools.restrict({ deny: [ASK] });
        } catch (error) {
          // A scope-local custom tool may not be maskable. The guard still blocks execution.
          ctx.logger.warn(`AFK: ask visibility mask unavailable; execution remains blocked: ${error.message}`);
        }
      };
      scoped.effect(() => () => {
        release?.();
        agents.delete(agent);
      });
      entry.sync();
    });
    entry.dispose = fiber.dispose;
    entry.ready = fiber;
    return fiber;
  };
  ctx.on('agent/created', async ({ agent }) => { await attach(agent); });
  // Loader dispatches this only to the owning fiber, after all volatile refs commit.
  ctx.on('loader/volatile-update', () => {
    for (const entry of agents.values()) entry.sync();
  });
  ctx.sessionProjections.onChanged((session, key) => {
    if (key !== KEY) return;
    const agent = ctx.agents.get(session.id);
    if (agent) agents.get(agent)?.sync();
  });
  ctx.effect(() => async () => {
    await Promise.all([...agents.values()].map(({ dispose }) => dispose()));
    agents.clear();
  });
  for (const agent of ctx.agents.list()) await attach(agent);

  ctx.systemPrompt.context({
    name: 'dsh-afk', order: 95, required: true, interpolate: false,
    text({ scope }) {
      const agent = scope && ctx.agents.list().find(candidate => candidate === scope);
      if (!agent) return '';
      const { scope: afkScope, enabled, mode } = effective(agent);
      const snapshot = REQUEST_STATE_PREFIX + JSON.stringify({ scope: afkScope, enabled, mode });
      if (!enabled) return snapshot;
      return `${snapshot}\nAFK is enabled (${afkScope} scope): the user is away. ${mode === 'disable-ask' ? 'ask_user_question is disabled. Make safe independent choices without asking the user.' : 'Ordinary ask_user_question calls receive the user-configured automatic reply, not a human answer.'} AFK never grants permission, approves a plan, or relaxes existing policies. Do not claim the human selected an option. If explicit authorization is necessary, preserve the pending decision and stop that dependent action; continue only independent authorized work. Previous AFK questions and actual replies can be read with afk_history.`;
    },
  });
}
