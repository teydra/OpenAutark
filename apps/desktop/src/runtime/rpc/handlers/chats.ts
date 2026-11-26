// RPC handlers: chats (list/get/create/update/members/archive/unarchive/delete/read/search) and
// messages (list/send/edit/delete/stop/retry/schedule). Block answers/state/events live in
// blocks.ts and are registered from here.
// Owns: param checks, scope rules and the human side of these flows (messages are sent as
// 'human' – B-050 K4 at a level: normal, important or silent, never both; K6 a `model` is the
// addressed agent's hint, `pin: true` pins it – chat/sticky-model.ts is the one writer; B-083: settings.temperatures
// is the person's temperature suggestion per agent, 0..1). Phones with
// 'chat' may rename/pin/mute, change members and (un)archive; hiding a chat stays on the PC, and they edit or delete
// only messages written by the human (never a person's message). Deleting a chat stays owner-only. A chat has no mode
// of its own (13.11.2026: the mode belongs to the agent) – settings.mode is not written. B-078: settings.parentId places a chat under
// another one (null: back on top; chat/children.ts checks it) and chats.thread finds or opens the thread on a message –
// or (Quests 20.11.2026) a task's own thread (tasks/thread.ts); chats.threadNews names the tasks whose thread has unread lines.
// B-085: messages.send from an agent's own wf (owner scope with agentId) posts as that agent (sendAsAgent).
// 16.11.2026: the person's messages.send and messages.edit store a pasted key in the secrets catalog first and carry its
// handle (secrets/text-capture.ts addKeysSaved).
// Never: business logic – it delegates to the chat service, dispatcher, wake queue and scheduler.

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { excerpt } from '../../../shared/text/chat-names.ts';
import type { Attachment, ConversationSettings, Message, SendMessageInput } from '../../../shared/model/chat.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import type { ScheduleSpec } from '../../../shared/model/tasks.ts';
import { HINT_ID } from '../../../shared/model/model-guide.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { chatTitleFor } from '../../chat/titles.ts';
import { openThread, setParent } from '../../chat/children.ts';
import { threadNews, threadOf } from '../../tasks/thread.ts';
import { POST_PRIORITIES, scheduledPost } from '../../schedules/post.ts';
import {
  bad, id, ids, input, notFound, num, obj, onlyKeys, optBool, optId, optIds, optMemberIds, optNum, optObj, optOneOf, optText, text, type Obj,
} from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import { register as registerBlocks } from './blocks.ts';
import { rememberConversation } from './system.ts';
import { registerExternalAgents } from '../../bridges/external-rpc.ts'; // C8
import { attachedSecrets } from '../../secrets/chat-capture.ts';
import { addKeysSaved } from '../../secrets/text-capture.ts';
import { callLogOf, talkerOf } from '../../calls/wiring.ts';
import { callDevice } from './calls.ts';
import { todos } from '../../agents/chat-out.ts';

const CHAT = { capability: 'chat' } as const;
const EFFORTS: readonly Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_BODY = 100_000;
const MAX_ATTACHMENTS = 20;
/** Chat settings a client may send. Never 'system': only the runtime marks app-owned chats (C1). */
const SETTINGS_KEYS = ['notifications', 'sound', 'models', 'efforts', 'mode', 'image', 'hiddenFromList', 'modelHints', 'temperatures', 'history', 'parentId'] as const; // modelHints: SG soft model suggestion; temperatures (B-083): the person's temperature suggestion per agent; history (F-52): what people who join later see

/** Chat settings a phone/browser may change depend on its tier (the owner may change all). */
function checkDeviceSettings(ctx: HandlerContext, settings: Partial<ConversationSettings> | undefined): void {
  if (ctx.scope.kind !== 'device' || !settings) return;
  if ('hiddenFromList' in settings) {
    throw new WorkforceError('forbidden', 'Hiding a chat is only possible on the PC.', { details: { param: 'settings.hiddenFromList' } });
  }
}

