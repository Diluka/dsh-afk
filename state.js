import { z } from 'zod';

export const KEY = 'dsh-afk';
export const ASK = 'ask_user_question';
export const MARK_READ = 'afk_mark_read';
// Travels inside the schema-validated answer itself, so native and PTC logs retain provenance.
export const REPLY_PREFIX = '[AFK 自动应答 / not human approval]\n';
export const BLOCK_PREFIX = '[dsh-afk/blocked-v1] ';
export const LEGACY_BLOCK_MESSAGE = 'AFK: ask_user_question is disabled while the user is away. Choose a safe approach within existing authority; do not treat absence as approval.';
export const REQUEST_STATE_PREFIX = '[dsh-afk/request-state-v1] ';
const requestStateSchema = z.object({ scope: z.enum(['session', 'global']), enabled: z.boolean(), mode: z.enum(['auto-reply', 'disable-ask']) }).strict();
export const DEFAULT_REPLY = '用户暂时不在，请在既有授权范围内自行选择最优方式继续；需要明确授权的操作请保留，等待用户回来确认。';
export const settingsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['auto-reply', 'disable-ask']),
  reply: z.string().min(1).max(2000).refine(value => value.trim().length > 0),
});
export const questionSchema = z.object({
  id: z.string(), question: z.string(), header: z.string().optional(), detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
});
const questionsSchema = z.array(questionSchema).min(1).refine(items => new Set(items.map(item => item.id)).size === items.length);
const recordSchema = z.object({
  id: z.string(), callId: z.string(), time: z.number(), mode: settingsSchema.shape.mode.nullable(), afk: z.boolean().nullable(),
  requestState: requestStateSchema.nullable(),
  questions: questionsSchema, reply: z.string(), read: z.boolean(),
  status: z.enum(['pending', 'auto-replied', 'blocked', 'answered', 'failed']),
  answer: z.unknown().optional(),
});
export const viewSchema = settingsSchema.extend({
  total: z.number().int().nonnegative(), unread: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
});
const pendingSchema = z.object({ callId: z.string(), time: z.number(), seq: z.number(), questions: questionsSchema });
const stateSchema = z.object({
  floor: z.number(), view: viewSchema, records: z.array(recordSchema), requestState: requestStateSchema.nullable(),
  commands: z.array(z.string()), pending: z.array(pendingSchema), marks: z.array(z.string()),
});
const idsSchema = z.array(z.string().min(1)).min(1).max(50).refine(ids => new Set(ids).size === ids.length);
const readValueSchema = z.object({ type: z.literal('dsh-afk/read-v1'), readIds: z.array(z.string().min(1)) });

export function settingsOf(state) {
  const { enabled, mode, reply } = state.view;
  return { enabled, mode, reply };
}

export function parseQuestions(args) {
  if (!args || !Array.isArray(args.questions)) return undefined;
  const parsed = questionsSchema.safeParse(args.questions.map(question => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return question;
    // Native ask permits arbitrary extension fields but only consumes these fields.
    // In particular, a foreign `multiSelect` or non-string `detail` is not an input constraint.
    return {
      id: question.id, question: question.question,
      ...(question.header !== undefined ? { header: question.header } : {}),
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(question.options !== undefined ? { options: question.options } : {}),
      ...(question.multi_select !== undefined ? { multiSelect: question.multi_select } : {}),
    };
  }));
  return parsed.success ? parsed.data : undefined;
}

