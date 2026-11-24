// Owns: the bridge of 19.11.2026 (runtime/bridge/sicher-1119.ts): pcAccess/forEveryAgent leave settings.json – careful
// keeps its Trust AI mode with old guidance; an existing section stays; the old
// robot line is dropped and any other text lands below both general texts, once; the settings store then reads the file
// without the two keys. The old whole/careful PC line in a SYSTEM.md becomes today's line, which is the line the
// standard renders; own wording stays. Also: Secure mode's start question at the first run.
// Never: main.ts's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { carefulSecurity, ownLines, pcLine, pcLinePart, releasedFolders, runSicher1119Files, withTodaysPcLine } from '../../../src/runtime/bridge/sicher-1119.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { systemMdValues } from '../../../src/runtime/org/hire.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { securityDefaults } from '../../../src/shared/model/security-settings.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { agent, harness } from '../chat/harness.ts';
import { clock, recordingBus, tempDir } from '../store/helpers.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
const ROBOT_EN = 'I don\'t solve "I\'m not a robot" checks (CAPTCHAs).';
const ROBOT_DE = '„Ich bin kein Roboter“-Prüfungen (CAPTCHAs) löse ich nicht.';

function withSettings(profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const temp = tempDir('wf-bridge-');
  writeFileSync(path.join(temp.dir, 'settings.json'), `// comment\n${JSON.stringify({ profile: { name: 'Ada', ...profile }, ...extra }, null, 2)}\n`);
  const read = () => parseText(readFileSync(path.join(temp.dir, 'settings.json'), 'utf8')).data as Record<string, Record<string, unknown>>;
  const general = (mode: string) => path.join(temp.dir, 'security', mode, 'general.md');
  return { dir: temp.dir, read, general, done: temp.cleanup };
}

test('upgrading a careful profile keeps Trust AI mode and its old write guidance; the legacy keys leave', () => {
  const careful = withSettings({ pcAccess: 'careful', forEveryAgent: ROBOT_EN });
  try {
    assert.equal(runSicher1119Files(careful.dir, RESOURCES), 'moved');
    const data = careful.read();
    assert.deepEqual(data.security, { ...carefulSecurity(), mode: 'trust' });
    assert.equal(data.security.mode, 'trust');
    assert.equal(data.security.read, 'all');
    assert.equal(data.security.commands, 'yes');
    assert.equal(data.security.write, 'chosen');
    assert.deepEqual(data.profile, { name: 'Ada' });
    assert.match(readFileSync(careful.general('trust'), 'utf8'), /For other changes I ask first\./);
    assert.equal(existsSync(careful.general('secure')), false, 'nothing appended to Secure for the old default robot line');
    assert.equal(runSicher1119Files(careful.dir, RESOURCES), 'none', 'once');
    const store = new SettingsStore({ bus: recordingBus().bus, clock: clock(), env: { locale: 'en-US', timezone: 'UTC' }, dataDir: careful.dir });
    assert.equal(store.get().security?.mode, 'trust', 'the store reads it');
    store.close();
  } finally { careful.done(); }
  const whole = withSettings({ pcAccess: 'whole' });
  try {
    runSicher1119Files(whole.dir, RESOURCES);
    assert.deepEqual(whole.read().security, securityDefaults('trust'));
  } finally { whole.done(); }
  const kept = withSettings({ pcAccess: 'careful' }, { security: { ...securityDefaults('trust'), money: 'ask' } });
  try {
    runSicher1119Files(kept.dir, RESOURCES);
    assert.equal(kept.read().security.money, 'ask', 'a section a linked PC brought first stays');
    assert.equal(kept.read().security.mode, 'trust');
  } finally { kept.done(); }
  const none = withSettings({});
  try { assert.equal(runSicher1119Files(none.dir, RESOURCES), 'none'); } finally { none.done(); }
  const empty = tempDir('wf-bridge-');
  try { assert.equal(runSicher1119Files(empty.dir, RESOURCES), 'none', 'no settings.json'); } finally { empty.cleanup(); }
});

