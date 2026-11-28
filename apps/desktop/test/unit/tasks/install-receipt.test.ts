// B-080 – an install and its receipt (tasks/recover-notes.ts, tasks/ownership.ts, tools/builtin/app-install.ts, RPC
// system.install): app.install keeps the install with who started it and asks the host; the next start tells the person
// whether it landed ("Updated to X" / "The update to X did not install · still on Y") and wakes the agent once with the
// landed or not-landed note (the helper log's last line when it did not land); a start under the same app process
// followed no install – a postponed update says nothing, the agent hears its install did not start; the updater's own
// install keeps its version (prepareRestart {to}) in a record of its own, and a cancel answers and drops the install at
// once; a headless host or a missing file refuses.
// Owns: these assertions only. Never: a real installer, the app or the person's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agent, harness } from '../chat/harness.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { buildVersion, dropInstall, installBuild, noteUpdate, readStartNotice, recordStart, type InstallRecord } from '../../../src/runtime/tasks/recover-notes.ts';
import { appInstallTools } from '../../../src/runtime/tools/builtin/app-install.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-install-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const installer = path.join(dir, 'autark-windows-x64.exe');
writeFileSync(installer, 'MZ');

function team(version: string, pid?: number) {
  const h = harness();
  h.org.add(agent('ag_jonas', 'Jonas'));
  const chat = h.chats.create({ agentIds: ['ag_jonas'], createdBy: 'human' });
  const logs = path.join(dir, `logs-${Math.random().toString(36).slice(2)}`);
  mkdirSync(logs, { recursive: true });
  const installs: string[] = [];
  Object.assign(h.services, {
    paths: { logs },
    settings: { get: () => ({ profile: { timezone: 'UTC' } }) },
    host: { ...h.services.host, app: { version, ...(pid !== undefined ? { pid } : {}) }, install: async (file: string) => { installs.push(file); } },
  });
  return { h, chat, logs, installs };
}

const record = (h: ReturnType<typeof harness>) => new KvRepo(h.db).get<InstallRecord>('system', 'install') ?? undefined;
const notes = (h: ReturnType<typeof harness>) => h.wakeRows().filter((row) => row.agent_id === 'ag_jonas').map((row) => row.note);

test('app.install keeps the install with who started it and asks the host', async () => {
  const { h, chat, installs } = team('0.3.4');
  const tool = appInstallTools[0];
  const ctx = { services: h.services, agent: h.org.require('ag_jonas'), runId: 'run_9', conversationId: chat.id } as unknown as ToolContext;
  const out = await tool.run({ installer }, ctx);
  assert.equal(out.isError, undefined, JSON.stringify(out.content));
  assert.deepEqual(installs, [installer]);
  assert.deepEqual(record(h), { from: '0.3.4', installer, by: { agentId: 'ag_jonas', runId: 'run_9', conversationId: chat.id }, at: h.clock.now() });
  const { h: own } = team('0.3.4', 4242);
  await installBuild(own.services, installer);
  assert.equal(record(own)?.pid, 4242, "the app's process is kept");
  assert.match(tool.description, /^Installs an Autark build on this PC the way an update does\./);
});

test('a start on the new version: "Updated to", the landed note to the agent, the record dropped', () => {
  const { h, chat } = team('0.3.5');
  new KvRepo(h.db).set('system', 'install', { to: '0.3.5', from: '0.3.4', installer, by: { agentId: 'ag_jonas', conversationId: chat.id, runId: 'run_9' }, at: h.clock.now() - 120_000 }, 0);
  h.ownership.recover({ interruptedRuns: [] });
  assert.deepEqual(notes(h), ['Autark started again at 09:00 on 0.3.5 – the install I started at 08:58 landed.']);
  const landed = recordStart(h.services, { version: '0.3.5', interrupted: 0, continued: 0 });
  assert.equal(landed?.text, 'Updated to 0.3.5 · 0 tasks continued');
  assert.equal(landed?.failed, undefined, 'F25: a landed install is no failure');
  assert.equal(record(h), undefined, 'answered once');
});