function json(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function outcome(content) {
  const text = content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
  return json(text) ?? text;
}

function recordCall(state, event, callId, args) {
  const questions = parseQuestions(args);
  if (!questions || state.pending.some(call => call.callId === callId)) return state;
  const call = { callId, questions, time: event.time, seq: event.seq };
  const record = {
    id: `${event.seq}:${callId}`, callId, time: event.time, mode: null, afk: null, requestState: state.requestState,
    questions, reply: '', read: false, status: 'pending',
  };
  return {
    ...state, pending: [...state.pending, call], records: [...state.records, record],
    view: { ...state.view, total: state.view.total + 1, unread: state.view.unread + 1, revision: state.view.revision + 1 },
  };
}

function recordResult(state, callId, result) {
  const pending = state.pending.find(call => call.callId === callId);
  if (!pending) return state;
  const rest = state.pending.filter(call => call !== pending);
  const index = state.records.findIndex(record => record.id === `${pending.seq}:${callId}`);
  if (index < 0) return { ...state, pending: rest };
  const answer = outcome(result.content);
  const answers = answer?.answers;
  const reply = Array.isArray(answers) && answers.length === pending.questions.length
    && answers.every((item, answerIndex) => item && item.id === pending.questions[answerIndex].id
      && typeof item.custom === 'string' && item.custom.startsWith(REPLY_PREFIX)
      && Array.isArray(item.selected) && item.selected.length === 0 && item.custom === answers[0].custom)
    ? answers[0].custom : '';
  const previous = state.records[index];
  const errorText = typeof answer === 'string' ? answer.replace(/^Error: /, '') : '';
  const blocked = result.isError && (errorText.startsWith(BLOCK_PREFIX) || errorText === LEGACY_BLOCK_MESSAGE);
  // Only the final result proves intervention. Configuration, UNKNOWN_TOOL and other failures do not.
  const automatic = !result.isError && Boolean(reply);
  const status = result.isError ? (blocked ? 'blocked' : 'failed')
    : automatic ? 'auto-replied' : answer?.pending ? 'pending' : 'answered';
  const afk = blocked || automatic ? true : status === 'answered' ? false : null;
  const mode = blocked ? 'disable-ask' : automatic ? 'auto-reply' : null;
  const records = [...state.records];
  records[index] = { ...previous, status, afk, mode, reply: automatic ? reply : '', answer };
  return {
    ...state, pending: rest, records,
    view: { ...state.view, revision: state.view.revision + 1 },
  };
}

/** One pure operation shared by human commands and the model-facing counterpart. */
export function markReadOf(state, recordIds) {
  const parsed = idsSchema.safeParse(recordIds);
  if (!parsed.success) throw new Error('recordIds must contain 1–50 distinct non-empty record IDs');
  const selected = new Set(parsed.data);
  const known = new Set(state.records.map(record => record.id));
  const unknown = parsed.data.filter(id => !known.has(id));
  if (unknown.length) throw new Error(`Unknown question record(s) in this session: ${unknown.join(', ')}`);
  return {
    type: 'dsh-afk/read-v1',
    readIds: state.records.filter(record => record.read || selected.has(record.id)).map(record => record.id),
  };
}

function applyReadValue(state, value) {
  const parsed = readValueSchema.safeParse(value);
  if (!parsed.success) return state;
  const selected = new Set(parsed.data.readIds);
  let changed = 0;
  const records = state.records.map(record => {
    if (record.read || !selected.has(record.id)) return record;
    changed++;
    return { ...record, read: true };
  });
  if (!changed) return state;
  // Read acknowledgements are monotonic: merging concurrent complete snapshots never resurrects an item.
  return { ...state, records, view: { ...state.view, unread: state.view.unread - changed, revision: state.view.revision + 1 } };
}

function readToolResult(state, callId, result) {
  if (!state.marks.includes(callId)) return state;
  const next = { ...state, marks: state.marks.filter(id => id !== callId) };
  if (result.isError) return next;
  // Definition-owned metadata survives output spilling while still following the final success/failure.
  return applyReadValue(next, result.meta?.dshAfkRead ?? outcome(result.content));
}

/** All durable state is reconstructed from existing command and tool events. */
export const projection = {
  key: KEY, stateSchema, stateVersion: 3,
  init(_header, inheritedEventCount = 0) {
    return {
      floor: inheritedEventCount, records: [], commands: [], pending: [], marks: [], requestState: null,
      view: { enabled: false, mode: 'auto-reply', reply: DEFAULT_REPLY, total: 0, unread: 0, revision: 0 },
    };
  },
  apply(state, event) {
    if (event.seq < state.floor) return state; // A fork never inherits unattended authority or read receipts.
    const data = event.data;
    if (event.type === 'user/message' && data.source?.kind === 'runtime-context' && data.source.form === 'snapshot') {
      // Trust the framework's named source sections, never a matching prefix in ordinary user text.
      const section = data.source.sections.find(section => section.name === KEY);
      const line = section?.text.split('\n', 1)[0] ?? '';
      const parsed = requestStateSchema.safeParse(line.startsWith(REQUEST_STATE_PREFIX) ? json(line.slice(REQUEST_STATE_PREFIX.length)) : undefined);
      const requestState = parsed.success ? parsed.data : null;
      if (JSON.stringify(requestState) === JSON.stringify(state.requestState)) return state;
      return { ...state, requestState };
    }
    if (event.type === 'command/run' && data.name === 'afk' && data.source?.kind === 'user'
      && /^(set\s|read\s|on\s*$|off\s*$)/.test((data.args ?? '').trim())) {
      return { ...state, commands: [...state.commands, data.commandId] };
    }
    if (event.type === 'command/done' && state.commands.includes(data.commandId)) {
      const next = { ...state, commands: state.commands.filter(id => id !== data.commandId) };
      if (data.kind !== 'success') return next;
      const value = json(data.text);
      if (value?.type === 'dsh-afk/read-v1') return applyReadValue(next, value);
      const parsed = settingsSchema.safeParse(value?.settings);
      if (value?.type !== 'dsh-afk/settings-v1' || !parsed.success) return next;
      return { ...next, view: { ...state.view, ...parsed.data, revision: state.view.revision + 1 } };
    }
    if (event.type === 'user/message' && data.source?.kind === 'user-question-reply' && data.source.outcome === 'answered') {
      const index = state.records.findLastIndex(record => record.callId === data.source.callId);
      if (index < 0) return state;
      const records = [...state.records];
      records[index] = { ...records[index], status: 'answered', afk: false, mode: null, reply: '', answer: outcome(data.content) };
      return { ...state, records, view: { ...state.view, revision: state.view.revision + 1 } };
    }
    if (event.type === 'tool/call') {
      if (data.name === ASK) return recordCall(state, event, data.callId, json(data.arguments));
      if (data.name === MARK_READ) return { ...state, marks: [...state.marks, data.callId] };
    }
    if (event.type === 'tool/ptc-dispatch-start') {
      if (data.name === ASK) return recordCall(state, event, data.subCallId, data.arguments);
      if (data.name === MARK_READ) return { ...state, marks: [...state.marks, data.subCallId] };
    }
    if (event.type === 'tool/result') {
      const result = { ...data.message, meta: data.meta };
      if (state.marks.includes(data.message.toolCallId)) return readToolResult(state, data.message.toolCallId, result);
      return recordResult(state, data.message.toolCallId, result);
    }
    if (event.type === 'tool/ptc-dispatch') {
      if (data.name === MARK_READ) return readToolResult(state, data.subCallId, data);
      if (data.name === ASK) return recordResult(state, data.subCallId, data);
    }
    return state;
  },
  wire: { viewSchema, view: state => state.view },
};

export function historyOf(state, offset = 0, limit = 20, filter = 'unread') {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('offset must be a non-negative integer; limit must be between 1 and 50');
  }
  if (filter !== 'unread' && filter !== 'all') throw new Error('filter must be unread or all');
  const records = filter === 'unread' ? state.records.filter(record => !record.read) : state.records;
  const end = Math.max(0, records.length - offset);
  return {
    total: records.length, totalAll: state.records.length, unread: state.view.unread, filter, offset, limit,
    records: records.slice(Math.max(0, end - limit), end).reverse(),
  };
}