/**
 * Phones/browsers act as the human: they may only change what the human wrote. Nobody here
 * changes or deletes what a person of the organisation wrote.
 */
function checkDeviceMessage(ctx: HandlerContext, messageId: string): void {
  const message = ctx.services.chats.message(messageId) ?? notFound('Message', { messageId });
  if (message.authorKind === 'human' && isPersonId(message.authorId)) {
    throw new WorkforceError('forbidden', 'Only the person who wrote this message can change it.', { details: { messageId } });
  }
  if (ctx.scope.kind !== 'device') return;
  if (message.authorKind !== 'human' || message.authorId !== HUMAN_ID) throw new WorkforceError('forbidden', 'Only your own messages can be changed from this device.', { details: { messageId } });
}

function chatOrThrow(services: RuntimeServices, conversationId: string) {
  return services.chats.get(conversationId) ?? notFound('Chat', { conversationId });
}

/** Attachments must be stored files; size/mime come from the store, never from the client. */
export function attachmentsOf(services: RuntimeServices, value: unknown): Attachment[] { // also the task center's quick intake
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) bad('attachments', `a list of at most ${MAX_ATTACHMENTS} attachments`);
  return value.map((entry) => {
    const a = input(entry);
    const fileId = text(a, 'fileId', { max: 64 });
    const ref = services.files.get(fileId) ?? bad('attachments', 'files uploaded with files.upload');
    const attachment: Attachment = { fileId: ref.id, name: optText(a, 'name', { max: 200 }) ?? ref.name, mime: ref.mime, size: ref.size };
    if (ref.width !== undefined) attachment.width = ref.width;
    if (ref.height !== undefined) attachment.height = ref.height;
    const duration = ref.durationMs ?? optNum(a, 'durationMs', { min: 0, max: 7 * 24 * 3_600_000 });
    if (duration !== undefined) attachment.durationMs = duration;
    return attachment;
  });
}

function settingsOf(value: unknown): Partial<ConversationSettings> | undefined {
  if (value === undefined || value === null) return undefined;
  const o = input(value);
  onlyKeys(o, SETTINGS_KEYS, 'settings');
  const out: Record<string, unknown> = {};
  // null clears a key (JSON has no undefined).
  for (const key of SETTINGS_KEYS) if (key in o) out[key] = o[key] === null ? undefined : o[key];
  if (out.notifications !== undefined) optOneOf(out, 'notifications', ['default', 'all', 'mentions', 'off']);
  if (out.sound !== undefined) optBool(out, 'sound');
  if (out.hiddenFromList !== undefined) optBool(out, 'hiddenFromList');
  delete out.mode; // the mode is the agent's own (agents.update), never a chat's
  if (out.image !== undefined) text(out, 'image', { max: 120 });
  if (out.history !== undefined) optOneOf(out, 'history', ['join', 'full']);
  if (out.parentId !== undefined) id(out, 'parentId');
  for (const key of ['models', 'efforts', 'modelHints'] as const) {
    if (out[key] === undefined) continue;
    const record = obj(out, key);
    for (const [agentId, choice] of Object.entries(record)) {
      if (typeof choice !== 'string' || choice.length > 200 || agentId.length > 128) bad(`settings.${key}`, 'agent id → model/effort text');
      if (key === 'modelHints' && !HINT_ID.test(choice)) bad('settings.modelHints', 'agent id → model id'); // SG: it reaches prompts
    }
  }
  if (out.temperatures !== undefined) { // B-083: agent id → 0..1 (the composer's suggestion; routing/policies.ts chatChoice)
    for (const [agentId, value] of Object.entries(obj(out, 'temperatures'))) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || agentId.length > 128) bad('settings.temperatures', 'agent id → a number 0..1');
    }
  }
  return out as Partial<ConversationSettings>;
}

/**
 * B-050 K4: a message's level – `priority` and `silent` (quiet: lands in the history, wakes only @mentioned
 * members, never unread or pushed); a message is never both important and silent.
 */