test('careful saves the former write scope as an optional preset and carries the released folders into the Trust guidance', () => {
  const careful = withSettings({ pcAccess: 'careful' });
  try {
    const system = (id: string, text: string) => { mkdirSync(path.join(careful.dir, 'agents', id), { recursive: true }); writeFileSync(path.join(careful.dir, 'agents', id, 'SYSTEM.md'), text); };
    system('ag_a', '# How I work\n- … Released folders: D:\\Work, C:\\Users\\Ada\\My Docs and /srv/share.\n');
    system('ag_b', '- Released folders: d:\\work; \\\\nas\\team.\n');
    system('ag_c', '- Released folders: none yet.\n');
    runSicher1119Files(careful.dir, RESOURCES);
    const security = careful.read().security as Record<string, unknown>;
    assert.equal(security.mode, 'trust');
    assert.equal(security.write, 'chosen');
    assert.equal(security.read, 'all');
    for (const key of ['commands', 'web', 'computer', 'phone', 'message', 'publish', 'accounts', 'setup', 'team']) assert.equal(security[key], 'yes', key);
    const folders = security.writeFolders as string[];
    assert.ok(folders.includes('D:\\Work'), JSON.stringify(folders));
    assert.ok(readFileSync(careful.general('trust'), 'utf8').includes('D:\\Work'));
    assert.ok(folders.includes('C:\\Users\\Ada\\My Docs'), JSON.stringify(folders));
    assert.ok(folders.includes('/srv/share'), JSON.stringify(folders));
    assert.ok(folders.includes('\\\\nas\\team'), JSON.stringify(folders));
    assert.equal(folders.filter((folder) => folder.toLowerCase() === 'd:\\work').length, process.platform === 'win32' ? 1 : 2, 'each once (case on Windows)');
  } finally { careful.done(); }
  assert.deepEqual(releasedFolders('none yet.'), []);
  assert.deepEqual(releasedFolders(' C:\\A and D:/B.'), ['C:\\A', 'D:/B']);
});

test('the old text for every agent: the robot line goes, the rest lands below both general texts, once', () => {
  assert.equal(ownLines(`${ROBOT_DE}\r\nI sign with my name.`), 'I sign with my name.');
  assert.equal(ownLines(`  ${ROBOT_EN}  `), '');
  assert.equal(ownLines(undefined), '');
  const h = withSettings({ forEveryAgent: `${ROBOT_EN}\nI sign with my name.\nNo calls before 10:00.` });
  try {
    mkdirSync(path.dirname(h.general('secure')), { recursive: true });
    writeFileSync(h.general('secure'), 'My own secure text.\n');
    runSicher1119Files(h.dir, RESOURCES);
    const trust = readFileSync(h.general('trust'), 'utf8');
    assert.match(trust, /^I decide and act – that is why Ada chose this mode\./, 'the default with the name');
    assert.ok(trust.endsWith('\n\nI sign with my name.\nNo calls before 10:00.\n'));
    assert.equal(readFileSync(h.general('secure'), 'utf8'), 'My own secure text.\n\nI sign with my name.\nNo calls before 10:00.\n');
    assert.equal(h.read().security.mode, 'trust');
    // a stop between the topic files and settings.json: the step runs again and appends nothing twice
    writeFileSync(path.join(h.dir, 'settings.json'), JSON.stringify({ profile: { name: 'Ada', forEveryAgent: 'I sign with my name.\nNo calls before 10:00.' } }));
    runSicher1119Files(h.dir, RESOURCES);
    assert.equal(readFileSync(h.general('secure'), 'utf8'), 'My own secure text.\n\nI sign with my name.\nNo calls before 10:00.\n');
  } finally { h.done(); }
});

