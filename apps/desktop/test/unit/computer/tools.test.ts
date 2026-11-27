// Device tool definitions (names, categories, remote/requires flags, external effects in
// describe) and the peer handlers that execute remote calls on a linked PC. B-080 (live 09.11.): a covered window's
// picture says a browser there may not draw its page, and computer.ui_tree of a Chrome or Edge window whose whole tree
// holds no page document says so and why (computer/tree.ts frameOnly) – for any read at least as deep as a plain one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceTools, registerDeviceHandlers } from '../../../src/runtime/devices/tools.ts';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import { computerTools } from '../../../src/runtime/computer/tools.ts';
import { brokerState } from '../../../src/runtime/computer/broker.ts';
import { frameOnly, TREE_DEPTH } from '../../../src/runtime/computer/tree.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import { MemoryLogger } from '../fakes.ts';
import type { BrowserService } from '../../../src/runtime/browser/service.ts';
import type { AdbPhone } from '../../../src/runtime/phone/adb.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { PeerHandler } from '../../../src/runtime/devices/rpc-peer.ts';
import { agent } from '../chat/harness.ts';

const tools = deviceTools({ computer: {} as ComputerService, browser: {} as BrowserService, phone: {} as AdbPhone });
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const ctx = { agent: agent('ag_1', 'Mira'), runId: 'run_1', mode: 'computer', deviceId: 'dev_2' } as unknown as ToolContext;

test('every device tool exists with the right category, remote flag and visibility', () => {
  const expected = [
    'computer.screenshot', 'computer.windows', 'computer.ui_tree', 'computer.act', 'computer.click', 'computer.type', 'computer.key',
    'computer.scroll', 'computer.drag', 'computer.wait', 'computer.batch', 'browser.open', 'browser.snapshot', 'browser.act', 'browser.screenshot', 'browser.extract',
    'browser.tabs', 'browser.batch', 'browser.find', 'browser.console', 'browser.network', 'browser.eval', 'browser.wait', // B-055 Q7 (track E)
    'phone.devices', 'phone.screenshot', 'phone.ui_tree', 'phone.tap', 'phone.swipe', 'phone.type', 'phone.key',
    'phone.open', 'phone.say', 'phone.pair', 'phone.connect', 'phone.disconnect', 'devices.list', 'devices.send_file',
    'browser.save_totp', // X05: stores a 2FA key on this PC only
    'browser.save_secret', // B-044: stores a value of this PC's page as the agent's secret (local only)
  ];
  assert.deepEqual([...byName.keys()].sort(), [...expected].sort());
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_.-]{0,63}$/);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.ok(tool.description.length > 20 && tool.description.length < 500, tool.name);
    if (tool.name.startsWith('computer.') || tool.name.startsWith('phone.')) assert.equal(tool.category, 'device', tool.name);
    if ((tool.name.startsWith('computer.') || tool.name.startsWith('browser.')) && tool.name !== 'browser.save_totp' && tool.name !== 'browser.save_secret') assert.equal(tool.remote, true, tool.name);
    if (tool.name !== 'devices.list' && tool.name !== 'devices.send_file') assert.equal(tool.requires, 'device', tool.name);
  }
  // devices.send_file is offered in every mode (no tool.modes, tools/registry.ts), so it needs no device mode.
  assert.equal(byName.get('devices.send_file')!.requires, undefined);
  assert.equal(byName.get('devices.send_file')!.modes, undefined);
  for (const name of ['browser.open', 'browser.snapshot', 'browser.screenshot', 'browser.extract', 'browser.tabs', 'browser.find', 'browser.console', 'browser.network', 'browser.wait']) assert.equal(byName.get(name)!.category, 'read');
  for (const name of ['browser.act', 'browser.batch', 'browser.eval']) assert.equal(byName.get(name)!.category, 'device', name);
  assert.equal(byName.get('browser.save_secret')!.category, 'write_local');
  assert.equal(byName.get('browser.save_secret')!.remote, undefined, 'it reads the browser of this PC only');
  assert.equal(byName.get('devices.list')!.category, 'read');
  assert.equal(byName.get('devices.list')!.requires, undefined);
});

