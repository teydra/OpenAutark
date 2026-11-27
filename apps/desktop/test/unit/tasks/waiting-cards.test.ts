// P7 "Waiting on you": four waits on one question are one card, one answer frees all four (each thread holds it, each
// owner hears it once), "Later" sets the follow-up (tomorrow 09:00 local) and the card rests until then, and an ask to
// the person dropped without their word asks back instead of vanishing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { CARDS_SHOWN, cardAsks, questionOf, waitingCards } from '../../../src/shared/model/waiting-cards.ts';
import { addDays, wallOf, wallTime } from '../../../src/shared/text/when.ts';
import { dayZone } from '../../../src/runtime/day/clock.ts';
import { center, company } from '../task-center/fixture.ts';

function setup() {
  const h = center();
  company(h);
  let now = h.s.clock.now();
  h.s.clock.now = () => now;
  const zone = dayZone(h.s);
  const tomorrow = wallTime(addDays(wallOf(now, zone).date, 1), 540, zone);
  const wait = (title: string, owner: string, why: string) => {
    const task = h.tasks.create({ title, createdBy: owner, assigneeId: owner });
    h.tasks.update(task.id, { status: 'waiting', waitingOn: { on: 'who', who: HUMAN_ID, why } }, owner);
    return task.id;
  };
  const all = () => [...h.tasks.list({ status: ['open', 'waiting'] })];
  return { ...h, tomorrow, wait, all, now: () => now, advance: (at: number) => { now = at; } };
}

const FOUR: Array<[string, string, string]> = [
  ['Build the installer', 'ag_tom', 'Stanislaus: Is the signing stick ready?'],
  ['Sign the package', 'ag_tom', 'Is the signing stick ready? Then I sign.'],
  ['Publish the release', 'ag_lea', 'is the signing stick ready'],
  ['Announce it', 'ag_mara', 'Stanislaus – Is the signing stick ready?'],
];

test('four tasks waiting on the same question are one card with who asks, since when and how many', () => {
  const h = setup();
  const ids = FOUR.map(([title, owner, why]) => h.wait(title, owner, why));
  h.wait('Pick a font', 'ag_lea', 'Which font do you like?');
  const cards = waitingCards(h.all(), h.now());
  assert.equal(cards.length, 2);
  const [card] = cards;
  assert.equal(card.question, 'Is the signing stick ready?');
  assert.deepEqual([...card.waiting].sort(), [...ids].sort());
  assert.deepEqual(new Set(card.from), new Set(['ag_tom', 'ag_lea', 'ag_mara']));
  assert.equal(card.kind, 'ready');
  assert.ok(card.since <= h.now());
  assert.equal(CARDS_SHOWN, 3);
  assert.equal(questionOf('Tom: please check the copy. It is long.'), 'Please check the copy.');
});

test('four tasks waiting on one ask to the person are one card about that ask, and For you leaves the ask to it', () => {
  const h = setup();
  const ask = h.tasks.create({ title: 'Approve the release notes', assigneeKind: 'human', createdBy: 'ag_tom', widget: { type: 'approve', text: 'Approve the release notes?' } as never });
  const ids = ['Build', 'Sign', 'Publish', 'Announce'].map((title, i) => {
    const owner = ['ag_tom', 'ag_tom', 'ag_lea', 'ag_mara'][i];
    const task = h.tasks.create({ title, createdBy: owner, assigneeId: owner, dependsOn: [ask.id] });
    h.tasks.update(task.id, { status: 'waiting', waitingOn: { on: 'task', ids: [ask.id], why: `${title} waits for the approval` } }, owner);
    return task.id;
  });
  const cards = waitingCards(h.all(), h.now());
  assert.equal(cards.length, 1);
  assert.equal(cards[0].askId, ask.id);
  assert.equal(cards[0].kind, 'accept');
  assert.equal(cards[0].waiting.length, 4);
  assert.deepEqual(cards[0].taskIds, [ask.id, ...cards[0].waiting]);
  assert.ok(ids.every((id) => cards[0].waiting.includes(id)));
  assert.deepEqual([...cardAsks(cards)], [ask.id]);
});

test('one answer frees all four: each thread holds the words, each agent owner hears it once', () => {
  const h = setup();
  const ids = FOUR.map(([title, owner, why]) => h.wait(title, owner, why));
  h.db.run('DELETE FROM wakes');
  const [card] = waitingCards(h.all(), h.now());
  const views = h.tasks.answerCard({ ids: card.taskIds, reply: 'Yes, it is plugged in.' }, HUMAN_ID);
  assert.equal(views.length, 4);
  for (const id of ids) {
    const task = h.tasks.get(id)!;
    assert.equal(task.status, 'open', id);
    assert.equal(task.waitingOn, undefined);
    const lines = h.db.all<{ body: string; author_id: string }>('SELECT body, author_id FROM messages WHERE conversation_id = ?', [id]);
    assert.ok(lines.some((line) => line.author_id === HUMAN_ID && line.body === 'Yes, it is plugged in.'), `the answer in ${id}'s thread`);
  }
  const told = h.wakeRows().filter((row) => String(row.note).includes('Yes, it is plugged in.'));
  assert.deepEqual(told.map((row) => row.agent_id).sort(), ['ag_lea', 'ag_mara', 'ag_tom']);
  assert.match(String(told.find((row) => row.agent_id === 'ag_tom')?.note), /My 2 tasks/);
  assert.equal(waitingCards(h.all(), h.now()).length, 0);
});

