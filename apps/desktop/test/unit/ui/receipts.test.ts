// Honest send receipts from existing data. No live-run or cursor guess for remote delivery/read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Member, Message } from '../../../src/shared/model/chat.ts';
import { receiptFor } from '../../../src/ui/chat/receipts.ts';

const member = (memberId: string, extras: Partial<Member> = {}): Member =>
  ({ conversationId: 'ch_1', memberId, kind: 'agent', role: 'member', readSeq: 100, joinedAt: 0, ...extras });
const message: Message = {
  id: 'msg_1', conversationId: 'ch_1', authorId: 'human', authorKind: 'human', body: 'hello', kind: 'text',
  state: 'final', priority: 'normal', silent: false, meta: {}, createdAt: 1, seq: 5, mentions: [], attachments: [],
};
const here = (id: string) => id === 'ag_here';

test('one tick until we know the message is on an addressed agent’s PC', () => {
  assert.equal(receiptFor(message, [member('ag_far'), member('person', { kind: 'human' })], here), 'sent');
  assert.equal(receiptFor(message, [member('ag_here')], here), 'delivered');
});

test('two ticks are not granted for an unrelated or former local agent, or for other authors', () => {
  const group = [member('ag_far'), member('ag_here')];
  assert.equal(receiptFor(message, group, here), 'sent', 'a local group member is not necessarily the recipient');
  assert.equal(receiptFor({ ...message, mentions: ['ag_here'] }, group, here), 'delivered');
  assert.equal(receiptFor({ ...message, mentions: ['ag_far'] }, group, here), 'sent');
  assert.equal(receiptFor(message, [member('ag_here', { leftAt: 2 })], here), 'sent');
  assert.equal(receiptFor({ ...message, authorKind: 'agent', authorId: 'ag_here' }, group, here), undefined);
});
