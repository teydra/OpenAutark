// Owner 18.11.2026: the floating to-do button (src/main/float-bar.ts, float-bar-window.ts readAction) with a fake window
// and a fake RPC: the dot, panel and tab stay inside the work area; opening takes a screenshot; Send uploads every shot
// and posts one quick task with them; a failed post keeps the words, the shots and the clientId (a retry never makes a
// second task); Call opens the picked agent's 1:1 with its call asked for, a task without an agent opens the task;
// dictation adds the heard words; the page's JSON is checked before it becomes an action. Owner 19.11.2026: one
// automatic shot per draft (close + open shows the draft as it was), removing a shot removes exactly that one, the
// bubble hides and comes back (kept in float-bar.json; the shortcut opens it), and Call starts the call in the app's page
// without showing the window – the pill shows it and ends it.
// Owns: these assertions only. Never: Electron or real windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALL_START_MS, FloatBar, type FloatDeps, type FloatMenuItem, type FloatPlace } from '../../../src/main/float-bar.ts';
import { CALL_W, DOT, PANEL_H, PANEL_W, TAB_W, inside, panelAt, tabAt, type FloatLook, type Rect } from '../../../src/main/float-bar-place.ts';
import { readAction } from '../../../src/main/float-bar-window.ts';
import { trayMenu } from '../../../src/main/tray.ts';
import { floatPage } from '../../../src/main/float-bar-page.ts';
import { readFileSync } from 'node:fs';
import type { NavigateRequest } from '../../../src/shared/api/desktop.ts';

const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

function rig(options: { fail?: number; assignee?: { kind: string; id?: string }; kept?: FloatPlace; heard?: string } = {}) {
  let bounds: Rect = { x: 0, y: 0, width: DOT, height: DOT };
  const looks: FloatLook[] = [];
  const calls: Array<{ method: string; params: any }> = [];
  const opened: NavigateRequest[] = [];
  const called: string[] = [];
  const ended: string[] = [];
  const shown: boolean[] = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  let menu: FloatMenuItem[] = [];
  let visible = true;
  let cursor = { x: 0, y: 0 };
  let saved: FloatPlace | null = null;
  let failures = options.fail ?? 0;
  let shots = 0;
  const deps: FloatDeps = {
    rpc: {
      call: (async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'files.upload') return { id: `f${calls.length}`, name: params.name, mime: params.mime, size: 1, createdAt: 0 };
        if (method === 'voice.transcribe') return { text: options.heard ?? 'fix the header' };
        if (method === 'tasks.quickCreate') {
          if (failures-- > 0) throw new Error('runtime away');
          const who = options.assignee ?? { kind: 'agent', id: 'ag_konrad' };
          return { task: { id: 'task_1', assigneeKind: who.kind, ...(who.id ? { assigneeId: who.id } : {}) } };
        }
        if (method === 'chats.direct') return { id: 'ch_konrad' };
        throw new Error(`unexpected ${method}`);
      }) as FloatDeps['rpc']['call'],
    },
    shot: async () => ({ data: new Uint8Array([++shots]), mime: 'image/jpeg', thumb: `data:image/jpeg;base64,${shots}` }),
    load: () => options.kept ?? null,
    save: (place) => { saved = place; },
    open: (request) => { opened.push(request); },
    call: (id) => { called.push(id); },
    endCall: (id) => { ended.push(id); },
    shownChanged: (on) => { shown.push(on); },
    after: (ms, fn) => { const timer = { ms, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    primaryArea: () => AREA,
    log: () => {},
  };
  const bar = new FloatBar(deps, {
    bounds: () => bounds,
    setBounds: (rect) => { bounds = rect; },
    workArea: () => AREA,
    show: (look) => { looks.push(look); visible = true; },
    hide: () => { visible = false; },
    redraw: () => {},
    menu: (items) => { menu = items; },
    cursor: () => cursor,
  });
  return { bar, setCursor: (x: number, y: number) => { cursor = { x, y }; }, calls, opened, called, ended, shown, timers, looks, bounds: () => bounds, saved: () => saved, visible: () => visible, menu: () => menu };
}