test('answering a card about an ask answers the ask with its widget and frees the work that waited on it', () => {
  const h = setup();
  const ask = h.tasks.create({ title: 'Approve the release notes', assigneeKind: 'human', createdBy: 'ag_tom', widget: { type: 'approve', text: 'Approve?' } as never });
  const waiter = h.tasks.create({ title: 'Publish', createdBy: 'ag_lea', assigneeId: 'ag_lea' });
  h.tasks.update(waiter.id, { status: 'waiting', waitingOn: { on: 'task', ids: [ask.id], why: 'Waits for the approval' } }, 'ag_lea');
  const [card] = waitingCards(h.all(), h.now());
  h.tasks.answerCard({ ids: card.taskIds }, HUMAN_ID);
  assert.equal(h.tasks.get(ask.id)?.status, 'done');
  assert.deepEqual(h.tasks.get(ask.id)?.result?.answer, { approved: true });
  assert.equal(h.tasks.get(waiter.id)?.status, 'open');
});

test('a stale or mixed card cannot answer or move a different wait', () => {
  const h = setup();
  const one = h.wait('Build', 'ag_tom', 'Is the signing stick ready?');
  const two = h.wait('Publish', 'ag_lea', 'Is the approval in?');
  assert.throws(() => h.tasks.answerCard({ ids: [one, two] }, HUMAN_ID), /This card changed/);
  assert.throws(() => h.tasks.laterCard([one, two], h.tomorrow, HUMAN_ID), /This card changed/);
  assert.equal(h.tasks.get(one)?.status, 'waiting');
  assert.equal(h.tasks.get(two)?.waitingOn?.later, undefined);
});

test('an answer leaves independent task blockers in place', () => {
  const h = setup();
  const ask = h.tasks.create({ title: 'Ready?', assigneeKind: 'human', createdBy: 'ag_tom' });
  const other = h.tasks.create({ title: 'Build', createdBy: 'ag_lea', assigneeId: 'ag_lea' });
  const task = h.tasks.create({ title: 'Publish', createdBy: 'ag_mara', assigneeId: 'ag_mara', dependsOn: [ask.id, other.id] });
  const [card] = waitingCards(h.all(), h.now());
  h.tasks.answerCard({ ids: card.taskIds }, HUMAN_ID);
  assert.equal(h.tasks.get(task.id)?.status, 'waiting');
  assert.deepEqual(h.tasks.get(task.id)?.waitingOn?.ids, [other.id]);
});

test('"Later" sets the follow-up to tomorrow 09:00, the card rests until then and comes back', () => {
  const h = setup();
  const ids = FOUR.map(([title, owner, why]) => h.wait(title, owner, why));
  const [card] = waitingCards(h.all(), h.now());
  h.tasks.laterCard(card.taskIds, h.tomorrow, HUMAN_ID);
  for (const id of ids) {
    const wait = h.tasks.get(id)?.waitingOn;
    assert.equal(h.tasks.get(id)?.status, 'waiting');
    assert.equal(wait?.until, h.tomorrow);
    assert.equal(wait?.later, true);
    assert.equal(wait?.who, HUMAN_ID, 'the question stays');
  }
  const resting = waitingCards(h.all(), h.now());
  assert.equal(resting.length, 1, 'it does not vanish');
  assert.equal(resting[0].later, true);
  assert.equal(resting[0].until, h.tomorrow);
  h.advance(h.tomorrow + 1);
  assert.equal(waitingCards(h.all(), h.now())[0].later, false);
});

test('an ask to the person dropped by an agent asks back its maker and its quest owner', async () => {
  const h = setup();
  const quest = h.tasks.create({ kind: 'quest', title: 'Release 0.3.22', createdBy: 'ag_mara', assigneeId: 'ag_mara' });
  const ask = h.tasks.create({ title: 'Plug in the signing stick', assigneeKind: 'human', createdBy: 'ag_tom', parentId: quest.id });
  h.db.run('DELETE FROM wakes');
  const dropped = await h.call('ag_tom', 'tasks.update', { id: ask.id, status: 'dropped', result: 'Signing moved to next week' });
  assert.equal(dropped.error, false, dropped.text);
  assert.match(String(dropped.data?.askBack), /was dropped without their answer/);
  const back = h.wakeRows().filter((row) => String(row.note).includes('was dropped'));
  assert.deepEqual(back.map((row) => row.agent_id), ['ag_mara'], 'the quest owner; the dropper reads it in its tool answer');
  assert.equal(back[0].task_id, quest.id);

  const other = h.tasks.create({ title: 'Choose the icon', assigneeKind: 'human', createdBy: 'ag_tom' });
  h.db.run('DELETE FROM wakes');
  h.tasks.finish(other.id, { status: 'dropped', summary: 'Not needed' }, 'ag_mara');
  assert.deepEqual(h.wakeRows().filter((row) => String(row.note).includes('was dropped')).map((row) => row.agent_id), ['ag_tom']);

  const mine = h.tasks.create({ title: 'Call the venue', assigneeKind: 'human', createdBy: 'ag_tom' });
  h.db.run('DELETE FROM wakes');
  h.tasks.finish(mine.id, { status: 'dropped', summary: 'Cannot do it' }, HUMAN_ID);
  assert.equal(h.wakeRows().filter((row) => String(row.note).includes('was dropped')).length, 0, "the person's own decline is no silent drop");
});
