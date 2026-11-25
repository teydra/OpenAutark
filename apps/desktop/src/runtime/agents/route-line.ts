// The quiet switch line of one turn (RT5; B-083: with the agent's name and the turn's temperature), for agents/turn.ts announceSwitch.
// 17.11.2026 (the model settles): a turn on another model than my last one is rare now – a boundary, a model that cannot
// run, my own model.set with now – and each one gets its line with the route's own why ("requested by me", "my start
// model", "executing runs on the strong tier's best value", "<model> cannot run now – …"). An effort alone moves on any
// turn; the chat gets a line for one somebody asked for – my own model.set, my task's from its giver, or the fixed effort
// set with a start model since my last turn began (ModelPolicy.pinBy.at) – and for my own temperature. The effort my
// subconscious sets before a turn and the lift a person's line gives it leave no line (owner 14.11.2026: a stable UI where
// nothing shifts): the live bar shows what the turn runs on (ui/chat/LiveBar.tsx: model · effort · temperature) and the
// run's route says why (the agent's log, ui/team/AgentLog.tsx).
//   "<Agent> → <model> · <effort>[ · temperature T] – <why>" (switch-line.ts)
// postRunLine posts one quiet line of a run in its chat (the agent's own, meta.fromRun) – turn.ts, and turn-attempt.ts for
// a switch inside the running turn (B-083).
// Owns: which switch gets a line and posting a run's line. Never: routes or reads state.

import type { RuntimeServices } from '../contracts.ts';
import type { Effort, RouteDecision } from '../../shared/model/providers.ts';
import type { StatusLine } from '../../shared/model/chat.ts';
import { PIN_TEXT } from '../routing/pins.ts';
import { BY_REQUEST } from '../routing/previous.ts';
import { REQUESTED_WHY, reasonParts, subconsciousWhy, switchText, switchWhy } from './switch-line.ts';

export interface RouteLine { text: string; details: Record<string, unknown> }

/** What my last done turn ran on (turn.ts switchedFrom; B-083: with its temperature), and when it began. */
export interface SwitchFrom { modelId: string; effort: Effort; temperature?: number; at?: number }

/** Whose line it is, how the turn's temperature reaches its model (sent), whether that temperature is my own request, and when my start model was set (ModelPolicy.pinBy.at). */
export interface LineOf { agent: string; sent?: boolean; ownTemperature?: boolean; pinAt?: number }

/** The line for a changed model or requested effort, and for an unavailable pin even when there was no previous turn. */
export function routeLine(route: RouteDecision, modelName: string, from: SwitchFrom | undefined, of: LineOf): RouteLine | undefined {
  const reasons = reasonParts(route.reason);
  const unavailablePin = reasons.find((reason) => reason.startsWith('pinned model unavailable'));
  const newPin = of.pinAt !== undefined && from?.at !== undefined && of.pinAt > from.at;
  const explainPin = !from || newPin ? unavailablePin : undefined;
  if (!from && !explainPin) return undefined;
  const model = from !== undefined && from.modelId !== route.modelId;
  const mine = route.by === BY_REQUEST && !subconsciousWhy(route.reason); // my own model.set or my task's
  const started = newPin && reasons.includes(PIN_TEXT.agent);
  const asked = model || (from !== undefined && from.effort !== route.effort && (mine || started));
  const warmth = of.ownTemperature === true && from?.temperature !== route.temperature;
  if (!asked && !warmth && !explainPin) return undefined;
  const to = { modelName, effort: route.effort, temperature: route.temperature, sent: of.sent };
  return {
    text: switchText(of.agent, to, explainPin || (asked && from ? switchWhy(route, from) : REQUESTED_WHY)),
    details: {
      ...(from ? { from: from.modelId } : {}), to: route.modelId, effort: route.effort, reason: route.reason, by: route.by,
      ...(route.temperature !== undefined ? { temperature: route.temperature, temperatureSent: of.sent === true } : {}),
    },
  };
}

/** A quiet line of a run in its chat (meta.fromRun: the UI may fold it into the run's steps); none without a chat. Never throws. */
export function postRunLine(services: Pick<RuntimeServices, 'chats' | 'log'>, run: { agentId: string; runId: string; conversationId?: string; taskId?: string }, type: StatusLine['type'], text: string, details: Record<string, unknown>): void {
  if (!run.conversationId) return;
  try { services.chats.status(run.conversationId, { type, text, details }, { authorId: run.agentId, taskId: run.taskId, fromRun: run.runId }); } catch (error) {
    services.log.warn('status line failed', { error: String(error) });
  }
}