test('placement: the panel opens towards the middle, the tab sits on the nearest edge, all inside the work area', () => {
  const nearRight: Rect = { x: 1900, y: 1020, width: DOT, height: DOT };
  const panel = panelAt(nearRight, AREA);
  assert.deepEqual(panel, { x: AREA.width - PANEL_W, y: AREA.height - PANEL_H, width: PANEL_W, height: PANEL_H });
  const tab = tabAt({ x: 1800, y: 500, width: DOT, height: DOT }, AREA);
  assert.equal(tab.x, AREA.width - TAB_W);
  assert.equal(tabAt({ x: 40, y: 500, width: DOT, height: DOT }, AREA).x, 0);
  assert.deepEqual(inside({ x: -50, y: 5000, width: 10, height: 10 }, AREA), { x: 0, y: 1030, width: 10, height: 10 });
});

test('a first start shows the dot inside the primary work area; a kept tab comes back as a tab', () => {
  const fresh = rig();
  assert.deepEqual(fresh.looks, ['dot']);
  assert.ok(fresh.bounds().x + DOT <= AREA.width && fresh.bounds().width === DOT);
  const kept = rig({ kept: { x: 1800, y: 300, look: 'tab' } });
  assert.deepEqual(kept.looks, ['tab']);
  assert.equal(kept.bounds().width, TAB_W);
});

test('open takes a screenshot; Send uploads it and posts one quick task; the bar goes back to the dot', async () => {
  const { bar, calls, opened } = rig();
  const view = await bar.act({ act: 'open' });
  assert.equal(view.look, 'panel');
  assert.equal(view.shots.length, 1);
  await bar.act({ act: 'shot' });
  const done = await bar.act({ act: 'send', text: 'The header looks broken here' });
  assert.equal(done.look, 'dot');
  assert.equal(done.done, true);
  assert.deepEqual(done.shots, []);
  const post = calls.find((call) => call.method === 'tasks.quickCreate')!;
  assert.equal(post.params.text, 'The header looks broken here');
  assert.deepEqual(post.params.attachments.map((file: any) => file.name), ['screen-1.jpg', 'screen-2.jpg']);
  assert.equal(post.params.target, undefined); // Autark picks the owner
  assert.deepEqual(opened, []); // Send alone opens nothing
});

