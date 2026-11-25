// 25.11.2026 (ORENDA, company-4: 16:31–16:42 the agents Paula, Hildegard, Rocco, Franz, Martin and Lena got the same "New
// standard SYSTEM.md" wake again and again, their SYSTEM.md was rewritten, the model quota ran out). The PC "TB Kassiopeia"
// ran 0.3.9: its standard.ts compares an agent's comment with its OWN release (rev 4625c7cb), writes it back and wakes the
// agent (origin 'standard'), handing the wake to the agent's home PC at every link-up until it is confirmed. 0.3.18 had lost
// the guard in rows.ts wakeHere that dropped such wakes (and it never covered 'standard'). Now: a standard or prompt wake from
// another PC is dropped on arrival, and a synced agents row from an older release never puts its older comment over this PC's
// (org/standard.ts keepNewerStandard) – so neither the wake nor the rewrite comes back while an older PC stays in the company.
// Owns: these assertions only. Never: a real mesh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agent } from '../chat/harness.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { OLDER_REVS, keepNewerStandard, splitStandard, standardOf, withStandard } from '../../../src/runtime/org/standard.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { RESOURCES } from '../store/helpers.ts';
import { link, makePc, Net, settle } from './sync-net.ts';

const NEW = { kind: 'agent', rev: '57276f2b', text: 'The standard of this release.' } as const; // 0.3.18 / 0.3.19
const OLD = { kind: 'agent', rev: '4625c7cb', text: 'The standard of 0.3.9.' } as const; // 0.3.9

test('a standard wake from an older PC is not stored for an agent at home here; an ordinary wake is', async () => {
  const net = new Net();
  const old = makePc(net, 'dev_old'); // the 0.3.9 PC
  const server = makePc(net, 'dev_server');
  link(old, server);
  for (const pc of [old, server]) pc.h.org.add(agent('ag_paula', 'Paula', { deviceId: 'dev_server' }));

  old.h.wakes.wake({ agentId: 'ag_paula', reason: 'review', coalesceKey: 'standard:ag_paula', origin: { source: 'standard', label: 'New standard SYSTEM.md' }, note: 'The team\'s standard SYSTEM.md changed with this version of the app.' });
  await settle();
  assert.equal(server.h.wakes.pending('ag_paula'), 0, 'nothing wakes the agent for a standard the older PC compared');

  old.h.wakes.wake({ agentId: 'ag_paula', reason: 'review', coalesceKey: 'x', origin: { source: 'system-prompt:identity', label: 'System prompt update: identity' }, note: 'review' });
  await settle();
  assert.equal(server.h.wakes.pending('ag_paula'), 0, 'nor for a prompt it compared (B-080)');

  old.h.wakes.wake({ agentId: 'ag_paula', reason: 'review', coalesceKey: 'y', note: 'Please look at this' });
  await settle();
  assert.equal(server.h.wakes.pending('ag_paula'), 1, 'a wake that is real news still arrives');
});

test('a row from an older PC does not put its older standard comment over this PC\'s – its real edit arrives', async () => {
  const net = new Net();
  const old = makePc(net, 'dev_old');
  const server = makePc(net, 'dev_server');
  link(old, server);
  const base = '# How I work\nI am Paula.';
  const now = server.h.clock.now();
  const saved = (pc: typeof old, instructions: string) => { const one = agent('ag_paula', 'Paula', { instructions, createdAt: now - 20_000 }); new AgentRepo(pc.h.db).save(one); pc.h.org.add(one); return one; };
  const text = (pc: typeof old) => pc.h.db.get<{ instructions: string }>('SELECT instructions FROM agents WHERE id = ?', ['ag_paula'])!.instructions;
  saved(server, withStandard(base, NEW));
  const paula = saved(old, withStandard(base, OLD)); // the 0.3.9 PC keeps its own standard and says so in the row

  assert.ok(await old.sync.catchUp('dev_server', undefined));
  await settle();
  assert.equal(splitStandard(text(server)).rev, NEW.rev, 'this PC keeps its comment');
  assert.equal(text(server), withStandard(base, NEW));

  // an edit of the own text above the comment travels with the older comment and lands
  old.h.clock.advance(1_000);
  old.h.db.run('UPDATE agents SET instructions = ?, updated_at = ? WHERE id = ?', [withStandard(`${base}\nI check sources.`, OLD), old.h.clock.now(), 'ag_paula']);
  old.h.bus.emit('agent.upserted', old.h.org.get(paula.id)!);
  await settle();
  const got = text(server);
  assert.equal(splitStandard(got).own, `${base}\nI check sources.`);
  assert.equal(splitStandard(got).rev, NEW.rev);
  assert.equal(got.match(/<!-- Autark standard:/g)?.length, 1, 'one comment, not two');
});

test('keepNewerStandard: only a known older revision loses; an unknown one (possibly newer), the same one and an agent at home elsewhere are taken as they come', () => {
  const net = new Net();
  const pc = makePc(net, 'dev_server');
  link(makePc(net, 'dev_other'), pc); // a CEO PC of mine, where ag_away is at home
  pc.h.org.add(agent('ag_here', 'Here'));
  pc.h.org.add(agent('ag_away', 'Away', { deviceId: 'dev_other' }));
  const s = pc.h.services;
  const away = s;
  const local = withStandard('mine', NEW);
  const older = withStandard('theirs', OLD);
  const unknown = withStandard('theirs', { ...NEW, rev: 'ffffffff' });

  assert.equal(keepNewerStandard(s, 'ag_here', local, older), `theirs\n\n${local.slice(local.indexOf('<!--'))}`);
  assert.equal(keepNewerStandard(s, 'ag_here', local, unknown), unknown, 'a revision this release does not know may be newer');
  assert.equal(keepNewerStandard(s, 'ag_here', local, local), local);
  assert.equal(keepNewerStandard(s, 'ag_here', older, withStandard('theirs', { ...OLD, rev: '9f832c5f' })), withStandard('theirs', { ...OLD, rev: '9f832c5f' }), 'two older ones: the incoming one is taken');
  assert.equal(keepNewerStandard(s, 'ag_here', 'no comment', older), older);
  assert.equal(keepNewerStandard(s, 'ag_here', local, 'no comment'), 'no comment');
  assert.equal(keepNewerStandard(away, 'ag_away', local, older), older,'the agent\'s home PC keeps its comment, not this one');
});

test('the list of older revisions never holds a standard this release ships', () => {
  const shipped = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  for (const kind of ['agent', 'manager'] as const) {
    const { rev } = standardOf(shipped, kind, {});
    assert.ok(!OLDER_REVS.has(rev), `${kind} ${rev} is the shipped standard – it cannot be an older one`);
  }
  assert.ok(OLDER_REVS.has('4625c7cb'), '0.3.9\'s agent standard – the one the ORENDA PC wrote back');
});
