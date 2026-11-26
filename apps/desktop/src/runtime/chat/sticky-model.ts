// Per-chat settings rules split from chat/service.ts (MM6, to make room there): the model/effort
// choice sent with a human message, the model tag it carries, and the settings cleaner (empty maps
// and undefined keys dropped).
// - Choice (B-050 K6): a message's `model` is a recommendation – it becomes the addressed agents'
//   soft hint (settings.modelHints) and drops their pin; only `pin: true` pins it (settings.models,
//   the hint goes); 'auto' clears pin and hint. `effort` sets settings.efforts ('auto' clears). The
//   addressed agents: the message's @mentioned agents (a reply mentions the agent replied to), else
//   the lead, else the first agent – as the composer's chip (ui/chat/composer/target.ts).
// - Tag (K6): a human text message carries the first addressed agent's current choice as
//   meta.modelHint – the pin ({pinned: true}), else the hint, with the chat's effort; Auto = no tag.
// SG: a pin never revives an old hint and a hint never keeps an old pin.
// 26.11.2026 (owner): the composer's pick – model, effort, temperature – applies to ONE message. ChatService.send stamps it
// on the person's line (meta.modelHint: the agent reads it there, context/render.ts suggestionTag) and takes it off the chat
// (withoutChoice), so the chip shows "Auto" again; the pick never changes an agent's own model (that is its agent page).
// Owns: those rules. Never: writes rows (the chat service persists the conversation and the message).

import type { Conversation, ConversationSettings, Member, Message, ModelTag, SendMessageInput } from '../../shared/model/chat.ts';

/** The agents a message addresses (see the header), first the one its tag is for; [] in a chat without agents. */
export function addressedAgents(message: Pick<Message, 'mentions'>, members: readonly Member[]): string[] {
  const agents = members.filter(m => m.kind === 'agent' && m.leftAt === undefined).map(m => m.memberId);
  const targets = message.mentions.filter(id => agents.includes(id));
  if (targets.length) return targets;
  const lead = members.find(m => m.role === 'lead' && m.kind === 'agent' && m.leftAt === undefined)?.memberId ?? agents[0];
  return lead ? [lead] : [];
}

/**
 * K6: the agent's current choice in the chat as a message tag – the pin, else the hint, with the effort and temperature
 * picked beside it; undefined in Auto (0.3.21: an effort or a temperature alone is a tag too – the pick is gone from the chat after
 * the message, so the line is where the agent finds it).
 */
export function modelTag(settings: ConversationSettings, agentId: string | undefined): ModelTag | undefined {
  if (!agentId) return undefined;
  const pin = settings.models?.[agentId];
  const hint = settings.modelHints?.[agentId];
  const modelId = pin && pin !== 'auto' ? pin : hint && hint !== 'auto' ? hint : undefined;
  const effort = settings.efforts?.[agentId];
  const temperature = settings.temperatures?.[agentId];
  const warmth = typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {};
  const tag: ModelTag = {
    ...(modelId ? { modelId } : {}), ...(effort && effort !== 'auto' ? { effort } : {}), ...warmth,
    ...(modelId && modelId === pin ? { pinned: true } : {}),
  };
  return Object.keys(tag).length ? tag : undefined;
}

/**
 * 26.11.2026 (owner: a model picked in the composer applies to the next message only, then the chip is "Auto" again): the
 * settings without these agents' pick – model, pin, effort and temperature – and their stamp. `changed` says whether anything went.
 */
export function withoutChoice(settings: ConversationSettings, agentIds: readonly string[]): { settings: ConversationSettings; changed: boolean } {
  let changed = false;
  const out: ConversationSettings = { ...settings };
  for (const key of ['models', 'modelHints', 'efforts', 'temperatures', 'suggestedAt'] as const) {
    const map = settings[key] as Record<string, unknown> | undefined;
    if (!map || !agentIds.some((id) => id in map)) continue;
    const rest = { ...map };
    for (const id of agentIds) delete rest[id];
    (out as Record<string, unknown>)[key] = rest;
    changed = true;
  }
  return { settings: changed ? cleanSettings(out) : settings, changed };
}

/** Applies the input's model/effort to `conversation.settings`; false when it carried neither. */
export function applyStickyModel(conversation: Conversation, message: Message, input: Pick<SendMessageInput, 'model' | 'effort' | 'pin'>, members: Member[]): boolean {
  if (input.model === undefined && input.effort === undefined) return false;
  const models = { ...(conversation.settings.models ?? {}) };
  const hints = { ...(conversation.settings.modelHints ?? {}) };
  const efforts = { ...(conversation.settings.efforts ?? {}) };
  for (const id of addressedAgents(message, members)) {
    if (input.model !== undefined) {
      delete models[id];
      delete hints[id];
      if (input.model !== 'auto') (input.pin === true ? models : hints)[id] = input.model;
    }
    if (input.effort !== undefined) { if (input.effort === 'auto') delete efforts[id]; else efforts[id] = input.effort; }
  }
  conversation.settings = cleanSettings({ ...conversation.settings, models, modelHints: hints, efforts });
  conversation.updatedAt = message.createdAt;
  return true;
}

export function cleanSettings(settings: ConversationSettings): ConversationSettings {
  const out: ConversationSettings = { ...settings };
  if (out.models && !Object.keys(out.models).length) delete out.models;
  if (out.efforts && !Object.keys(out.efforts).length) delete out.efforts;
  if (out.modelHints && !Object.keys(out.modelHints).length) delete out.modelHints;
  if (out.temperatures && !Object.keys(out.temperatures).length) delete out.temperatures;
  if (out.suggestedAt && !Object.keys(out.suggestedAt).length) delete out.suggestedAt;
  for (const key of Object.keys(out) as Array<keyof ConversationSettings>) if (out[key] === undefined) delete out[key];
  return out;
}
