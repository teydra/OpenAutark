// The composer's outgoing lines, separate from the canonical transcript. The request's clientId
// matches the stored message, even if the server rewrote the text (e.g. saved pasted keys).
import { batch, signal } from '@preact/signals';
import type { ParamsOf } from '../../shared/api/methods.ts';
import type { Attachment, Message } from '../../shared/model/chat.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { putMessage } from '../lib/store.ts';

export interface PendingSend {
  clientId: string;
  conversationId: string;
  body: string;
  attachments: readonly Attachment[];
  createdAt: number;
  state: 'transcribing' | 'sending' | 'failed';
  preview?: () => string;
  error?: string;
}

export const pendingSends = signal<readonly PendingSend[]>([]);

type Retry = { params: ParamsOf<'messages.send'>; deviceId?: string; remote: boolean };
const retries = new Map<string, Retry>();

export function addPending(line: Omit<PendingSend, 'createdAt'>): void {
  const previous = pendingSends.peek().find((item) => item.clientId === line.clientId);
  const entry = { ...line, createdAt: previous?.createdAt ?? Date.now() };
  pendingSends.value = previous
    ? pendingSends.peek().map((item) => item === previous ? entry : item)
    : [...pendingSends.peek(), entry];
}

export function updatePending(clientId: string, change: Partial<Pick<PendingSend, 'state' | 'error'>>): void {
  const list = pendingSends.peek();
  if (list.some((item) => item.clientId === clientId)) {
    pendingSends.value = list.map((item) => item.clientId === clientId ? { ...item, ...change } : item);
  }
}

export function removePending(clientId: string): void {
  retries.delete(clientId);
  const list = pendingSends.peek();
  if (list.some((item) => item.clientId === clientId)) pendingSends.value = list.filter((item) => item.clientId !== clientId);
}

export function resolvePending(clientId: string, message: Message): void {
  batch(() => { putMessage(message); removePending(clientId); });
}

export function failPending(clientId: string, error: string, retry: Retry): void {
  retries.set(clientId, retry);
  updatePending(clientId, { state: 'failed', error });
}

export function beginRetry(clientId: string): Retry | undefined {
  const retry = retries.get(clientId);
  if (!retry || !pendingSends.peek().some((line) => line.clientId === clientId && line.state === 'failed')) return;
  updatePending(clientId, { state: 'sending', error: undefined });
  return retry;
}

export function confirmedSend(list: readonly Message[], clientId: string, conversationId: string): Message | undefined {
  return list.find((m) => m.conversationId === conversationId && m.clientId === clientId
    && m.authorKind === 'human' && m.authorId === HUMAN_ID);
}

export function unsentLines(pending: readonly PendingSend[], list: readonly Message[]): PendingSend[] {
  return pending.filter((line) => line.state === 'transcribing' || !confirmedSend(list, line.clientId, line.conversationId));
}