test('a start still on the old version: "did not install", the not-landed note with the helper log\'s last line', () => {
  const { h, chat, logs } = team('0.3.4');
  writeFileSync(path.join(logs, 'update-helper.log'), 'Sa 08.11.2026 09:00 helper started; waiting for the app (pid 1) to end\r\nSa 08.11.2026 09:01 the app still runs after 45 s; update left for the next try\r\n');
  new KvRepo(h.db).set('system', 'install', { to: '0.3.5', from: '0.3.4', by: { agentId: 'ag_jonas', conversationId: chat.id }, at: h.clock.now() - 60_000 }, 0);
  h.ownership.recover({ interruptedRuns: [] });
  assert.deepEqual(notes(h), ['Autark started again at 09:00, still on 0.3.4 – the install I started at 08:59 did not land; update-helper.log ends with: Sa 08.11.2026 09:01 the app still runs after 45 s; update left for the next try.']);
  const notice = recordStart(h.services, { version: '0.3.4', interrupted: 0, continued: 2 });
  assert.equal(notice?.text, 'The update to 0.3.5 did not install · still on 0.3.4');
  assert.deepEqual([notice?.failed, notice?.to], [true, '0.3.5'], 'F25: marked failed, with the version it would have brought');
  assert.equal(readStartNotice(h.services)?.failed, true, 'system.info reads it so');
});

test('B-084: Smart App Control refused the setup – the start notice says so, the helper\'s later "new version started" does not hide it', () => {
  const { h, logs } = team('0.3.4');
  writeFileSync(path.join(logs, 'update-helper.log'), '09.11.2026  9:04:04,79 helper started; waiting for the app (pid 13708) to end\r\n09.11.2026  9:04:06,26 app ended; installer starts\r\n09.11.2026  9:04:21,74 installer ended (exit code 1073751882)\r\n09.11.2026  9:04:21,76 new version started\r\n');
  new KvRepo(h.db).set('system', 'install', { to: '0.3.5', from: '0.3.4', at: h.clock.now() - 60_000 }, 0);
  assert.equal(recordStart(h.services, { version: '0.3.4', interrupted: 0, continued: 0 })?.text,
    'The update to 0.3.5 did not install: Windows Smart App Control blocked its setup (Autark is not code-signed yet) · still on 0.3.4');
  const other = team('0.3.4');
  writeFileSync(path.join(other.logs, 'update-helper.log'), '09.11.2026  9:04:21,74 installer ended (exit code 1073751882)\r\n09.11.2026  9:10:00,00 installer ended (exit code 2)\r\n');
  new KvRepo(other.h.db).set('system', 'install', { to: '0.3.5', from: '0.3.4', at: other.h.clock.now() - 60_000 }, 0);
  assert.equal(recordStart(other.h.services, { version: '0.3.4', interrupted: 0, continued: 0 })?.text, 'The update to 0.3.5 did not install · still on 0.3.4', 'only the last install counts');
});

test('without a known target version an install landed when the version changed', () => {
  const same = team('0.3.4');
  new KvRepo(same.h.db).set('system', 'install', { from: '0.3.4', at: 0 }, 0);
  assert.equal(recordStart(same.h.services, { version: '0.3.4', interrupted: 0, continued: 0 })?.text, 'The update did not install · still on 0.3.4');
  const moved = team('0.3.5-local.2');
  new KvRepo(moved.h.db).set('system', 'install', { from: '0.3.4', at: 0 }, 0);
  assert.equal(recordStart(moved.h.services, { version: '0.3.5-local.2', interrupted: 1, continued: 1 })?.text, 'Updated to 0.3.5-local.2 · 1 task continued');
  assert.deepEqual(notes(moved.h), [], 'no agent named: no note');
});