test('the old PC lines (any name) become today\'s line – the one the standard renders; own wording stays', () => {
  const values = systemMdValues({ profile: { name: 'Ada', company: '' } } as never);
  const today = prompts.renderText('standard-agent', values).split('\n').find((line) => line.startsWith('- This PC is my workplace'));
  assert.equal(today, pcLine('Ada'), 'the bridge writes the line the standard has');
  assert.equal(prompts.renderText('standard-manager', values).split('\n').find((line) => line.startsWith('- This PC is my workplace')), pcLine('Ada'));
  const whole = '## What I have here\n- This PC is my workplace, all of it: the files and apps on it, the browser with the person\'s logins and the secrets catalog with their passwords and keys.\n- Money: I weigh.';
  assert.equal(withTodaysPcLine(whole, 'Ada'), `## What I have here\n${pcLine('Ada')}\n- Money: I weigh.`);
  const careful = '- This PC is my workplace, the way Bo chose at the start (careful): I read and look wherever it helps, use the browser with their logins and the secrets catalog with their passwords and keys; in my workspace, my home project, this app\'s data folder and the released folders I change, install and delete as my own call, and anywhere whatever Bo asks me to. Only a change elsewhere that nobody asked for I check with Bo in one line first; a folder they release for good I add here. Released folders: none yet.';
  assert.equal(withTodaysPcLine(careful, 'Ada'), pcLine('Ada'));
  const own = '- This PC is my workplace, all of it, and I love it.';
  assert.equal(withTodaysPcLine(own, 'Ada'), own);
  const released = careful.replace('Released folders: none yet.', 'Released folders: D:\\Work and E:\\Shared Docs.');
  assert.equal(withTodaysPcLine(released, 'Ada'), pcLine('Ada'), 'FX1 M1: with released folders too (they moved into the settings)');
  const edited = careful.replace('I read and look wherever it helps', 'I read only what I need');
  assert.equal(withTodaysPcLine(edited, 'Ada'), edited, 'an edited careful line is the agent\'s own');
});

test('pcLinePart changes each agent with an old line once, as the person, and no other', () => {
  const h = harness();
  const updates: Array<{ id: string; reason?: string }> = [];
  Object.assign(h.org, { update: (id: string, patch: Partial<Agent>, by: { reason?: string }) => { updates.push({ id, reason: by?.reason }); return h.org.add({ ...h.org.require(id), ...patch }); } });
  Object.assign(h.services, { settings: { get: () => ({ profile: { name: 'Ada' } }) } });
  h.org.add(agent('ag_old', 'Old', { instructions: '# How I work\nX.\n\n## What I have here\n- This PC is my workplace, all of it: the files and apps on it, the browser with Ada\'s logins and the secrets catalog with their passwords and keys.' }));
  h.org.add(agent('ag_new', 'New', { instructions: `# How I work\nX.\n\n## What I have here\n${pcLine('Ada')}` }));
  assert.equal(pcLinePart(h.services as RuntimeServices), 1);
  assert.deepEqual(updates.map((update) => update.id), ['ag_old']);
  assert.ok(h.org.require('ag_old').instructions.endsWith(pcLine('Ada')));
  assert.equal(pcLinePart(h.services as RuntimeServices), 0, 'once');
});

test('first run in Secure mode: the Manager\'s SYSTEM.md stays as it is, its first question asks for its own area', () => {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  const updates: string[] = [];
  Object.assign(h.org, { update: (id: string) => { updates.push(id); return h.org.require(id); } });
  Object.assign(h.services, { settings, accounts: { list: () => [], detect: async () => ({}) }, prompts });
  const hired = prompts.renderText('standard-manager', systemMdValues({ profile: { name: '', company: '' } } as never));
  h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', template: 'manager', createdAt: 1, instructions: hired }));
  settings.update({ profile: { name: 'Ada' }, security: securityDefaults('secure') });
  const { conversationId } = new Onboarding({ services: () => h.services as RuntimeServices }).start();
  assert.deepEqual(updates, [], 'no line of SYSTEM.md follows the mode');
  const first = h.chats.messages(conversationId).filter((message) => message.authorId === 'ag_boss');
  assert.match(first[0]!.body, /On this PC I work in my own area\./);
});