export function levelOf(o: Obj): { priority?: 'normal' | 'important'; silent?: boolean } { // also the person's messages.send
  const priority = optOneOf(o, 'priority', ['normal', 'important']);
  const silent = optBool(o, 'silent');
  if (silent && priority === 'important') bad('silent', 'either silent or priority important, not both');
  return { ...(priority ? { priority } : {}), ...(silent ? { silent } : {}) };
}

/** K6: the model asked for with a message or a new task – a model id (it reaches prompts and the chat line) or 'auto'. */
export function modelOf(o: Obj): string | undefined {
  const model = optText(o, 'model', { max: 200 });
  if (model !== undefined && model !== 'auto' && !HINT_ID.test(model)) bad('model', 'a model id or auto');
  return model;
}

/** Agents to stop in a chat: running there now (dispatcher), or still streaming a message. */
export function runningIn(services: RuntimeServices, conversationId: string, agentId?: string): string[] {
  const out = new Set<string>();
  for (const item of services.dispatcher.activity()) {
    if (!item.split && item.conversationId === conversationId && (!agentId || item.agentId === agentId)) out.add(item.agentId); // B-057: a split's lane is stopped through its group
  }
  for (const message of services.chats.messages(conversationId, { limit: 30 })) {
    if (message.state === 'streaming' && message.authorKind === 'agent' && (!agentId || message.authorId === agentId)) out.add(message.authorId);
  }
  if (agentId) out.add(agentId);
  return [...out];
}

/** What only the person's lines carry: an agent's own wf sends text, attachments, mentions, a level and replyTo. */
const PERSON_ONLY = ['model', 'effort', 'pin', 'speech', 'secrets', 'ultra', 'marks'] as const;

/**
 * B-085: messages.send from an agent's own wf (owner scope with agentId, http/ws.ts) posts as that agent – its member
 * rules, no self-wake – under its running main turn, else under no run; its ask blocks become to-dos (agents/chat-out.ts).
 */
