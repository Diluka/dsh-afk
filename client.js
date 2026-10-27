/// <reference path="./types/client.d.ts" />
/** @import { AfkSettings, AfkQuestion, AfkHistory, AfkView, AfkPreferences } from './types/afk.js' */
/** @import { AfkToolbarSlotProps, AfkBundleConfigProps, AfkCommandViewProps, AfkPreferencesSnapshot, ReadyAfkPreferences, HistoryLoadState, HistoryRecordView, HistoryPage, CommandSummary } from './types/client.js' */
/** @import { Translate, GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots' */
/** @import { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client' */
/** @import { SessionId } from '@deepseek-ai/dsh-session/types' */
/** @import { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client' */
/** @import { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client' */
/** @import { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client' */
window.__ModuleLoader__.load({
  id: 'dsh-afk',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const KEY = 'dsh-afk';
    const PAGE_SIZE = 20;
    const dictionaries = {
      en: {
        afk: 'AFK', 'afk.global': 'AFK · all', 'switch.label': 'AFK mode', 'switch.global': 'AFK mode for all sessions', 'settings.title': 'AFK settings',
        'scope.title': 'Settings scope', 'scope.session': 'Per session', 'scope.global': 'Unified across sessions',
        'scope.hint': 'Shared within this Host profile. Changing scope preserves each session’s own settings; history and read status always stay per session.',
        'scope.global.hint': 'Unified mode uses its own saved settings (off initially), not a copy of the selected session. Its switch affects all sessions.',
        'scope.apply': 'Apply settings', 'settings.profile': 'Profile settings',
        'tools.label': 'Provide history tools to the Agent',
        'tools.hint': 'Controls afk_history and afk_mark_read for this profile, independently of AFK scope. Turning this off does not affect automatic AFK replies, history in the UI, or commands.',
        'scope.loading': 'Loading AFK scope…', 'scope.error': 'The Host has not exposed AFK scope settings. Check the loaded version and read access; an upgraded Host may need an approved restart.',
        'settings.enabled.global': 'Enable AFK for every session in this profile', 'settings.global': 'Shared AFK settings',
        'error.conflict': 'Settings changed elsewhere. Latest values were loaded; review and try again.',
        'settings.session': 'Session', 'settings.choose': 'Choose a session',
        'settings.scope': 'Configure the selected session here. View its question history beside the AFK switch in the conversation.',
        'settings.enabled': 'Enable AFK for this session', 'settings.draft': 'Changes take effect after saving.',
        'mode.title': 'When the agent asks a new question', 'mode.auto': 'Reply automatically',
        'mode.auto.detail': 'Record questions and send the custom reply. No option is selected automatically.',
        'mode.disable': 'Disable ask_user_question', 'mode.disable.detail': 'Hide and block the question tool. Questions that are never asked cannot be recorded.',
        'reply.label': 'Custom automatic reply', 'reply.hint': 'Up to 2,000 characters. Sending adds an AFK marker, not human approval.',
        'reply.required': 'Enter a non-blank reply of at most 2,000 characters.',
        'notice.new': 'Only newly dispatched questions are affected; existing waits remain unchanged.',
        'notice.authority': 'AFK never grants permissions or approves plans.',
        save: 'Save settings', saving: 'Saving…', saved: 'Settings saved.', loading: 'Loading session…',
        unavailable: 'AFK state is not available yet.', forbidden: 'This connection cannot perform this operation.',
        'error.generic': 'The AFK operation failed. Please try again.', 'error.command': 'The AFK command is unavailable.',
        'command.running': 'Working…', 'command.done': 'Done', 'command.failed': 'Operation failed',
        'command.read': 'Marked read', 'command.history': 'History: {unread} unread / {total} total',
        'command.on': 'Enabled', 'command.off': 'Disabled',
        'history.title': 'Question history', 'history.count': '{total} batches', 'history.open': 'History', 'history.close': 'Close',
        'history.hint': 'Newest first. Each batch is one question-tool call and may contain multiple questions.',
        'history.loading': 'Loading history…', 'history.empty': 'No questions recorded in this session.',
        'history.unread': 'Unread', 'history.all': 'All', 'history.markRead': 'Mark read', 'history.read': 'Read',
        'history.marking': 'Marking…', 'history.emptyUnread': 'No unread questions.',
        'history.hintAll': 'All questions in this session are recorded, whether AFK is on or off. Read items stay available under All.',
        'history.refresh': 'Refresh', 'history.previous': 'Newer', 'history.next': 'Older',
        'history.page': '{start}–{end} of {total} batches', 'history.multi': 'Multiple selections allowed',
        'history.reply': 'Actual automatic reply', 'history.answer': 'Recorded result', 'history.call': 'Call ID',
        'status.pending': 'Pending', 'status.auto-replied': 'Auto-replied', 'status.blocked': 'Blocked',
        'status.answered': 'Answered', 'status.failed': 'Failed',
      },
      zh: {
        afk: 'AFK', 'afk.global': 'AFK · 全局', 'switch.label': 'AFK 离开模式', 'switch.global': 'AFK 离开模式（全局统一）', 'settings.title': 'AFK 设置',
        'scope.title': '设置作用范围', 'scope.session': '按会话单独', 'scope.global': '全局统一',
        'scope.hint': '全局指当前 Host 的 profile。切换范围保留各会话原设置；提问记录和已读状态始终按会话独立。',
        'scope.global.hint': '全局模式使用独立保存的配置，初始为关闭，不复制所选会话的设置。全局开关会影响所有会话。',
        'scope.apply': '应用设置', 'settings.profile': '当前 profile 配置',
        'tools.label': '向 Agent 提供历史工具',
        'tools.hint': '统一控制当前 profile 是否向模型提供 afk_history 和 afk_mark_read，不随 AFK 作用范围切换。关闭不影响 AFK 自动应答、界面记录或命令。',
        'scope.loading': '正在读取 AFK 作用范围…', 'scope.error': '后台暂未提供 AFK 作用范围配置，请核对加载版本与读取权限；刚升级的后台可能需要经确认后重启。',
        'settings.enabled.global': '为当前 profile 的所有会话开启 AFK', 'settings.global': '全局 AFK 设置',
        'error.conflict': '配置已被其他位置更新，已载入最新值，请检查后重新修改并保存。',
        'settings.session': '目标会话', 'settings.choose': '请选择要配置的会话',
        'settings.scope': '在此配置所选会话；提问记录请在对话中点击 AFK 开关旁的记录按钮查看。',
        'settings.enabled': '为当前会话开启 AFK', 'settings.draft': '修改在点击保存后生效。',
        'mode.title': '当 Agent 提出新问题时', 'mode.auto': '自动应答',
        'mode.auto.detail': '记录问题并发送自定义回复，不会自动选择任何选项。',
        'mode.disable': '禁用 ask_user_question', 'mode.disable.detail': '隐藏并阻止提问工具。没有发出的问题无法记录。',
        'reply.label': '自定义自动应答语', 'reply.hint': '最多 2,000 个字符。发送时附加 AFK 自动应答标识，不代表用户批准。',
        'reply.required': '请输入不超过 2,000 个字符的非空回复。',
        'notice.new': '只影响新派发的提问，已有等待不会被接管。',
        'notice.authority': 'AFK 不会批准权限请求或计划，也不会授予额外权限。',
        save: '保存设置', saving: '正在保存…', saved: '设置已保存。', loading: '正在读取会话…',
        unavailable: 'AFK 状态尚不可用。', forbidden: '当前连接没有此操作的执行权限。',
        'error.generic': 'AFK 操作失败，请重试。', 'error.command': '当前会话的 AFK 命令不可用。',
        'command.running': '正在处理…', 'command.done': '操作已完成', 'command.failed': '操作失败',
        'command.read': '已标记为已读', 'command.history': '记录：未读 {unread} 批 / 共 {total} 批',
        'command.on': '已开启', 'command.off': '已关闭',
        'history.title': '提问记录', 'history.count': '{total} 批', 'history.open': '记录', 'history.close': '关闭',
        'history.hint': '最新优先；每批对应一次提问工具调用，可能包含多个问题。',
        'history.loading': '正在读取记录…', 'history.empty': '当前会话还没有提问记录。',
        'history.unread': '未读', 'history.all': '全部', 'history.markRead': '已读', 'history.read': '已读',
        'history.marking': '标记中…', 'history.emptyUnread': '当前没有未读提问。',
        'history.hintAll': '记录当前会话的所有提问，不受 AFK 开关影响。已读记录可在「全部」中回看。',
        'history.refresh': '刷新', 'history.previous': '较新', 'history.next': '较早',
        'history.page': '第 {start}–{end} 批，共 {total} 批', 'history.multi': '可多选',
        'history.reply': '实际自动回复', 'history.answer': '已记录的结果', 'history.call': '调用 ID',
        'status.pending': '待处理', 'status.auto-replied': '已自动应答', 'status.blocked': '已阻止',
        'status.answered': '已回答', 'status.failed': '失败',
      },
    };
    const css = `
.dsh-afk { color: var(--dsw-alias-label-primary); font: inherit; }
.dsh-afk button, .dsh-afk textarea, .dsh-afk input, .dsh-afk select { font: inherit; }
.dsh-afk button { cursor: pointer; }
.dsh-afk button:disabled { cursor: default; opacity: .5; }
.dsh-afk :is(button, textarea, input, select, summary):focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-afk-toolbar { display: inline-flex; align-items: center; gap: 4px; }
.dsh-afk-history-trigger { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px !important; }
.dsh-afk-history-trigger:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-afk-dialog { position: fixed; inset: auto; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(680px, calc(100vw - 32px)); max-width: none; max-height: min(70dvh, 640px); margin: 0; padding: 16px; box-sizing: border-box; overflow: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 8px 32px var(--dsw-alias-border-l2); font: inherit; }
.dsh-afk-filters { display: flex; gap: 6px; margin: 12px 0; }
.dsh-afk-filters [aria-selected="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-afk-read-state { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-afk-dialog-header { margin-bottom: 16px; }
@media(max-width: 480px) { .dsh-afk-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); padding: 12px; } }
.dsh-afk-switch { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px !important; }
.dsh-afk-switch:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-afk-track { display: inline-flex; align-items: center; width: 26px; height: 16px; padding: 2px; box-sizing: border-box; border-radius: 999px; background: var(--dsw-alias-state-idle-primary); }
.dsh-afk-switch[aria-checked="true"] .dsh-afk-track { background: var(--dsw-alias-brand-primary); }
.dsh-afk-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-alias-label-primary); }
.dsh-afk-switch[aria-checked="true"] .dsh-afk-thumb { transform: translateX(10px); background: var(--dsw-alias-bg-base); }
.dsh-afk-page { display: block; margin: 24px 0; font-size: 14px; line-height: 22px; }
.dsh-afk-section + .dsh-afk-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-afk h3 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
.dsh-afk p { margin: 8px 0; }
.dsh-afk-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.dsh-afk-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-afk-fieldset { min-width: 0; margin: 16px 0; padding: 0; border: 0; }
.dsh-afk-fieldset legend { margin-bottom: 8px; font-weight: 500; }
.dsh-afk-mode { display: flex; align-items: flex-start; gap: 8px; padding: 12px; margin-bottom: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.dsh-afk-mode:has(input:checked) { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-afk input { accent-color: var(--dsw-alias-brand-primary); }
.dsh-afk-label { display: block; font-weight: 500; }
.dsh-afk-reply, .dsh-afk-select { box-sizing: border-box; width: 100%; padding: 9px 10px; margin: 6px 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-afk-reply { min-height: 88px; resize: vertical; }
.dsh-afk-button { min-height: 30px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px !important; }
.dsh-afk-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-afk-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-afk-error { color: var(--dsw-alias-state-error-primary); }
.dsh-afk-success { color: var(--dsw-alias-state-success-primary); }
.dsh-afk-history-list { display: grid; gap: 12px; padding: 0; margin: 12px 0; list-style: none; }
.dsh-afk-record { min-width: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); overflow-wrap: anywhere; }
.dsh-afk-record-header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 8px; }
.dsh-afk-record-header time { margin-right: auto; }
.dsh-afk-status { font-size: 12px; }
.dsh-afk-status[data-status="pending"] { color: var(--dsw-alias-state-warn-primary); }
.dsh-afk-status[data-status="auto-replied"], .dsh-afk-status[data-status="answered"] { color: var(--dsw-alias-state-success-primary); }
.dsh-afk-status[data-status="blocked"], .dsh-afk-status[data-status="failed"] { color: var(--dsw-alias-state-error-primary); }
.dsh-afk-questions { padding-left: 20px; }
.dsh-afk-questions > li + li { margin-top: 10px; }
.dsh-afk-question, .dsh-afk-record-reply { white-space: pre-wrap; }
.dsh-afk-options { padding-left: 18px; margin: 4px 0; }
.dsh-afk-answer { max-height: 240px; padding: 8px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.dsh-afk-record summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; }
`;
    /** @param {AfkSettings} view @returns {AfkSettings} */
    const settingsOf = view => ({ enabled: view.enabled, mode: view.mode, reply: view.reply });
    /** @param {AfkPreferences} value @returns {Pick<AfkPreferences, 'scope' | 'toolsEnabled'>} */
    const profileSettingsOf = value => ({ scope: value.scope, toolsEnabled: value.toolsEnabled });
    /** @param {unknown} reply @returns {reply is string} */
    const validReply = reply => typeof reply === 'string' && reply.trim().length > 0 && reply.length <= 2000;
    /** @param {unknown} error @param {Translate} t @returns {string} */
    const failureText = (error, t) => error && typeof error === 'object' && 'message' in error
      && typeof error.message === 'string' && error.message ? error.message : t('error.generic');

    /** @param {unknown} value @returns {value is Record<string, unknown>} */
    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /** @param {unknown} value @returns {value is AfkQuestion} */
    function isQuestion(value) {
      return isObject(value) && typeof value.id === 'string' && typeof value.question === 'string'
        && (value.header === undefined || typeof value.header === 'string')
        && (value.detail === undefined || typeof value.detail === 'string')
        && (value.multiSelect === undefined || typeof value.multiSelect === 'boolean')
        && (value.options === undefined || (Array.isArray(value.options) && value.options.every(
          /** @param {unknown} option */ option => isObject(option) && typeof option.label === 'string'
            && (option.description === undefined || typeof option.description === 'string'))));
    }

    /** @param {unknown} value @returns {value is HistoryRecordView} */
    function isHistoryRecord(value) {
      return isObject(value) && typeof value.id === 'string' && typeof value.callId === 'string'
        && typeof value.time === 'number' && Number.isFinite(value.time)
        && typeof value.reply === 'string' && typeof value.read === 'boolean'
        && (value.status === 'pending' || value.status === 'auto-replied' || value.status === 'blocked'
          || value.status === 'answered' || value.status === 'failed')
        && Array.isArray(value.questions) && value.questions.every(isQuestion);
    }

    /**
     * Narrow the command's untrusted JSON before it reaches React props.
     * @param {unknown} value @param {number} offset @param {AfkHistory['filter']} filter @param {number} [limit]
     * @returns {value is HistoryPage}
     */
    function isHistory(value, offset, filter, limit = PAGE_SIZE) {
      return isObject(value) && typeof value.total === 'number' && Number.isSafeInteger(value.total) && value.total >= 0
        && value.offset === offset && value.limit === limit && value.filter === filter
        && typeof value.totalAll === 'number' && Number.isSafeInteger(value.totalAll) && value.totalAll >= 0
        && typeof value.unread === 'number' && Number.isSafeInteger(value.unread) && value.unread >= 0
        && Array.isArray(value.records) && value.records.every(isHistoryRecord);
    }

    /** @param {unknown} value @returns {string} */
    function parseHistorySessionId(value) {
      if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid AFK history session ID');
      return value;
    }
    /** @param {unknown} value @returns {import('./types/history.js').HistoryQuery} */
    function parseHistoryQuery(value) {
      if (!isObject(value) || Object.keys(value).length !== 3 || Object.keys(value).some(key => !['offset', 'limit', 'filter'].includes(key))
        || !Number.isSafeInteger(value.offset) || typeof value.offset !== 'number' || value.offset < 0
        || !Number.isSafeInteger(value.limit) || typeof value.limit !== 'number' || value.limit < 1 || value.limit > 50
        || (value.filter !== 'unread' && value.filter !== 'all')) throw new Error('Invalid AFK history query');
      return { offset: value.offset, limit: value.limit, filter: value.filter };
    }
    /** @param {unknown} value @returns {value is import('./types/afk.js').AfkRecord} */
    function isCompleteHistoryRecord(value) {
      if (!isObject(value)) return false;
      const { mode, afk, requestState: request } = value;
      if (!isHistoryRecord(value) || value.questions.length === 0
        || new Set(value.questions.map(question => question.id)).size !== value.questions.length) return false;
      return (mode === null || mode === 'auto-reply' || mode === 'disable-ask')
        && (afk === null || typeof afk === 'boolean')
        && (request === null || (isObject(request) && Object.keys(request).length === 3
          && Object.keys(request).every(key => ['scope', 'enabled', 'mode'].includes(key))
          && (request.scope === 'session' || request.scope === 'global') && typeof request.enabled === 'boolean'
          && (request.mode === 'auto-reply' || request.mode === 'disable-ask')));
    }
    /** @param {unknown} value @returns {AfkHistory} */
    function parseHistoryPage(value) {
      const query = parseHistoryQuery(isObject(value) ? { offset: value.offset, limit: value.limit, filter: value.filter } : undefined);
      if (!isHistory(value, query.offset, query.filter, query.limit) || Object.keys(value).length !== 7
        || Object.keys(value).some(key => !['total', 'totalAll', 'unread', 'offset', 'limit', 'filter', 'records'].includes(key))
        || !value.records.every(isCompleteHistoryRecord)) throw new Error('Invalid AFK history page');
      return { ...value, records: value.records };
    }
    // This Client face mirrors the Host wire contract, without importing Host modules or a browser Zod copy.
    /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
    const historyDescriptor = {
      id: 'dsh-afk#history', service: 'afkHistory', namespace: 'afkHistory', method: 'history',
      invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
      parameters: [
        { name: 'afkAddress', wire: 'sessionId', source: 'lookup', lookup: 'afkHistoryAddress',
          codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => ({ parse: parseHistorySessionId }) } },
        { name: 'query', wire: 'query', source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-afk#HistoryQuery', create: () => ({ parse: parseHistoryQuery }) } },
      ],
      result: { mode: 'strict', typeSymbol: 'dsh-afk#AfkHistory', create: () => ({ parse: parseHistoryPage }), decode: parseHistoryPage },
    };

    // Presentation only: preserve the command JSON for the UI and durable receipts.
    /** @param {CommandNode} node @param {Translate} t @returns {CommandSummary} */
    function commandSummary(node, t) {
      // A history request is a read-only view action, not a chat notification.
      const historyQuery = node.name === 'afk' && typeof node.args === 'string' && /^history(?:\s|$)/.test(node.args.trim());
      if (!node.outcome) return { state: 'running', text: t('command.running'), hidden: historyQuery };
      const raw = typeof node.outcome.text === 'string' ? node.outcome.text.trim() : '';
      if (node.outcome.kind === 'error') {
        const reason = /^[{[]/.test(raw) ? '' : raw.replace(/\s+/g, ' ').slice(0, 240);
        return { state: 'error', text: t('command.failed') + (reason ? `：${reason}` : '') };
      }
      if (historyQuery) return { state: 'success', text: '', hidden: true };
      /** @type {unknown} */
      let decoded;
      try { decoded = JSON.parse(raw); } catch {}
      /** @type {Record<string, unknown>} */
      const data = /** @type {Record<string, unknown>} */ (
        decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {});
      /** @param {unknown} value @returns {value is number} */
      const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      /** @param {unknown} value @returns {value is { enabled: boolean, mode: string }} */
      const settingsLike = value => value !== null && typeof value === 'object'
        && typeof (/** @type {Record<string, unknown>} */ (value)).enabled === 'boolean'
        && ((/** @type {Record<string, unknown>} */ (value)).mode === 'auto-reply'
          || (/** @type {Record<string, unknown>} */ (value)).mode === 'disable-ask');
      /** @param {{ enabled: boolean, mode: string }} settings @param {string} scope */
      const settingText = (settings, scope) => [
        t(settings.enabled ? 'command.on' : 'command.off'),
        t(scope === 'global' ? 'scope.global' : 'scope.session'),
        t(settings.mode === 'auto-reply' ? 'mode.auto' : 'mode.disable'),
      ].join(' · ');
      if (data.type === 'dsh-afk/read-v1' && Array.isArray(data.readIds)) {
        return { state: 'success', text: t('command.read') };
      }
      if (count(data.totalAll) && count(data.unread)) {
        return { state: 'success', text: t('command.history', { total: data.totalAll, unread: data.unread }), hidden: true };
      }
      // Session commands commit a typed settings receipt; their scope is always the session.
      if (data.type === 'dsh-afk/settings-v1' && settingsLike(data.settings)) {
        return { state: 'success', text: settingText(data.settings, 'session') };
      }
      // `/afk` answers the effective status view, whose same-version shape carries the scope.
      const scope = data.scope;
      if ((scope === 'session' || scope === 'global') && settingsLike(data)) {
        return { state: 'success', text: settingText(data, scope) };
      }
      // Unknown or malformed machine payloads become a generic completion; JSON is never dumped into Chat.
      return { state: 'success', text: t('command.done') };
    }

    /**
     * @param {{ checked: boolean, disabled: boolean, label: string, text: string,
     *   onChange: (checked: boolean) => void, title?: string }} props
     */
    function Switch({ checked, disabled, label, text, onChange, title }) {
      return h('button', { type: 'button', className: 'dsh-afk-switch', role: 'switch',
        'aria-checked': checked, 'aria-label': label, title, disabled, onClick: () => onChange(!checked) },
      text, h('span', { className: 'dsh-afk-track', 'aria-hidden': true }, h('span', { className: 'dsh-afk-thumb' })));
    }

    /**
     * @param {{ record: HistoryRecordView, t: Translate, language: string,
     *   onMarkRead: (id: string) => void, marking: string, canMark: boolean }} props
     */
    function HistoryRecord({ record, t, language, onMarkRead, marking, canMark }) {
      const date = new Date(record.time);
      const validDate = Number.isFinite(date.getTime());
      return h('li', { className: 'dsh-afk-record', 'data-read': record.read === true },
        h('div', { className: 'dsh-afk-record-header' },
          h('time', { className: 'dsh-afk-muted', dateTime: validDate ? date.toISOString() : undefined }, validDate ? date.toLocaleString(language) : ''),
          h('span', { className: 'dsh-afk-status', 'data-status': record.status }, t(`status.${record.status}`))),
        h('ol', { className: 'dsh-afk-questions' }, record.questions.map(question => h('li', { key: question.id },
          question.header ? h('strong', null, question.header) : null,
          h('div', { className: 'dsh-afk-question' }, question.question),
          question.detail ? h('p', { className: 'dsh-afk-muted dsh-afk-question' }, question.detail) : null,
          question.multiSelect ? h('span', { className: 'dsh-afk-muted' }, t('history.multi')) : null,
          question.options?.length ? h('ul', { className: 'dsh-afk-options' }, question.options.map((option, index) =>
            h('li', { key: index }, option.label, option.description ? ` — ${option.description}` : ''))) : null))),
        record.reply ? h('div', { className: 'dsh-afk-record-reply' }, h('strong', null, t('history.reply')), h('div', null, record.reply)) : null,
        record.answer !== undefined ? h('details', null, h('summary', null, t('history.answer')),
          h('pre', { className: 'dsh-afk-answer' }, typeof record.answer === 'string' ? record.answer : JSON.stringify(record.answer, null, 2))) : null,
        h('p', { className: 'dsh-afk-muted' }, `${t('history.call')}: ${record.callId}`),
        h('div', { className: 'dsh-afk-row' }, record.read
          ? h('span', { className: 'dsh-afk-read-state' }, t('history.read'))
          : h('button', { type: 'button', className: 'dsh-afk-button dsh-afk-mark-read', disabled: !canMark || Boolean(marking), onClick: () => onMarkRead(record.id) },
            t(marking === record.id ? 'history.marking' : 'history.markRead'))));
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'sessions', 'configForms'],
      async apply(ctx) {
        await ctx.remote.$mount({ package: 'dsh-afk', descriptors: [historyDescriptor] });
        /** @type {import('./types/history.js').HistoryRemote | undefined} */
        let historyRemote;
        await ctx.inject(['remote', 'remote.afkHistory'], scoped => {
          historyRemote = scoped.remote.afkHistory;
          scoped.effect(() => () => { historyRemote = undefined; });
        });
        ctx.effect(() => ctx.locale.register(KEY, 'en', dictionaries.en));
        ctx.effect(() => ctx.locale.register(KEY, 'zh', dictionaries.zh));
        const t = ctx.locale.bind(KEY);
        /** @param {() => void} listener */
        const subscribeLocale = listener => ctx.locale.subscribe(listener);
        const localeSnapshot = () => ctx.locale.getSnapshot();
        const useLanguage = () => React.useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot).active;
        /** @type {ConfigForm<AfkPreferences>} */
        const preferencesForm = ctx.configForms.get(KEY);
        /** @param {() => void} listener */
        const subscribePreferences = listener => preferencesForm.subscribe(listener);
        const preferencesSnapshot = () => preferencesForm.getSnapshot();
        const settingsMirror = ctx.configForms.describe();
        /** @param {() => void} listener */
        const subscribeMirror = listener => settingsMirror.subscribe(listener);
        const mirrorSnapshot = () => settingsMirror.getSnapshot();
        /** @returns {AfkPreferencesSnapshot} */
        function usePreferences() {
          const snapshot = React.useSyncExternalStore(subscribePreferences, preferencesSnapshot, preferencesSnapshot);
          const mirror = React.useSyncExternalStore(subscribeMirror, mirrorSnapshot, mirrorSnapshot);
          // ConfigForms.get() already calls mirror.ensure(), and the settings provider
          // re-reads on connection/reset and document-updated; no per-mount refresh here.
          return React.useMemo(() => !mirror.view && mirror.error
            ? { ...snapshot, status: 'unavailable' } : snapshot, [snapshot, mirror]);
        }
        /** @param {AfkPreferencesSnapshot} snapshot @returns {snapshot is ReadyAfkPreferences} */
        const preferencesReady = snapshot => snapshot.status === 'ready' && Boolean(snapshot.value?.global);
        /** @param {boolean} accepted */
        const requireAccepted = accepted => { if (!accepted) throw new Error(t('error.conflict')); };

        /** @param {SessionId} sessionId @param {string} line @param {AbortSignal} signal */
        async function execute(sessionId, line, signal) {
          const res = await ctx.remote.commands.execute(sessionId, line, [], signal);
          if (!res.ok) throw new Error(res.error.message);
          if (!res.value) throw new Error(t('error.command'));
          if (res.value.result.kind === 'error') throw new Error(res.value.result.text);
          return res.value.result;
        }

        /** @param {SessionId} sessionId @param {import('./types/history.js').HistoryQuery} query @param {AbortSignal} signal */
        async function queryHistory(sessionId, query, signal) {
          if (!historyRemote) throw new Error(t('unavailable'));
          // The Remote descriptor's strict codecs parse both named wire values.
          const result = await historyRemote.history(sessionId, query, signal);
          if (!result.ok) throw new Error(result.error.message);
          return result.value;
        }

        const AfkCommandView = React.memo(/** @param {AfkCommandViewProps} props */ function AfkCommandView({ node }) {
          const language = useLanguage();
          const summary = React.useMemo(() => commandSummary(node, t), [node.name, node.args, node.outcome, language]);
          if (summary.hidden) return null;
          return h('div', { className: 'dsh-afk-command', 'data-state': summary.state,
            style: { padding: '4px 0', fontSize: 12, lineHeight: '20px', overflowWrap: 'anywhere',
              color: summary.state === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' } },
          'AFK · ', summary.text);
        });

        // Session controls: AFK switch and current-session history, never plugin settings.
        /**
         * @param {{ sessionId: SessionId, view: AfkView | undefined, allowed: boolean,
         *   historyAllowed: boolean, globalAllowed: boolean, language: string }} props
         */
        function Toolbar({ sessionId, view, allowed, historyAllowed, globalAllowed, language }) {
          const preferences = usePreferences();
          const ready = preferencesReady(preferences);
          const global = ready && preferences.value.scope === 'global';
          const effective = global ? preferences.value.global : view;
          const writable = ready && (global ? globalAllowed && preferences.writable : allowed);
          const [historyOpen, setHistoryOpen] = React.useState(false);
          const [saving, setSaving] = React.useState(false);
          const [error, setError] = React.useState('');
          const request = React.useRef(/** @type {AbortController | null} */ (null));
          React.useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
          /** @param {boolean} enabled */
          async function toggle(enabled) {
            if ((!global && !view) || !writable || request.current) return;
            const controller = new AbortController();
            request.current = controller;
            setSaving(true); setError('');
            try {
              if (global) {
                requireAccepted(await preferencesForm.mutate([{ op: 'set', path: ['global', 'enabled'], value: enabled }], preferences.revision));
              } else {
                if (!view) return;
                await execute(sessionId, `/afk set ${JSON.stringify({ ...settingsOf(view), enabled })}`, controller.signal);
              }
            } catch (failure) { if (!controller.signal.aborted) setError(failureText(failure, t)); }
            finally { if (!controller.signal.aborted) { request.current = null; setSaving(false); } }
          }
          return h('div', { className: 'dsh-afk dsh-afk-toolbar' }, h('style', null, css),
            h(Switch, { checked: ready && effective?.enabled === true, disabled: (!global && !view) || !writable || saving,
              label: t(global ? 'switch.global' : 'switch.label'), text: t(global ? 'afk.global' : 'afk'), onChange: toggle,
              title: error || (!ready ? t(preferences.status === 'loading' ? 'scope.loading' : 'scope.error') : !writable ? t('forbidden') : (!global && !view) ? t('unavailable') : t(global ? 'switch.global' : 'switch.label')) }),
            h('button', { type: 'button', className: 'dsh-afk-history-trigger', disabled: !view || !historyAllowed,
              'aria-label': t('history.title'), 'aria-haspopup': 'dialog', 'aria-expanded': historyOpen,
              title: t('history.title'), onClick: () => setHistoryOpen(previous => !previous) },
              t('history.open'), h('span', { 'aria-hidden': true }, view?.unread ?? 0)),
            historyOpen ? h(HistoryDialog, { sessionId, view, allowed, historyAllowed, language, onClose: () => setHistoryOpen(false) }) : null,
            error ? h('span', { className: 'dsh-afk-error', role: 'alert' }, error) : null);
        }
        /** @param {AfkToolbarSlotProps} props */
        function AfkSlot(props) {
          const language = useLanguage();
          const view = props.useProjection(KEY);
          const allowed = props.useAccess('commands/execute');
          const globalAllowed = props.useRemoteAccess('settings/mutate');
          const historyAllowed = props.useAccess('afkHistory/history');
          return h(Toolbar, { key: props.sessionId, sessionId: props.sessionId, view, allowed, historyAllowed, globalAllowed, language });
        }

        /**
         * @param {{ sessionId: SessionId, total: number, unread: number, revision: number | undefined,
         *   allowed: boolean, historyAllowed: boolean, language: string }} props
         */
        function QuestionHistory({ sessionId, total, unread, revision, allowed, historyAllowed, language }) {
          const [filter, setFilter] = /** @type {[AfkHistory['filter'], React.Dispatch<React.SetStateAction<AfkHistory['filter']>>]} */ (React.useState('unread'));
          const [offset, setOffset] = React.useState(0);
          const [refresh, setRefresh] = React.useState(0);
          const [marking, setMarking] = React.useState('');
          const [readError, setReadError] = React.useState('');
          const [history, setHistory] = React.useState(/** @type {HistoryLoadState} */ ({ loading: true, data: null, error: '' }));
          const markRequest = React.useRef(/** @type {AbortController | null} */ (null));
          React.useEffect(() => () => markRequest.current?.abort(), []);
          React.useEffect(() => {
            if (!historyAllowed) { setHistory({ loading: false, data: null, error: t('forbidden') }); return; }
            const controller = new AbortController();
            let active = true;
            setHistory({ loading: true, data: null, error: '' });
            queryHistory(sessionId, { offset, limit: PAGE_SIZE, filter }, controller.signal)
              .then(data => {
                if (!active) return;
                if (data.total > 0 && offset >= data.total) {
                  setOffset(Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
                  return;
                }
                setHistory({ loading: false, data, error: '' });
              })
              .catch(failure => { if (active) setHistory({ loading: false, data: null, error: failureText(failure, t) }); });
            return () => { active = false; controller.abort(); };
          }, [sessionId, historyAllowed, revision, offset, refresh, filter]);
          /** @param {string} id */
          async function markRead(id) {
            if (!allowed || markRequest.current) return;
            const controller = new AbortController();
            markRequest.current = controller;
            setMarking(id); setReadError('');
            try {
              await execute(sessionId, `/afk read ${JSON.stringify([id])}`, controller.signal);
              // command/done advances the Session projection revision; it triggers the one automatic reload.
            } catch (failure) { if (!controller.signal.aborted) setReadError(failureText(failure, t)); }
            finally { if (!controller.signal.aborted) { markRequest.current = null; setMarking(''); } }
          }
          const data = history.data;
          const busy = history.loading || Boolean(marking);
          return h('section', { 'aria-busy': busy },
            h('div', { className: 'dsh-afk-row' }, h('h3', null, t('history.count', { total: data?.total ?? (filter === 'unread' ? unread : total) })),
              h('button', { type: 'button', className: 'dsh-afk-button', disabled: !historyAllowed || busy, onClick: () => setRefresh(value => value + 1) }, t('history.refresh'))),
            h('div', { className: 'dsh-afk-filters', role: 'tablist', 'aria-label': t('history.title') },
              (/** @type {const} */ (['unread', 'all'])).map(value => h('button', { key: value, type: 'button', role: 'tab', className: 'dsh-afk-button',
                'aria-selected': filter === value, disabled: Boolean(marking),
                onClick: () => { setFilter(value); setOffset(0); setReadError(''); } }, t(value === 'unread' ? 'history.unread' : 'history.all')))),
            h('p', { className: 'dsh-afk-muted' }, t('history.hintAll')),
            history.loading ? h('p', { role: 'status' }, t('history.loading')) : null,
            history.error || readError ? h('p', { className: 'dsh-afk-error', role: 'alert' }, history.error || readError) : null,
            data?.records.length === 0 ? h('p', { className: 'dsh-afk-muted' }, t(filter === 'unread' ? 'history.emptyUnread' : 'history.empty')) : null,
            data && data.records.length > 0 ? h('ol', { className: 'dsh-afk-history-list' }, data.records.map(record => h(HistoryRecord, {
              key: record.id, record, t, language, onMarkRead: markRead, marking, canMark: allowed,
            }))) : null,
            data && data.total > 0 ? h('nav', { className: 'dsh-afk-row', 'aria-label': t('history.title') },
              h('span', { className: 'dsh-afk-muted' }, t('history.page', { start: offset + 1, end: offset + data.records.length, total: data.total })),
              h('div', { className: 'dsh-afk-row' },
                h('button', { type: 'button', className: 'dsh-afk-button', disabled: busy || offset === 0, onClick: () => setOffset(value => Math.max(0, value - PAGE_SIZE)) }, t('history.previous')),
                h('button', { type: 'button', className: 'dsh-afk-button', disabled: busy || offset + PAGE_SIZE >= data.total, onClick: () => setOffset(value => value + PAGE_SIZE) }, t('history.next')))) : null);
        }
        /**
         * @param {{ sessionId: SessionId, view: AfkView | undefined, allowed: boolean,
         *   historyAllowed: boolean, language: string, onClose: () => void }} props
         */
        function HistoryDialog({ sessionId, view, allowed, historyAllowed, language, onClose }) {
          const ref = React.useRef(/** @type {HTMLDivElement | null} */ (null));
          const close = React.useRef(/** @type {HTMLButtonElement | null} */ (null));
          const id = React.useId();
          React.useEffect(() => {
            const dialog = ref.current;
            if (!dialog) return;
            const previousFocus = document.activeElement;
            // Native manual popover enters the top layer without making the application inert or drawing a mask.
            // Older engines fall back to the same component-owned fixed window.
            if (typeof dialog.showPopover === 'function') dialog.showPopover();
            close.current?.focus();
            /** @param {KeyboardEvent} event */
            const escape = event => {
              if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); }
            };
            document.addEventListener('keydown', escape);
            return () => {
              document.removeEventListener('keydown', escape);
              if (typeof dialog.hidePopover === 'function' && dialog.matches(':popover-open')) dialog.hidePopover();
              if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
            };
          }, []);
          return h('div', { ref, className: 'dsh-afk-dialog', role: 'dialog', popover: 'manual',
            'aria-modal': false, 'aria-labelledby': id },
            h('div', { className: 'dsh-afk-row dsh-afk-dialog-header' }, h('h3', { id }, t('history.title')),
              h('button', { ref: close, type: 'button', className: 'dsh-afk-button', onClick: onClose }, t('history.close'))),
            h(QuestionHistory, { key: sessionId, sessionId, total: view?.total ?? 0, unread: view?.unread ?? 0, revision: view?.revision, allowed, historyAllowed, language }));
        }

        /**
         * @typedef {{ view: AfkSettings, allowed: boolean, language: string } &
         *   ({ global: true, revision: number, sessionId?: never } |
         *    { global?: false, sessionId: SessionId, revision?: never })} SettingsEditorProps
         */
        /** @param {SettingsEditorProps} props */
        function SessionSettings({ sessionId, view, allowed, global = false, revision }) {
          const [draft, setDraft] = React.useState(() => settingsOf(view));
          const [dirty, setDirty] = React.useState(false);
          const baseRevision = React.useRef(revision);
          React.useEffect(() => {
            if (global && !dirty && baseRevision.current !== revision) {
              baseRevision.current = revision;
              setDraft(settingsOf(view)); setSaved(false);
            }
          }, [global, dirty, revision, view]);
          const [saving, setSaving] = React.useState(false);
          const [error, setError] = React.useState('');
          const [saved, setSaved] = React.useState(false);
          const request = React.useRef(/** @type {AbortController | null} */ (null));
          const ids = React.useId();
          React.useEffect(() => () => request.current?.abort(), []);
          /** @param {React.FormEvent<HTMLFormElement>} event */
          async function save(event) {
            event.preventDefault();
            if (!allowed || request.current || !validReply(draft.reply)) return;
            const controller = new AbortController();
            request.current = controller;
            setSaving(true); setError(''); setSaved(false);
            try {
              if (global) {
                const accepted = await preferencesForm.mutate([{ op: 'set', path: ['global'], value: { ...draft } }], baseRevision.current);
                if (!accepted && !controller.signal.aborted) {
                  const latest = preferencesForm.getSnapshot();
                  if (preferencesReady(latest)) {
                    baseRevision.current = latest.revision;
                    setDraft(settingsOf(latest.value.global)); setDirty(false);
                  }
                }
                requireAccepted(accepted);
                baseRevision.current = preferencesForm.getSnapshot().revision;
              } else {
                if (!sessionId) throw new Error(t('unavailable'));
                await execute(sessionId, `/afk set ${JSON.stringify(draft)}`, controller.signal);
              }
              if (!controller.signal.aborted) { setSaved(true); setDirty(false); }
            } catch (failure) { if (!controller.signal.aborted) setError(failureText(failure, t)); }
            finally { if (!controller.signal.aborted) { request.current = null; setSaving(false); } }
          }
          /** @param {Partial<AfkSettings>} patch */
          function change(patch) { setDraft(previous => ({ ...previous, ...patch })); setDirty(true); setSaved(false); setError(''); }
          return h(React.Fragment, null,
            h('section', { className: 'dsh-afk-section' }, h('h3', null, t(global ? 'settings.global' : 'settings.title')),
              !allowed ? h('p', { className: 'dsh-afk-error' }, t('forbidden')) : null,
              h('form', { onSubmit: save },
                h('label', { className: 'dsh-afk-row' }, t(global ? 'settings.enabled.global' : 'settings.enabled'),
                  h('input', { type: 'checkbox', checked: draft.enabled, disabled: !allowed || saving, onChange: (/** @type {React.ChangeEvent<HTMLInputElement>} */ event) => change({ enabled: event.target.checked }) })),
                h('fieldset', { className: 'dsh-afk-fieldset', disabled: !allowed || saving },
                  h('legend', null, t('mode.title')),
                  (/** @type {const} */ (['auto-reply', 'disable-ask'])).map(mode => h('label', { className: 'dsh-afk-mode', key: mode },
                    h('input', { type: 'radio', name: `${ids}-mode`, checked: draft.mode === mode, onChange: () => change({ mode }) }),
                    h('span', null, t(mode === 'auto-reply' ? 'mode.auto' : 'mode.disable'),
                      h('div', { className: 'dsh-afk-muted' }, t(mode === 'auto-reply' ? 'mode.auto.detail' : 'mode.disable.detail')))))),
                h('label', { className: 'dsh-afk-label', htmlFor: `${ids}-reply` }, t('reply.label')),
                h('textarea', { id: `${ids}-reply`, className: 'dsh-afk-reply', rows: 3, maxLength: 2000, required: true,
                  value: draft.reply, disabled: !allowed || saving, onChange: (/** @type {React.ChangeEvent<HTMLTextAreaElement>} */ event) => change({ reply: event.target.value }),
                  'aria-invalid': !validReply(draft.reply), 'aria-describedby': `${ids}-hint` }),
                h('p', { id: `${ids}-hint`, className: 'dsh-afk-muted' }, t('reply.hint')),
                !validReply(draft.reply) ? h('p', { className: 'dsh-afk-error' }, t('reply.required')) : null,
                h('p', { className: 'dsh-afk-muted' }, t('notice.new')),
                h('p', { className: 'dsh-afk-muted' }, t('notice.authority')),
                h('div', { className: 'dsh-afk-row' }, h('button', { className: 'dsh-afk-button dsh-afk-primary', type: 'submit', disabled: !allowed || saving || !validReply(draft.reply) }, t(saving ? 'saving' : 'save')),
                  h('span', { className: 'dsh-afk-muted' }, t('settings.draft'))),
                error ? h('p', { className: 'dsh-afk-error', role: 'alert' }, error) : null,
                saved ? h('p', { className: 'dsh-afk-success', role: 'status' }, t('saved')) : null)));
        }

        /** @param {{ binding: SessionBinding, sessionId: SessionId, allowed: boolean, language: string }} props */
        function BoundSettings({ binding, sessionId, allowed, language }) {
          const source = React.useMemo(() => binding.session.projections.faceOf(KEY), [binding]);
          // The projection registry validates the wire value; only availability is left to check.
          const view = /** @type {AfkView | undefined} */ (React.useSyncExternalStore(
            listener => source.subscribe(listener), () => source.getSnapshot(), () => undefined));
          return view ? h(SessionSettings, { key: sessionId, sessionId, view, allowed, language }) : h('p', { role: 'status' }, t('unavailable'));
        }
        /**
         * @param {{ sessionId: SessionId, useSessionAccess: GlobalStandardProps['useSessionAccess'], language: string }} props
         */
        function RetainedSettings({ sessionId, useSessionAccess, language }) {
          const allowed = useSessionAccess(sessionId, 'commands/execute');
          const [state, setState] = React.useState(/** @type {{ binding: SessionBinding | null, error: string }} */ ({ binding: null, error: '' }));
          React.useEffect(() => {
            const controller = new AbortController();
            /** @type {SessionReference | undefined} */
            let reference;
            let active = true;
            setState({ binding: null, error: '' });
            try {
              reference = ctx.sessions.retain(sessionId, { source: 'controllerOperation', signal: controller.signal });
              reference.ready.then(binding => { if (active) setState({ binding, error: '' }); })
                .catch(failure => { if (active) setState({ binding: null, error: failureText(failure, t) }); });
            } catch (failure) { setState({ binding: null, error: failureText(failure, t) }); }
            return () => { active = false; controller.abort(); reference?.release(); };
          }, [sessionId]);
          if (state.error) return h('p', { className: 'dsh-afk-error', role: 'alert' }, state.error);
          return state.binding ? h(BoundSettings, { binding: state.binding, sessionId, allowed, language }) : h('p', { role: 'status' }, t('loading'));
        }
        /** @param {{ preferences: ReadyAfkPreferences, allowed: boolean }} props */
        function ScopeSettings({ preferences, allowed }) {
          const [draft, setDraft] = React.useState(() => profileSettingsOf(preferences.value));
          const [dirty, setDirty] = React.useState(false);
          const [saving, setSaving] = React.useState(false);
          const [error, setError] = React.useState('');
          const [saved, setSaved] = React.useState(false);
          const baseRevision = React.useRef(preferences.revision);
          const request = React.useRef(/** @type {AbortController | null} */ (null));
          const id = React.useId();
          React.useEffect(() => () => request.current?.abort(), []);
          React.useEffect(() => {
            if (!dirty && baseRevision.current !== preferences.revision) {
              baseRevision.current = preferences.revision;
              setDraft(profileSettingsOf(preferences.value)); setSaved(false);
            }
          }, [dirty, preferences]);
          /** @param {React.FormEvent<HTMLFormElement>} event */
          async function save(event) {
            event.preventDefault();
            if (!allowed || request.current || !dirty) return;
            /** @type {SettingsPathOpView[]} */
            const ops = [
              { op: 'set', path: ['scope'], value: draft.scope },
              { op: 'set', path: ['toolsEnabled'], value: draft.toolsEnabled },
            ];
            const controller = new AbortController();
            request.current = controller;
            setSaving(true); setError(''); setSaved(false);
            try {
              const accepted = await preferencesForm.mutate(ops, baseRevision.current);
              const latest = preferencesForm.getSnapshot();
              if (!controller.signal.aborted) {
                if (preferencesReady(latest)) {
                  baseRevision.current = latest.revision;
                  setDraft(profileSettingsOf(latest.value)); setDirty(false);
                }
                requireAccepted(accepted);
                setSaved(true);
              }
            } catch (failure) { if (!controller.signal.aborted) setError(failureText(failure, t)); }
            finally { if (!controller.signal.aborted) { request.current = null; setSaving(false); } }
          }
          /** @param {Partial<Pick<AfkPreferences, 'scope' | 'toolsEnabled'>>} patch */
          function change(patch) {
            setDraft(previous => ({ ...previous, ...patch }));
            setDirty(true); setSaved(false); setError('');
          }
          return h('section', { className: 'dsh-afk-section' },
            h('h3', null, t('settings.profile')),
            h('p', { className: 'dsh-afk-muted' }, t('scope.hint')),
            h('form', { onSubmit: save },
              h('label', { className: 'dsh-afk-label', htmlFor: id }, t('scope.title')),
              h('select', { id, className: 'dsh-afk-select dsh-afk-scope-select', value: draft.scope, disabled: !allowed || saving,
                onChange: (/** @type {React.ChangeEvent<HTMLSelectElement>} */ event) => {
                   const value = event.target.value;
                   if (value !== 'session' && value !== 'global') return;
                   change({ scope: value });
                 } },
                ['session', 'global'].map(value => h('option', { key: value, value }, t(value === 'session' ? 'scope.session' : 'scope.global')))),
              draft.scope === 'global' ? h('p', { className: 'dsh-afk-muted' }, t('scope.global.hint')) : null,
              h('label', { className: 'dsh-afk-row' }, t('tools.label'),
                h('input', { type: 'checkbox', checked: draft.toolsEnabled, disabled: !allowed || saving,
                  'aria-describedby': `${id}-tools-hint`,
                  onChange: (/** @type {React.ChangeEvent<HTMLInputElement>} */ event) => change({ toolsEnabled: event.target.checked }) })),
              h('p', { id: `${id}-tools-hint`, className: 'dsh-afk-muted' }, t('tools.hint')),
              h('button', { type: 'submit', className: 'dsh-afk-button dsh-afk-primary', disabled: !allowed || saving || !dirty }, t(saving ? 'saving' : 'scope.apply')),
              !allowed ? h('p', { className: 'dsh-afk-error' }, t('forbidden')) : null,
              error ? h('p', { className: 'dsh-afk-error', role: 'alert' }, error) : null,
              saved ? h('p', { className: 'dsh-afk-success', role: 'status' }, t('saved')) : null));
        }
        /** @param {AfkBundleConfigProps} props */
        function SettingsPage(props) {
          const language = useLanguage();
          const preferences = usePreferences();
          const ready = preferencesReady(preferences);
          const globalAllowed = props.useRemoteAccess('settings/mutate') && preferences.writable;
          const catalog = props.useSessions(state => state);
          const current = catalog.ids.find(id => (catalog.byId[id]?.retainedBy.mainView ?? 0) > 0);
          const [selected, setSelected] = React.useState(/** @returns {SessionId | ''} */ () => current || '');
          React.useEffect(() => { if (!selected && current) setSelected(current); }, [selected, current]);
          const sessionId = selected;
          return h('div', { className: 'dsh-afk dsh-afk-page' }, h('style', null, css),
            !ready ? h('p', { role: 'status' }, t(preferences.status === 'loading' ? 'scope.loading' : 'scope.error')) : h(React.Fragment, null,
              h(ScopeSettings, { preferences, allowed: globalAllowed }),
              preferences.value.scope === 'global'
                ? h(SessionSettings, { key: 'global', global: true, view: preferences.value.global, revision: preferences.revision, allowed: globalAllowed, language })
                : h('section', { className: 'dsh-afk-section' },
                  h('p', { className: 'dsh-afk-muted' }, t('settings.scope')),
                  h('label', { className: 'dsh-afk-label' }, t('settings.session'),
                    h('select', { className: 'dsh-afk-select', value: sessionId, onChange: (/** @type {React.ChangeEvent<HTMLSelectElement>} */ event) => {
                       const value = event.target.value;
                       // Preserve the SDK brand only for identities from this Host's catalog.
                       setSelected(catalog.ids.find(id => id === value) ?? '');
                     } },
                      h('option', { value: '' }, t('settings.choose')),
                      catalog.ids.map(id => h('option', { key: id, value: id }, catalog.byId[id]?.displayTitle || id)))),
                  sessionId ? h(RetainedSettings, { key: sessionId, sessionId, useSessionAccess: props.useSessionAccess, language }) : null)));
        }
        /** @param {AfkBundleConfigProps} props */
        function BundleConfig(props) {
          return props.view === 'page' ? h(SettingsPage, props) : null;
        }
        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview', key: 'afk',
        }, AfkCommandView));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: KEY, order: 0,
        }, AfkSlot));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: KEY,
        }, BundleConfig));
      },
    };
  },
});