test('a failed post keeps everything and its clientId; the retry posts the same id', async () => {
  const { bar, calls } = rig({ fail: 1 });
  await bar.act({ act: 'open' });
  const failed = await bar.act({ act: 'send', text: 'do it' });
  assert.equal(failed.look, 'panel');
  assert.match(failed.note ?? '', /Not sent/);
  assert.equal(failed.shots.length, 1);
  await bar.act({ act: 'send', text: 'do it' });
  const ids = calls.filter((call) => call.method === 'tasks.quickCreate').map((call) => call.params.clientId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test('Call starts the picked agent\'s 1:1 call in the page without opening the window; without an agent it opens the task', async () => {
  const agent = rig();
  const done = await agent.bar.act({ act: 'send', text: 'call me about the site', call: true });
  assert.deepEqual(agent.calls.find((call) => call.method === 'chats.direct')?.params, { memberId: 'ag_konrad' });
  assert.deepEqual(agent.called, ['ch_konrad']);
  assert.deepEqual(agent.opened, [], 'the app window stays where it is');
  assert.equal(done.look, 'call');
  assert.equal(done.call?.title, 'Calling…');
  assert.equal(agent.bounds().width, CALL_W);
  const human = rig({ assignee: { kind: 'human' } });
  await human.bar.act({ act: 'send', text: 'remind me', call: true });
  assert.deepEqual(human.opened, [{ taskId: 'task_1' }]);
});

test('nothing to post asks for words; dictation adds the heard words', async () => {
  const { bar, calls } = rig();
  const empty = await bar.act({ act: 'send', text: '  ' });
  assert.match(empty.note ?? '', /what should be done/);
  assert.equal(calls.length, 0);
  await bar.act({ act: 'text', text: 'Please' });
  const heard = await bar.act({ act: 'hear', wav: Buffer.alloc(2000).toString('base64') });
  assert.equal(heard.text, 'Please fix the header');
});

test("the panel's × while a take is heard (unhear): its words go nowhere, the typed text stays", async () => {
  const { bar } = rig();
  await bar.act({ act: 'text', text: 'Please' });
  const heard = bar.act({ act: 'hear', wav: Buffer.alloc(2000).toString('base64') });
  await bar.act({ act: 'unhear' });
  assert.equal((await heard).text, 'Please');
  assert.equal((await bar.act({ act: 'hear', wav: Buffer.alloc(2000).toString('base64') })).text, 'Please fix the header', 'the next take is heard again');
  assert.deepEqual(readAction({ act: 'unhear' }), { act: 'unhear' });
  const page = floatPage();
  assert.match(page, /\$\('close'\)\.onclick = \(\) => \{ if \(!cancelTake\(\)\) act\(\{ act: 'close' \}\); \};/, 'the × cancels a running take first');
  assert.match(page, /if \(rec\) await micToggle\(\); else if \(hearing\) await hearing\.done;/, 'Send takes the words along');
});

test('fold and unfold keep the place; the place is saved', async () => {
  const { bar, bounds, saved } = rig();
  await bar.act({ act: 'fold' });
  assert.equal(bounds().width, TAB_W);
  assert.equal(saved()?.look, 'tab');
  const back = await bar.act({ act: 'unfold' });
  assert.equal(back.look, 'dot');
  assert.equal(bounds().width, DOT);
  assert.equal(saved()?.look, 'dot');
});

const WAV = Buffer.alloc(4000).toString('base64');

test('a hold sends at the release: the hold shot and the heard words, without opening anything', async () => {
  const { bar, calls, looks } = rig();
  await bar.act({ act: 'hold' });
  const done = await bar.act({ act: 'quick', wav: WAV });
  assert.equal(done.look, 'dot');
  assert.equal(done.done, true);
  assert.ok(!looks.includes('panel'));
  const post = calls.find((call) => call.method === 'tasks.quickCreate')!;
  assert.equal(post.params.text, 'fix the header');
  assert.deepEqual(post.params.attachments.map((file: any) => file.name), ['screen-1.jpg']);
});

test('a hold keeps an open draft apart; nothing heard opens the panel with the hold shot', async () => {
  const kept = rig();
  await kept.bar.act({ act: 'open' });
  await kept.bar.act({ act: 'text', text: 'my draft' });
  await kept.bar.act({ act: 'close' });
  await kept.bar.act({ act: 'hold' });
  await kept.bar.act({ act: 'quick', wav: WAV });
  const after = kept.bar.view();
  assert.equal(after.text, 'my draft'); // the panel's draft stays for later
  assert.equal(after.shots.length, 1);
  const silent = rig({ heard: '' });
  await silent.bar.act({ act: 'hold' });
  const opened = await silent.bar.act({ act: 'quick', wav: WAV });
  assert.equal(opened.look, 'panel');
  assert.equal(opened.shots.length, 1);
  assert.match(opened.note ?? '', /Nothing heard/);
  assert.equal(silent.calls.some((call) => call.method === 'tasks.quickCreate'), false);
});

test('a drag keeps the look\'s own size even when the window reports a grown one', async () => {
  const { bar, bounds } = rig();
  await bar.act({ act: 'move', x: 500, y: 300 });
  assert.deepEqual(bounds(), { x: 500, y: 300, width: DOT, height: DOT });
  await bar.act({ act: 'moved' });
  const reopened = await bar.act({ act: 'open' });
  assert.equal(reopened.look, 'panel');
  assert.equal(bounds().width, PANEL_W);
});

test('the page\'s JSON becomes an action only when it has the right shape', () => {
  assert.deepEqual(readAction({ act: 'send', text: 'x', call: true }), { act: 'send', text: 'x', call: true });
  assert.deepEqual(readAction({ act: 'move', x: 1, y: 2 }), { act: 'move', x: 1, y: 2 });
  assert.equal(readAction({ act: 'move', x: 'a', y: 2 }), null);
  assert.equal(readAction({ act: 'rm -rf' }), null);
  assert.equal(readAction(null), null);
  assert.equal(readAction({ act: 'send' }), null);
});

test('one automatic shot per draft: close and open show the draft as it was; the camera adds more; a sent draft starts again', async () => {
  const { bar } = rig();
  assert.equal((await bar.act({ act: 'open' })).shots.length, 1);
  await bar.act({ act: 'close' });
  await bar.act({ act: 'open' });
  await bar.act({ act: 'close' });
  const again = await bar.act({ act: 'open' });
  assert.deepEqual(again.shots, ['data:image/jpeg;base64,1'], 'no pile of shots from close + open');
  assert.equal((await bar.act({ act: 'shot' })).shots.length, 2, 'the camera still adds one');
  await bar.act({ act: 'text', text: 'x' });
  await bar.act({ act: 'send', text: 'x' });
  assert.equal((await bar.act({ act: 'open' })).shots.length, 1, 'the next draft gets its own automatic shot');
});

test('a draft whose automatic shot was removed stays without one when it opens again', async () => {
  const { bar } = rig();
  await bar.act({ act: 'open' });
  await bar.act({ act: 'drop', index: 0 });
  await bar.act({ act: 'close' });
  assert.deepEqual((await bar.act({ act: 'open' })).shots, []);
});

test('removing a shot removes exactly that one', async () => {
  const { bar } = rig();
  await bar.act({ act: 'open' });
  await bar.act({ act: 'shot' });
  await bar.act({ act: 'shot' });
  const left = await bar.act({ act: 'drop', index: 1 });
  assert.deepEqual(left.shots, ['data:image/jpeg;base64,1', 'data:image/jpeg;base64,3']);
});

test('hide: the bubble goes, the state is kept; the shortcut brings it back with the panel open; the tray shows and hides it', async () => {
  const one = rig();
  await one.bar.act({ act: 'menu' });
  assert.deepEqual(one.menu().map((item) => item.label), ['Open Autark', 'Hide bubble (Ctrl+Alt+N brings it back)']);
  one.menu()[1]!.run();
  assert.equal(one.visible(), false);
  assert.equal(one.saved()?.hidden, true);
  assert.deepEqual(one.shown, [true, false], 'the tray hears it');
  const back = await one.bar.toggle();
  assert.equal(back.look, 'panel');
  assert.equal(one.visible(), true);
  assert.equal(one.saved()?.hidden, undefined);
  assert.equal(one.bar.shown, true);
  // a start with float-bar.json saying hidden stays hidden; the tray's Show brings the dot
  const kept = rig({ kept: { x: 100, y: 100, look: 'dot', hidden: true } });
  assert.equal(kept.visible(), false);
  assert.deepEqual(kept.shown, [false]);
  assert.equal(kept.bar.setHidden(false).look, 'dot');
  assert.equal(kept.visible(), true);
  kept.bar.setHidden(true);
  assert.equal(kept.visible(), false);
});

test('a hidden bubble keeps the draft; the page\'s call does not bring it up', async () => {
  const { bar, visible } = rig();
  await bar.act({ act: 'open' });
  await bar.act({ act: 'text', text: 'half a thought' });
  await bar.act({ act: 'hide' });
  bar.setCall({ conversationId: 'ch_a', title: 'Konrad' });
  assert.equal(visible(), false);
  const back = await bar.toggle();
  assert.equal(back.text, 'half a thought');
  assert.equal(back.shots.length, 1, 'no second automatic shot');
});

test('the pill: the page\'s call replaces "Calling…", End ends it in the page, Open opens the app at the chat', async () => {
  const { bar, ended, opened, timers, bounds } = rig();
  await bar.act({ act: 'send', text: 'call me', call: true });
  bar.setCall({ conversationId: 'ch_konrad', title: 'Konrad' });
  assert.equal(bar.view().call?.title, 'Konrad');
  assert.equal(timers[0]!.cancelled, true, 'the start wait ends once the page reports the call');
  await bar.act({ act: 'app' });
  assert.deepEqual(opened, [{ conversationId: 'ch_konrad' }]);
  const after = await bar.act({ act: 'hangup' });
  assert.deepEqual(ended, ['ch_konrad']);
  assert.equal(after.look, 'dot');
  assert.equal(after.call, undefined);
  assert.equal(bounds().width, DOT);
});

test('a call that never starts drops "Calling…"; a call started in the app shows too; a folded tab stays folded', async () => {
  const { bar, timers } = rig();
  await bar.act({ act: 'send', text: 'call me', call: true });
  assert.equal(timers[0]!.ms, CALL_START_MS);
  timers[0]!.fn();
  assert.equal(bar.view().look, 'dot');
  assert.equal(bar.view().call, undefined);
  bar.setCall({ conversationId: 'ch_b', title: 'Mia' });
  assert.equal(bar.view().look, 'call');
  bar.setCall(null);
  assert.equal(bar.view().look, 'dot');
  await bar.act({ act: 'fold' });
  bar.setCall({ conversationId: 'ch_b', title: 'Mia' });
  assert.equal(bar.view().look, 'tab');
  assert.equal(bar.view().call?.title, 'Mia');
  assert.equal((await bar.act({ act: 'unfold' })).look, 'call');
});

test('the new actions are read from the page', () => {
  for (const act of ['menu', 'hide', 'app', 'hangup']) assert.deepEqual(readAction({ act }), { act });
});

test('the tray offers Hide bubble while it shows and Show bubble while hidden; nothing before the bubble runs', () => {
  const asked: boolean[] = [];
  const deps = { onOpen: () => {}, onQuit: () => {}, onBubble: (show: boolean) => { asked.push(show); } };
  assert.deepEqual(trayMenu(deps, null).map((item) => item.label ?? item.type), ['Open', 'separator', 'Quit']);
  const shown = trayMenu(deps, null, true);
  assert.equal(shown[1]!.label, 'Hide bubble');
  (shown[1]!.click as () => void)();
  const hidden = trayMenu(deps, null, false);
  assert.equal(hidden[1]!.label, 'Show bubble');
  (hidden[1]!.click as () => void)();
  assert.deepEqual(asked, [false, true]);
});

test('the page: every id is unique and every id the script looks up is in the page', () => {
  const page = floatPage();
  const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'duplicate ids');
  const looked = new Set([...page.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]!));
  for (const id of looked) assert.ok(ids.includes(id), `$('${id}') has no element`);
  assert.ok(ids.includes('pill') && ids.includes('call'), 'the pill and the panel\'s Call button are two elements');
});

test('the app page gone (window closed, renderer died) ends the pill and a call still starting; End waits for a loading page', async () => {
  const live = rig();
  live.bar.setCall({ conversationId: 'ch_a', title: 'Konrad' });
  live.bar.pageGone();
  assert.equal(live.bar.view().look, 'dot');
  assert.equal(live.bar.view().call, undefined);
  const starting = rig();
  await starting.bar.act({ act: 'send', text: 'call me', call: true });
  starting.bar.pageGone();
  assert.equal(starting.bar.view().call, undefined);
  assert.equal(starting.timers[0]!.cancelled, true);
  const source = readFileSync(new URL('../../../src/main/float-bar-window.ts', import.meta.url), 'utf8');
  assert.match(source, /endCall: \(conversationId\) => renderer\.sendWhenLoaded\(IPC\.bubbleEnd, conversationId\)/);
  assert.match(source, /window\.onPageGone\(\(\) => opened\.bar\.pageGone\(\)\)/);
});

// 0.3.20 (owner 24.11.2026): the rail icon of the app pulls the floating bubble out under the pointer (handle).
test('the rail icon: pull puts the dot under the pointer, move follows it, drop keeps the place; a hidden bubble comes out', () => {
  const r = rig({ kept: { x: 100, y: 100, look: 'dot', hidden: true } });
  assert.equal(r.visible(), false);
  r.setCursor(700, 400);
  r.bar.handle('pull');
  assert.equal(r.visible(), true);
  assert.equal(r.bar.shown, true);
  assert.deepEqual(r.bounds(), { x: 700 - DOT / 2, y: 400 - DOT / 2, width: DOT, height: DOT });
  assert.deepEqual(r.shown, [false, true], 'the tray and the icon hear that it is out');
  r.setCursor(900, 520);
  r.bar.handle('move');
  assert.deepEqual(r.bounds(), { x: 900 - DOT / 2, y: 520 - DOT / 2, width: DOT, height: DOT });
  r.setCursor(1000, 560);
  r.bar.handle('drop');
  assert.deepEqual([r.saved()?.x, r.saved()?.y, r.saved()?.hidden], [1000 - DOT / 2, 560 - DOT / 2, undefined], 'kept where it was let go');
  r.setCursor(50, 50);
  r.bar.handle('move'); // no pull running: the bubble stays
  assert.equal(r.bounds().x, 1000 - DOT / 2);
});

test('the rail icon: a click (press) brings a hidden bubble back to its last place and does nothing to one that is out', () => {
  const r = rig({ kept: { x: 300, y: 200, look: 'dot', hidden: true } });
  r.bar.handle('press');
  assert.equal(r.visible(), true);
  assert.deepEqual([r.bounds().x, r.bounds().y], [300, 200]);
  const before = r.shown.length;
  r.bar.handle('press');
  assert.equal(r.shown.length, before);
});

test('the rail icon: a pull near the screen edge stays inside the work area', () => {
  const r = rig();
  r.setCursor(5000, -40);
  r.bar.handle('pull');
  assert.ok(r.bounds().x + DOT <= AREA.width && r.bounds().y >= 0);
});