test('28.11.2026: a build of the running version (app.install, no latest.yml) that the installer ran without an error is "Reinstalled", not a failed update', () => {
  const log = '28.11.2026  2:47:07,76 helper started; waiting for the app (pid 22584) to end\r\n28.11.2026  2:47:09,19 app ended; installer starts\r\n28.11.2026  2:48:10,98 installer ended (exit code 0)\r\n28.11.2026  2:48:14,64 new version started\r\n';
  const { h, chat, logs } = team('0.3.21');
  const file = path.join(logs, 'update-helper.log');
  writeFileSync(file, log);
  new KvRepo(h.db).set('system', 'install', { from: '0.3.21', installer, by: { agentId: 'ag_jonas', conversationId: chat.id }, at: h.clock.now() - 60_000 }, 0);
  h.ownership.recover({ interruptedRuns: [] });
  assert.deepEqual(notes(h), ['Autark started again at 09:00 on 0.3.21 – the install I started at 08:59 was this same version, installed again without an error.']);
  const notice = recordStart(h.services, { version: '0.3.21', interrupted: 0, continued: 3 });
  assert.equal(notice?.text, 'Reinstalled 0.3.21 · 3 tasks continued');
  assert.equal(notice?.failed, undefined, 'no failure: the phone shows this notice to a person');
  // a log line of an earlier install (the file older than the record) proves nothing: still "did not install"
  const stale = team('0.3.21');
  const old = path.join(stale.logs, 'update-helper.log');
  writeFileSync(old, log);
  utimesSync(old, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  new KvRepo(stale.h.db).set('system', 'install', { from: '0.3.21', at: Date.now() }, 0);
  assert.equal(recordStart(stale.h.services, { version: '0.3.21', interrupted: 0, continued: 0 })?.text, 'The update did not install · still on 0.3.21');
  // an installer that failed (exit code 2) or one with a known target that did not arrive stays a failure
  const failed = team('0.3.21');
  writeFileSync(path.join(failed.logs, 'update-helper.log'), '28.11.2026  2:48:10,98 installer ended (exit code 2)\r\n');
  new KvRepo(failed.h.db).set('system', 'install', { from: '0.3.21', at: 0 }, 0);
  assert.equal(recordStart(failed.h.services, { version: '0.3.21', interrupted: 0, continued: 0 })?.text, 'The update did not install · still on 0.3.21');
  const target = team('0.3.21');
  writeFileSync(path.join(target.logs, 'update-helper.log'), log);
  new KvRepo(target.h.db).set('system', 'install', { to: '0.3.22', from: '0.3.21', at: 0 }, 0);
  assert.equal(recordStart(target.h.services, { version: '0.3.21', interrupted: 0, continued: 0 })?.text, 'The update to 0.3.22 did not install · still on 0.3.21');
});

test("the updater's own install keeps its version in a record of its own; a cancel drops it without a note", () => {
  const { h } = team('0.3.4', 4242);
  noteUpdate(h.services, '0.3.5');
  assert.deepEqual(record(h), { to: '0.3.5', from: '0.3.4', pid: 4242, at: h.clock.now() });
  dropInstall(h.services);
  assert.equal(record(h), undefined);
  new KvRepo(h.db).set('system', 'install', { from: '0.3.3', installer, by: { agentId: 'ag_jonas' }, at: 5 }, 0);
  noteUpdate(h.services, '0.3.5');
  assert.deepEqual(record(h), { to: '0.3.5', from: '0.3.4', pid: 4242, at: h.clock.now() }, "an old agent record never becomes this update's");
  assert.deepEqual(notes(h), []);
});

test('a start under the same app process followed no install: a postponed update says nothing, the agent hears it did not start', () => {
  const postponed = team('0.3.4', 4242);
  new KvRepo(postponed.h.db).set('system', 'install', { to: '0.3.5', from: '0.3.4', pid: 4242, at: 0 }, 0);
  assert.equal(recordStart(postponed.h.services, { version: '0.3.4', interrupted: 0, continued: 0 }), undefined, 'no "did not install"');
  assert.equal(record(postponed.h), undefined, 'dropped');
  const { h, chat } = team('0.3.4', 4242);
  new KvRepo(h.db).set('system', 'install', { to: '0.3.5', from: '0.3.4', installer, by: { agentId: 'ag_jonas', conversationId: chat.id, runId: 'run_9' }, pid: 4242, at: h.clock.now() - 60_000 }, 0);
  h.ownership.recover({ interruptedRuns: [] });
  assert.deepEqual(notes(h), ['At 09:00 Autark still runs 0.3.4 – the install I started at 08:59 did not start.']);
  assert.equal(recordStart(h.services, { version: '0.3.4', interrupted: 1, continued: 1 })?.text, 'Restarted after an interruption · 1 task continued');
  const later = team('0.3.5', 5150);
  new KvRepo(later.h.db).set('system', 'install', { to: '0.3.5', from: '0.3.4', pid: 4242, at: 0 }, 0);
  assert.equal(recordStart(later.h.services, { version: '0.3.5', interrupted: 0, continued: 0 })?.text, 'Updated to 0.3.5 · 0 tasks continued', 'another app process: answered as before');
});

test('an install main gave up without a restart (system.prepareRestart {cancel}): the agent hears it at once, the record goes', () => {
  const { h, chat } = team('0.3.4', 4242);
  new KvRepo(h.db).set('system', 'install', { from: '0.3.4', installer, by: { agentId: 'ag_jonas', conversationId: chat.id, runId: 'run_9' }, pid: 4242, at: h.clock.now() }, 0);
  dropInstall(h.services);
  assert.deepEqual(notes(h), ['At 09:00 Autark still runs 0.3.4 – the install I started at 09:00 did not start.']);
  assert.equal(record(h), undefined);
  assert.equal(recordStart(h.services, { version: '0.3.4', interrupted: 0, continued: 0 }), undefined, 'nothing left for a later start');
});

test('a headless host, a missing file or a refusing host: no install, no record', async () => {
  const headless = harness();
  Object.assign(headless.services, { host: { app: { version: '0.3.4' } } });
  await assert.rejects(installBuild(headless.services, installer), (error: { code?: string }) => error.code === 'unavailable');
  const { h } = team('0.3.4');
  await assert.rejects(installBuild(h.services, path.join(dir, 'nope.exe')), (error: { code?: string }) => error.code === 'not_found');
  Object.assign(h.services.host, { install: async () => { throw new Error('main refused'); } });
  await assert.rejects(installBuild(h.services, installer), /main refused/);
  assert.equal(record(h), undefined);
});

test("a build's version comes from the latest.yml that names its file", () => {
  const build = path.join(dir, 'dist');
  mkdirSync(build, { recursive: true });
  const file = path.join(build, 'autark-windows-x64.exe');
  writeFileSync(file, 'MZ');
  assert.equal(buildVersion(file), undefined);
  writeFileSync(path.join(build, 'latest.yml'), "version: 0.3.5-local.3\nfiles:\n  - url: autark-windows-x64.exe\npath: autark-windows-x64.exe\nsha512: x\n");
  assert.equal(buildVersion(file), '0.3.5-local.3');
  writeFileSync(path.join(build, 'latest.yml'), 'version: 0.3.5\npath: other.exe\n');
  assert.equal(buildVersion(file), undefined, 'another file');
});

test('RPC system.install: owner only, the record without an agent, the host asked', async () => {
  const f = rpcFixture();
  try {
    const installs: string[] = [];
    Object.assign(f.services.host, { app: { version: '0.3.4' }, install: async (file: string) => { installs.push(file); } });
    const owner = new TestClient(f.server, OWNER);
    assert.deepEqual(await owner.call('system.install', { installer }), { ok: true, from: '0.3.4' });
    assert.deepEqual(installs, [installer]);
    assert.equal(record(f)?.by, undefined);
    await assert.rejects(new TestClient(f.server, PHONE).call('system.install', { installer }), 'a phone never installs on this PC');
  } finally { f.cleanup(); }
});
