// A stored own message has reached the connected PC. Only show a second tick if an addressed
// agent is homed here. Chat cursors can advance on sync or on a later turn; they are not proof
// that this line reached a remote PC or was in an individual model call.
// Owns: interpreting confirmed messages for the UI. Never: estimates remote delivery.
import type { Member, Message } from '../../shared/model/chat.ts';
import { HUMAN_ID } from '../../shared/ids.ts';

export type Receipt = 'sent' | 'delivered';

export function receiptFor(message: Message, members: readonly Member[], here: (agentId: string) => boolean): Receipt | undefined {
  if (message.authorId !== HUMAN_ID || message.authorKind !== 'human' || message.state !== 'final'
    || (message.kind !== 'text' && message.kind !== 'answer')) return undefined;
  const recipients = members.filter((member) => member.leftAt === undefined && member.memberId !== HUMAN_ID);
  const named = recipients.filter((member) => message.mentions.includes(member.memberId));
  const addressed = message.mentions.length ? named : recipients;
  // In a group the final responder may not be known. Count only if every possible recipient's PC is here.
  return addressed.length && addressed.every((member) => member.kind === 'agent' && here(member.memberId)) ? 'delivered' : 'sent';
}