function sendAsAgent(ctx: HandlerContext, agentId: string, conversationId: string, o: Obj): Message {
  const { services } = ctx;
  const agent = services.org.get(agentId);
  if (!agent || agent.archivedAt !== undefined) throw new WorkforceError('forbidden', 'This agent is archived or gone.', { details: { agentId } });
  for (const key of PERSON_ONLY) if (o[key] !== undefined) bad(key, "no value on an agent's line (text, attachments, mentions, priority or silent, replyTo)");
  const body = text(o, 'body', { max: 60_000, allowEmpty: true, multiline: true });
  if (!body.trim()) bad('body', 'text'); // files go with text
  const attachments = attachmentsOf(services, o.attachments);
  const mentions = optMemberIds(o, 'mentions', 20);
  const runId = services.dispatcher.activity().find((item) => item.agentId === agentId && !item.split)?.runId;
  const message = services.chats.send({
    conversationId, body, authorId: agentId, authorKind: 'agent', ...levelOf(o), ...(attachments.length ? { attachments } : {}),
    ...(mentions?.length ? { mentions } : {}), ...(optId(o, 'replyTo') ? { replyTo: optId(o, 'replyTo') } : {}), ...(runId ? { runId } : {}),
  });
  todos(services, message);
  return message;
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- chats
  table.add('chats.list', (params, ctx) => {
    const o = input(params);
    return ctx.services.chats.list({ includeHidden: optBool(o, 'includeHidden'), search: optText(o, 'search', { max: 200, allowEmpty: true }) });
  }, CHAT);
  table.add('chats.get', (params, ctx) => ctx.services.chats.summary(id(input(params))), CHAT);
  table.add('chats.create', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['title', 'agentIds', 'spaceId', 'firstMessage', 'people']);
    const { chats } = ctx.services;
    const conversation = chats.create({
      title: optText(o, 'title', { max: 120, allowEmpty: true }), agentIds: ids(o, 'agentIds', 50), spaceId: optId(o, 'spaceId'), createdBy: HUMAN_ID,
      people: optIds(o, 'people', 50), // F-52: people of the organisation (chat/create.ts checks each)
    });
    const first = optText(o, 'firstMessage', { max: MAX_BODY, allowEmpty: true, multiline: true });
    if (first?.trim()) chats.send({ conversationId: conversation.id, body: first, authorId: HUMAN_ID, authorKind: 'human' });
    rememberConversation(ctx, conversation.id);
    return chats.get(conversation.id) ?? conversation;
  }, CHAT);
  table.add('chats.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'title', 'pinned', 'settings']);
    const settings = settingsOf(o.settings);
    checkDeviceSettings(ctx, settings);
    const conversationId = id(o);
    if (settings && 'parentId' in settings) { // B-078: checked and written by chat/children.ts, never as a plain setting
      setParent(ctx.services, conversationId, settings.parentId ?? null, HUMAN_ID);
      delete settings.parentId;
    }
    return ctx.services.chats.update(conversationId, { title: optText(o, 'title', { max: 120 }), pinned: optBool(o, 'pinned'), settings }, HUMAN_ID);
  }, CHAT);
  table.add('chats.thread', (params, ctx) => { // B-078: the thread on a message (found, or opened with its chat's members); a task's own thread
    const o = input(params);
    onlyKeys(o, ['messageId', 'taskId']);
    const taskId = optId(o, 'taskId');
    const thread = taskId ? threadOf(ctx.services, taskId, HUMAN_ID) : openThread(ctx.services, id(o, 'messageId'), HUMAN_ID);
    return ctx.services.chats.summary(thread.id);
  }, CHAT);
  table.add('chats.threadNews', (_params, ctx) => threadNews(ctx.services, HUMAN_ID), CHAT);
  table.add('chats.members', (params, ctx) => {
    const o = input(params);
    const change = { add: optIds(o, 'add', 50), remove: optMemberIds(o, 'remove', 50), lead: optId(o, 'lead') };
    return ctx.services.chats.setMembers(id(o), change, HUMAN_ID);
  }, CHAT);
  table.add('chats.archive', (params, ctx) => {
    const conversationId = id(input(params));
    ctx.services.chats.archive(conversationId);
    return { ok: true };
  }, CHAT);
  table.add('chats.unarchive', (params, ctx) => { // C2
    const conversationId = id(input(params));
    ctx.services.chats.unarchive(conversationId);
    return { ok: true };
  }, CHAT);
  table.add('chats.delete', (params, ctx) => {
    const conversationId = id(input(params));
    ctx.services.chats.remove(conversationId);
    return { ok: true };
  });
  table.add('chats.markRead', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o);
    chatOrThrow(ctx.services, conversationId);
    ctx.services.chats.markRead(conversationId, HUMAN_ID, num(o, 'seq', { min: 0 }));
    rememberConversation(ctx, conversationId);
    return { ok: true };
  }, CHAT);
  table.add('chats.search', (params, ctx) => {
    const o = input(params);
    const query = text(o, 'text', { max: 200 });
    const conversationId = optId(o, 'conversationId');
    const titles = new Map<string, string>();
    return ctx.services.chats.search(query, { conversationId, limit: optNum(o, 'limit', { min: 1, max: 100 }) ?? 30 })
      .map(({ message, snippet }) => {
      if (!titles.has(message.conversationId)) titles.set(message.conversationId, chatTitleFor(ctx.services, message.conversationId, HUMAN_ID)); // K2: as the owner sees it
      return { message, conversationTitle: titles.get(message.conversationId)!, snippet };
    });
  }, CHAT);

  // ---------------------------------------------------------------- messages
  table.add('messages.list', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    chatOrThrow(ctx.services, conversationId);
    return ctx.services.chats.messages(conversationId, {
      beforeSeq: optNum(o, 'beforeSeq', { min: 0 }), limit: optNum(o, 'limit', { min: 1, max: 200 }) ?? 60,
    });
  }, CHAT);
  addKeysSaved(table, 'messages.send', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'body', 'attachments', 'mentions', 'priority', 'silent', 'replyTo', 'model', 'effort', 'pin', 'clientId', 'speech', 'secrets', 'ultra', 'marks']);
    const conversationId = id(o, 'conversationId');
    const chat = chatOrThrow(ctx.services, conversationId);
    if (ctx.scope.kind === 'owner' && ctx.scope.agentId) return sendAsAgent(ctx, ctx.scope.agentId, conversationId, o); // B-085: an agent's own wf
    const body = text(o, 'body', { max: MAX_BODY, allowEmpty: true, multiline: true });
    const attachments = attachmentsOf(ctx.services, o.attachments);
    const secrets = attachedSecrets(ctx.services, conversationId, o.secrets);
    if (!body.trim() && !attachments.length && !secrets.length) bad('body', 'text or an attachment');
    const level = levelOf(o);
    const model = modelOf(o);
    const pin = optBool(o, 'pin');
    if (pin && model === undefined) bad('pin', 'pin: true only together with a model');
    const ultra = optBool(o, 'ultra'); // B-057 (owner 30.10.2026): Ultra suggested for this one message – a hint, the agent decides
    const mentions = optMemberIds(o, 'mentions', 50);
    // A line said live belongs to this device's call in the chat (the one speech.call names, else the open one, else a new
    // one – calls/call-log.ts). A plain one the call talker answers (calls/talker.ts), stored quiet until it passes it on.
    const speech = o.speech as { live?: unknown; call?: unknown } | undefined;
    const device = speech?.live === true && (ctx.scope.kind === 'owner' || ctx.scope.kind === 'device') ? callDevice(ctx) : undefined;
    const log = device ? callLogOf(ctx.services) : undefined;
    const callId = device && log ? log.start(conversationId, device, ctx.signal, typeof speech?.call === 'string' ? speech.call : undefined) : undefined;
    const talker = callId && body.trim() && !attachments.length && !secrets.length && !mentions?.length && !Object.keys(level).length && model === undefined && !ultra ? talkerOf(ctx.services) : undefined;
    const talks = talker?.serves(conversationId, callId) ? talker : undefined; // B-081: as the agent who rang this call
    const relay = talker && !talks && callId && log?.relays(conversationId, callId) ? true as const : undefined; // owner 19.11.2026: the voice of the PC that holds the call answers it
    const message = ctx.services.chats.send({
      conversationId, body, attachments, mentions, ...level, ...(talks || relay ? { silent: true } : {}),
      replyTo: optId(o, 'replyTo'), model, effort: optOneOf(o, 'effort', [...EFFORTS, 'auto']), ...(pin ? { pin } : {}),
      clientId: optText(o, 'clientId', { max: 100 }), authorId: HUMAN_ID, authorKind: 'human',
      speech: o.speech as SendMessageInput['speech'], // SM8: validated and capped by the chat service (chat/speech-meta.ts)
      marks: o.marks as SendMessageInput['marks'], // B-082: checked against the body there too (cleanMarks)
      meta: { ...(secrets.length ? { secrets } : {}), ...(ultra ? { ultra: true as const } : {}), ...(callId && device ? { call: { id: callId, participant: `device:${device.key}`, name: device.name, ...(relay ? { relay } : {}) } } : {}) },
    });
    talks?.heard(message);
    // Writing joins the room (chat service); a room an agent hid moves to the main list too (C1).
    if (chat.settings.hiddenFromList && !chat.settings.system) ctx.services.chats.update(conversationId, { settings: { hiddenFromList: undefined } }, HUMAN_ID);
    rememberConversation(ctx, conversationId);
    return message;
  }, CHAT);
  addKeysSaved(table, 'messages.edit', (params, ctx) => {
    const o = input(params);
    const messageId = id(o);
    const body = text(o, 'body', { max: MAX_BODY, multiline: true });
    checkDeviceMessage(ctx, messageId);
    return ctx.services.chats.edit(messageId, body, HUMAN_ID);
  }, CHAT);
  table.add('messages.delete', (params, ctx) => {
    const messageId = id(input(params));
    checkDeviceMessage(ctx, messageId);
    ctx.services.chats.removeMessage(messageId, HUMAN_ID);
    return { ok: true };
  }, CHAT);
  table.add('messages.stop', async (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    chatOrThrow(ctx.services, conversationId);
    const only = optId(o, 'agentId');
    const agents = runningIn(ctx.services, conversationId, only);
    await Promise.all(agents.map((agentId) => ctx.services.dispatcher.interrupt(agentId, conversationId)));
    // B-057 S13: the person's Stop also ends the splits of this chat – of an agent whose only work here is splits, too.
    // Only here: dispatcher.interrupt never stops splits (a task's end or take-back must not end unrelated groups).
    try { ctx.services.splits?.stop({ conversationId, ...(only ? { agentId: only } : {}) }, HUMAN_ID); } catch (error) {
      ctx.services.log.warn('stopping the splits of a chat failed', { conversationId, error: String(error) });
    }
    return { ok: true };
  }, CHAT);
  table.add('messages.retry', (params, ctx) => {
    const messageId = id(input(params), 'messageId');
    const { chats, org, wakes } = ctx.services;
    const message = chats.message(messageId) ?? notFound('Message', { messageId });
    if (message.authorKind !== 'agent') bad('messageId', 'an answer written by an agent');
    if (message.state !== 'failed' && message.state !== 'stopped') {
      throw new WorkforceError('conflict', 'Only failed or stopped answers can be retried.', { details: { messageId, state: message.state } });
    }
    const agent = org.get(message.authorId);
    if (!agent || agent.archivedAt !== undefined) throw new WorkforceError('conflict', 'This agent is archived.', { details: { agentId: message.authorId } });
    if (!chats.members(message.conversationId).some((member) => member.memberId === agent.id)) {
      throw new WorkforceError('conflict', 'This agent is no longer in the chat.', { details: { agentId: agent.id } });
    }
    const why = message.state === 'failed' ? `failed${message.meta.error ? ` (${excerpt(String(message.meta.error), 160)})` : ''}` : 'was stopped';
    // A turn the human asked for ('manual'): on the stopped run's task it continues that task (a pause ends).
    const taskId = message.taskId ?? (message.runId ? ctx.services.runs.get(message.runId)?.taskId : undefined);
    wakes.wake({
      agentId: agent.id, reason: 'manual', conversationId: message.conversationId, taskId,
      note: `${ctx.services.settings.get().profile.name.trim() || 'The person'} asked me to try again: my answer ${why}.`, coalesceKey: `retry:${messageId}`,
    });
    return { ok: true };
  }, CHAT);
  table.add('messages.schedule', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'body', 'spec', 'mentions', 'priority', 'ultra']);
    const conversationId = id(o, 'conversationId');
    chatOrThrow(ctx.services, conversationId);
    const body = text(o, 'body', { max: MAX_BODY, multiline: true });
    const mentions = optIds(o, 'mentions', 50);
    const spec = optObj(o, 'spec') ?? bad('spec', 'a schedule spec ({at} | {cron} | {everyMs} | {times})');
    const post = scheduledPost(body, { mentions, priority: optOneOf(o, 'priority', POST_PRIORITIES), ultra: optBool(o, 'ultra') === true }); // B-050 K4: 'silent' too; B-057: Ultra suggested
    // The scheduler validates the spec (times, cron syntax, limits).
    return ctx.services.scheduler.create({ ownerId: HUMAN_ID, conversationId, spec: spec as ScheduleSpec, ...post });
  }, CHAT);

  registerExternalAgents(table); // C8: chats.connectExternal ('manage', secure) and the external agents' variants
  registerBlocks(table);
}