/** computerTools over a real ComputerService whose helper answers from `answers` (no PowerShell, no screen). */
function computerRig(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const helper: HelperClient = {
    async call<T>(op: HelperOp, args: Record<string, unknown> = {}): Promise<T> { return (answers[op] ? answers[op]!(args) : { done: true }) as T; },
    running: () => true,
    async dispose() {},
  };
  const host = {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds() { return 60; },
  } as Host;
  const computer = new ComputerService({ host, supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(), helper, platform: 'win32' });
  const runCtx = { agent: agent('ag_lena', 'Lena'), runId: 'run_1', mode: 'computer', signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const all = new Map(computerTools(computer).map((tool) => [tool.name, tool]));
  const run = async (name: string, args: Record<string, unknown>) => {
    const out = (await all.get(name)!.run(args, runCtx)) as ToolOutput;
    return out.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
  };
  return { run };
}

const FRAME = [
  { d: 0, p: -1, rid: '1', role: 'window', name: 'Unbenannt - Google Chrome' },
  { d: 1, p: 0, rid: '1.1', role: 'titlebar', name: 'Unbenannt - Google Chrome' },
  { d: 2, p: 1, rid: '1.1.1', role: 'button', name: 'Minimieren', patterns: ['invoke'] },
  { d: 1, p: 0, rid: '1.2', role: 'tabitem', name: 'Unbenannt', patterns: ['selectionitem'] },
];

test('B-080: a covered window\'s picture says a browser behind another window may not draw its page', async () => {
  const rig = computerRig({ screenshot: () => ({ data: Buffer.from('x').toString('base64'), mime: 'image/jpeg', width: 4, height: 2, x: 0, y: 0, srcWidth: 4, covered: true }) });
  assert.match(await rig.run('computer.screenshot', { window: 41 }), /I bring it forward first with computer\.act focus_window\. A browser behind another window may not draw its page\./);
});

test('F03: on Windows without the broker, after a setup that got no Yes, the screenshot says the secure desktop is out of reach', { skip: process.platform !== 'win32' && 'the line is about Windows' }, async () => {
  const rig = computerRig({ screenshot: () => ({ data: Buffer.from('x').toString('base64'), mime: 'image/jpeg', width: 4, height: 2, x: 0, y: 0, srcWidth: 4 }) });
  const saved = { via: brokerState.via, setup: brokerState.setup };
  try {
    brokerState.via = 'powershell';
    brokerState.setup = undefined;
    assert.doesNotMatch(await rig.run('computer.screenshot', {}), /secure desktop/, 'no setup ran here: nothing to say');
    brokerState.setup = { state: 'declined', script: 'C:\\A\\install.ps1' };
    assert.match(await rig.run('computer.screenshot', {}), /\nThe Windows secure desktop \(UAC prompts, the locked screen\) is out of my reach on this PC: .* -File "C:\\A\\install\.ps1"/);
  } finally { Object.assign(brokerState, saved); }
});

test('owner 24.11.2026: on the secure desktop the screenshot and a coordinate click name the UAC element way (OkButton, invoke); elsewhere nothing', async () => {
  const rig = computerRig({
    screenshot: () => ({ data: Buffer.from('x').toString('base64'), mime: 'image/jpeg', width: 4, height: 2, x: 0, y: 0, srcWidth: 4 }),
    click: (args) => ({ x: args.x, y: args.y }),
    move: (args) => ({ x: args.x, y: args.y }),
  });
  const saved = { via: brokerState.via, desktop: brokerState.desktop };
  const element = /A UAC prompt I answer by its button element, never by coordinates: computer\.ui_tree with automationId "OkButton" \(Yes\) or "CancelButton" \(No\), then computer\.act invoke/;
  try {
    brokerState.via = 'broker';
    brokerState.desktop = 'Winlogon';
    const shot = await rig.run('computer.screenshot', {});
    assert.match(shot, element);
    assert.ok(shot.indexOf('OkButton') < shot.indexOf('desktop broker with these same tools'), 'the element way comes first');
    const click = await rig.run('computer.click', { x: 808, y: 780, motion: 'instant' });
    assert.match(click, /This click went to the Windows secure desktop\. A UAC prompt I answer by its button element/);
    brokerState.desktop = 'Default';
    assert.doesNotMatch(await rig.run('computer.screenshot', {}), /UAC prompt I answer/);
    assert.doesNotMatch(await rig.run('computer.click', { x: 808, y: 780, motion: 'instant' }), /secure desktop/);
  } finally { Object.assign(brokerState, saved); }
});

const CHROME_FRAME ="This Chrome window's UI tree holds its frame only: Chrome puts the page document into it once the page has loaded in a window that is not covered.";

test('B-080: computer.ui_tree of a Chrome window without a page document says its tree holds the frame only and why; a page, another window or a cut tree say nothing', async () => {
  let answer: Record<string, unknown> = { hwnd: 41, title: 'Unbenannt - Google Chrome', truncated: false, nodes: FRAME };
  const rig = computerRig({ tree: () => answer });
  const lines = (await rig.run('computer.ui_tree', { window: 41 })).split('\n');
  assert.match(lines[0]!, /^Window 41 "Unbenannt - Google Chrome" · 4 elements\. Format: /);
  assert.equal(lines[1], CHROME_FRAME);
  assert.match(lines[2]!, /^- window "Unbenannt - Google Chrome" \[ref=e\d+\]/);
  answer = { ...answer, title: 'Contact us | CodeWithHarry - Google Chrome', nodes: [...FRAME, { d: 1, p: 0, rid: '1.3', role: 'document', name: 'Contact us | CodeWithHarry' }] };
  assert.doesNotMatch(await rig.run('computer.ui_tree', { window: 41 }), /frame only/, 'the page is in the tree');
  answer = { hwnd: 7, title: 'Unbenannt - Editor', truncated: false, nodes: [{ d: 0, p: -1, rid: '7', role: 'window', name: 'Unbenannt - Editor' }, { d: 1, p: 0, rid: '7.1', role: 'button', name: 'Schließen', patterns: ['invoke'] }] };
  assert.doesNotMatch(await rig.run('computer.ui_tree', { window: 7 }), /frame only/, 'not a browser');
  answer = { hwnd: 41, title: 'Unbenannt - Google Chrome', truncated: true, nodes: FRAME };
  assert.doesNotMatch(await rig.run('computer.ui_tree', { window: 41 }), /frame only/, 'a truncated tree tells nothing about the page');
  answer = { hwnd: 41, title: 'Unbenannt - Google Chrome', truncated: false, nodes: FRAME };
  assert.doesNotMatch(await rig.run('computer.ui_tree', { window: 41, depth: 2 }), /frame only/, 'a tree read shallower than a plain read neither');
  // Live 09.11.: 18 of 23 reads of these windows asked for depth 25–35 – deeper than a plain read, so the whole tree.
  assert.equal((await rig.run('computer.ui_tree', { window: 41, depth: 30 })).split('\n')[1], CHROME_FRAME);
  assert.equal((await rig.run('computer.ui_tree', { window: 41, depth: TREE_DEPTH })).split('\n')[1], CHROME_FRAME);
});

test('KI-Runde 17.11.2026: a cut search says maxNodes finds more only while a higher one would', async () => {
  const node = (i: number) => ({ d: 1, p: -1, rid: `1.${i}`, role: 'button', name: `Senden ${i}`, patterns: ['invoke'] });
  let count = 20;
  const rig = computerRig({ find: () => ({ hwnd: 7, truncated: true, nodes: Array.from({ length: count }, (_, i) => node(i)) }) });
  assert.match(await rig.run('computer.ui_tree', { name: 'Senden' }), /\(search stopped at 20 – maxNodes up to 100 finds more, a narrower name or role fewer\)/);
  count = 100;
  const full = await rig.run('computer.ui_tree', { name: 'Senden', maxNodes: 100 });
  assert.match(full, /\(search stopped at 100 – a narrower name or role finds fewer\)/);
  assert.doesNotMatch(full, /maxNodes/, 'at 100 there is nothing left to raise');
});

test('B-080 frameOnly: Chrome and Edge titles (Edge with its zero-width space), a document line anywhere, other titles', () => {
  const frame = '- titlebar "x" [ref=e1]\n  - button "Minimieren" [ref=e2]';
  assert.equal(frameOnly('Neuer Tab - Profil 1 - Microsoft​ Edge', frame), "This Edge window's UI tree holds its frame only: Edge puts the page document into it once the page has loaded in a window that is not covered.");
  assert.equal(frameOnly('Unbenannt - Google Chrome', frame), CHROME_FRAME);
  assert.equal(frameOnly('Unbenannt - Google Chrome', `${frame}\n    - document [ref=e3]`), undefined, 'an unnamed document node counts');
  assert.equal(frameOnly('Google Chrome Hilfe.pdf - Adobe Acrobat', frame), undefined, 'a title that only mentions Chrome');
  assert.equal(frameOnly('Edge.docx - Word', frame), undefined);
});
