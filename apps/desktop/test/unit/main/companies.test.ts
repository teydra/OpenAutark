// B-072 several companies on one PC, main's side (src/main/companies.ts): the folder rule (the first company is the app's
// own folder, the others "<first> Companies/<id>" beside it), the --company=<id> flag and its id check, the start
// arguments of each company, and the host op company.open on real temp folders with a fake spawn: a new company is a
// folder and then a start, the first company starts without the flag, the company that asks only shows its window,
// the switch sends the asking window to the tray. HostServices routes the op and says 'unavailable' without it. The
// start command (the AppImage on Linux), the wake after an update from run-state.json, and the emergency stop of the
// other companies against a local test server standing in for their runtimes. 16.11.2026: a company with the removal
// mark is neither opened, woken nor started, and a plain start with the first one removed opens the next one left.
// Owns: these assertions only. Never: starts a process or touches the real data folders.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  COMPANY_FLAG, appCommand, callCompany, companiesDir, companyArgs, companyDir, companyFlag, openCompany, remainingCompanies, startFlag, startingCompany, stopOtherCompanies, wakeCompanies,
  type CompanyOpenDeps,
} from '../../../src/main/companies.ts';
import { HostServices, type HostServicesDeps } from '../../../src/main/host-services.ts';
import { launchWindowsCompanies } from '../../../src/main/launcher-companies.ts';
import { writeRunState } from '../../../src/main/launcher.ts';
import { launcherArgs } from '../../../src/main/launcher-windows.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { nextCompanyId, REMOVED_FILE } from '../../../src/shared/model/companies.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-companies-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('the first company is the app folder; the others lie beside it in "<first> Companies/<id>"', () => {
  const first = path.join(tmp, 'Roaming', 'Autark');
  assert.equal(companiesDir(first), path.join(tmp, 'Roaming', 'Autark Companies'));
  assert.equal(companyDir(first, 'company-2'), path.join(tmp, 'Roaming', 'Autark Companies', 'company-2'));
  assert.ok(!companyDir(first, 'x').startsWith(`${first}${path.sep}`), 'never inside the first folder (its backup and watcher)');
});

test('--company=<id>: the last valid one counts; a bad id is no company (the first starts)', () => {
  assert.equal(companyFlag(['Autark.exe']), null);
  assert.equal(companyFlag(['Autark.exe', '--background', '--company=company-2']), 'company-2');
  assert.equal(companyFlag(['electron.exe', '.', '--company=a', '--company=b-3']), 'b-3');
  for (const bad of ['--company=', '--company=../x', '--company=..\\x', '--company=A', '--company=-x', `--company=${'a'.repeat(41)}`, '--company=a b', '--company']) {
    assert.equal(companyFlag(['Autark.exe', bad]), null, bad);
  }
  assert.equal(companyFlag(['Autark.exe', '--company=good', '--company=../bad']), 'good', 'a bad flag later does not undo a good one');
  assert.deepEqual(companyArgs(null), []);
  assert.deepEqual(companyArgs('company-2'), [`${COMPANY_FLAG}company-2`]);
  assert.deepEqual(launcherArgs(null), ['--background', '--launcher'], 'the first company starts exactly as before');
  assert.deepEqual(launcherArgs('company-2'), ['--background', '--launcher', '--company=company-2']);
});

test('ids of new companies: company-2, then the next free one', () => {
  assert.equal(nextCompanyId([]), 'company-2');
  assert.equal(nextCompanyId(['company-2', 'company-3', 'teydra']), 'company-4');
  assert.equal(nextCompanyId(['company-3']), 'company-2');
});

function bench(current: string | null, name: string) {
  const dir = path.join(tmp, name, 'Autark Companies');
  const calls: string[] = [];
  const deps: CompanyOpenDeps = {
    dir,
    current,
    spawn: (args) => { calls.push(`spawn ${args.join(' ')}`.trim()); },
    show: () => { calls.push('show'); },
    hide: () => { calls.push('hide'); },
  };
  return { dir, calls, deps };
}

test('company.open: a new company is a folder, then its start; this window goes to the tray', () => {
  const b = bench(null, 'create');
  assert.deepEqual(openCompany({ create: true }, b.deps), { ok: true, id: 'company-2' });
  assert.ok(existsSync(path.join(b.dir, 'company-2')), 'the folder exists before the start');
  assert.deepEqual(b.calls, ['spawn --company=company-2', 'hide']);
  assert.deepEqual(openCompany({ create: true }, b.deps), { ok: true, id: 'company-3' }, 'the next free id');
  assert.deepEqual(openCompany({ create: true, id: 'teydra' }, b.deps), { ok: true, id: 'teydra' }, 'with an id: that folder');
  assert.ok(existsSync(path.join(b.dir, 'teydra')));
});

test('B-078 company.open start: the company menu\'s "+" starts a new company with --start=join (Eine-ID: no role); startFlag reads it back', () => {
  const b = bench(null, 'start');
  const code = (fn: () => unknown) => { try { fn(); return 'none'; } catch (error) { return (error as WorkforceError).code; } };
  openCompany({ create: true, start: 'join' }, b.deps);
  openCompany({ create: true, start: 'new' }, b.deps);
  assert.deepEqual(b.calls.filter((call) => call.startsWith('spawn')), [
    'spawn --company=company-2 --start=join', 'spawn --company=company-3',
  ], "'new' is the plain first run");
  for (const old of ['boss', 'mine', 'employee']) assert.equal(code(() => openCompany({ create: true, start: old } as never, b.deps)), 'bad_request', old);
  assert.equal(startFlag(['app.exe', '--company=company-2', '--start=join']), 'join');
  assert.equal(startFlag(['app.exe', '--start=mine']), undefined, 'the old role starts are plain starts');
  assert.equal(startFlag(['app.exe', '--start=boss']), undefined, 'an unknown start is a plain start');
  assert.equal(startFlag(['app.exe']), undefined);
});

test('company.open: the first company starts without a flag, another by id; the asking company only shows itself', () => {
  const b = bench('company-2', 'switch');
  mkdirSync(path.join(b.dir, 'company-2'), { recursive: true });
  mkdirSync(path.join(b.dir, 'company-5'), { recursive: true });
  assert.deepEqual(openCompany({}, b.deps), { ok: true, id: null });
  assert.deepEqual(openCompany({ id: null }, b.deps), { ok: true, id: null });
  assert.deepEqual(openCompany({ id: 'company-5' }, b.deps), { ok: true, id: 'company-5' });
  assert.deepEqual(b.calls, ['spawn', 'hide', 'spawn', 'hide', 'spawn --company=company-5', 'hide']);
  b.calls.length = 0;
  assert.deepEqual(openCompany({ id: 'company-2' }, b.deps), { ok: true, id: 'company-2' });
  assert.deepEqual(b.calls, ['show'], 'no second start, nothing hidden');
  const first = bench(null, 'first');
  openCompany({}, first.deps);
  assert.deepEqual(first.calls, ['show']);
});

test('company.open: a bad or unknown id is refused before anything starts; a refused start keeps this window', () => {
  const b = bench(null, 'refused');
  const code = (fn: () => unknown) => { try { fn(); return 'none'; } catch (error) { return (error as WorkforceError).code; } };
  assert.equal(code(() => openCompany({ id: '../evil' }, b.deps)), 'bad_request');
  assert.equal(code(() => openCompany({ id: 'Company' }, b.deps)), 'bad_request');
  assert.equal(code(() => openCompany({ create: 'yes' } as never, b.deps)), 'bad_request');
  assert.equal(code(() => openCompany({ id: 'company-9' }, b.deps)), 'not_found');
  assert.deepEqual(b.calls, []);
  assert.ok(!existsSync(path.join(b.dir, '..', '..', 'evil')));
  const failing = bench(null, 'spawn-fails');
  failing.deps.spawn = () => { throw new Error('EACCES'); };
  assert.equal(code(() => openCompany({ create: true }, failing.deps)), 'unavailable');
  assert.deepEqual(failing.calls, [], 'the window stays when the start was refused');
});

test('HostServices routes company.open to main/companies.ts; without it (a test profile) it is unavailable', async () => {
  const seen: unknown[] = [];
  const deps = { openCompany: (args: unknown) => { seen.push(args); return { ok: true, id: 'company-2' }; } } as unknown as HostServicesDeps;
  const host = new HostServices(deps);
  assert.deepEqual(await host.handle({ id: 1, type: 'host', op: 'company.open', args: { create: true } }), { ok: true, id: 'company-2' });
  assert.deepEqual(seen, [{ create: true }]);
  const none = new HostServices({} as unknown as HostServicesDeps);
  await assert.rejects(none.handle({ id: 2, type: 'host', op: 'company.open', args: {} }), (error: WorkforceError) => error.code === 'unavailable');
});

test('a company starts from the same app: the AppImage itself on Linux, electron <app> in development', () => {
  assert.deepEqual(appCommand(['--company=c'], { execPath: 'C:/A/Autark.exe', argv: ['C:/A/Autark.exe', '--background'] }), ['C:/A/Autark.exe', ['--company=c']]);
  assert.deepEqual(appCommand(['--x'], { execPath: '/x/electron', defaultApp: true, argv: ['/x/electron', '/repo/app', '--y'] }), ['/x/electron', ['/repo/app', '--x']]);
  const mounted = { execPath: '/tmp/.mount_ab12/autark', appImage: '/home/ann/Autark.AppImage', argv: ['/tmp/.mount_ab12/autark'] };
  assert.deepEqual(appCommand(['--x'], mounted), ['/home/ann/Autark.AppImage', ['--x']], 'never the opener\'s own mount, which ends with it');
});

test('after an update the companies that were running start again in the background; one the person quit stays off', () => {
  const dir = path.join(tmp, 'wake', 'Autark Companies');
  const company = (id: string, state?: object) => {
    mkdirSync(path.join(dir, id), { recursive: true });
    if (state) writeFileSync(path.join(dir, id, 'run-state.json'), JSON.stringify(state));
  };
  company('company-2', { state: 'running', at: 1, pid: 7 });
  company('company-3', { state: 'quit', by: 'person', at: 1 });
  company('company-4');
  company('company-5', { state: 'running', at: 1 });
  company('company-6', { state: 'quit', by: 'launcher', at: 1, capped: 1 });
  company('Not An Id', { state: 'running', at: 1 });
  const first = path.join(tmp, 'wake', 'Autark');
  const started: string[][] = [];
  const woken = wakeCompanies({ first, dir }, null, (args) => { started.push(args); if (args[0] === '--company=company-5') throw new Error('EACCES'); });
  assert.deepEqual(woken.sort(), ['company-2', 'company-5'], 'a refused start does not stop the others');
  assert.deepEqual(started.sort(), [['--company=company-2', '--background'], ['--company=company-5', '--background']]);
  assert.deepEqual(wakeCompanies({ first: path.join(tmp, 'wake', 'gone'), dir: path.join(tmp, 'wake', 'missing') }, null, () => assert.fail('nothing to start')), []);

  // F25 (16.11.2026): company-2 pressed Update – its relaunch wakes the first company (it was running) and the others, never itself.
  mkdirSync(first, { recursive: true });
  writeFileSync(path.join(first, 'run-state.json'), JSON.stringify({ state: 'running', at: 1 }));
  const again: string[][] = [];
  assert.deepEqual(wakeCompanies({ first, dir }, 'company-2', (args) => { again.push(args); }), [null, 'company-5']);
  assert.deepEqual(again, [['--background'], ['--company=company-5', '--background']], 'the first company starts without a flag');
  writeFileSync(path.join(first, 'run-state.json'), JSON.stringify({ state: 'quit', by: 'person', at: 2 }));
  assert.deepEqual(wakeCompanies({ first, dir }, 'company-5', () => undefined), ['company-2'], 'a first company the person quit stays off');
});

test('16.11.2026 a removed company is never opened, woken or started; a plain start with the first one removed opens the next', () => {
  const first = path.join(tmp, 'gone', 'Autark');
  const dir = companiesDir(first);
  const companies = { first, dir };
  const mark = (folder: string) => { mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, REMOVED_FILE), '{"at":1}\n'); };
  for (const id of ['company-2', 'company-3', 'company-10']) mkdirSync(path.join(dir, id), { recursive: true });
  mkdirSync(first, { recursive: true });
  mkdirSync(path.join(dir, 'logins', 'claude'), { recursive: true }); // this PC's plan logins: never a company
  assert.deepEqual(remainingCompanies(companies), [null, 'company-2', 'company-3', 'company-10']);
  assert.equal(startingCompany(null, companies), null, 'a plain start: the first company');
  assert.equal(startingCompany('company-3', companies), 'company-3');
  assert.equal(startingCompany('company-9', companies), undefined, 'a flag whose folder is gone starts nothing (Electron would make it anew)');
  mark(path.join(dir, 'company-2'));
  assert.equal(startingCompany('company-2', companies), undefined, 'its own start at sign-in ends at once');
  assert.deepEqual(remainingCompanies(companies), [null, 'company-3', 'company-10']);
  const b = bench(null, 'unused');
  b.deps.dir = dir;
  assert.throws(() => openCompany({ id: 'company-2' }, b.deps), (error: WorkforceError) => error.code === 'not_found');
  assert.deepEqual(b.calls, []);
  writeFileSync(path.join(dir, 'company-2', 'run-state.json'), JSON.stringify({ state: 'running', at: 1 }));
  assert.deepEqual(wakeCompanies(companies, 'company-3', () => undefined), [], 'never woken after an update');
  mark(first);
  assert.equal(startingCompany(null, companies), 'company-3', 'the first one removed: a plain start opens the next one left');
  assert.deepEqual(remainingCompanies(companies), ['company-3', 'company-10']);
});

test('the emergency stop reaches every other running company through its runtime.json; never this one, a gone or a broken one', async () => {
  const seen: Array<{ url?: string; method?: string; auth?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      const failed = req.headers.authorization === 'Bearer tok-error';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(failed ? { id: 1, error: { code: 'forbidden', message: 'no' } } : { id: 1, result: { stopped: true } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const first = path.join(tmp, 'stop', 'Autark');
  const dir = companiesDir(first);
  const runtime = (folder: string, value: object | string) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'runtime.json'), typeof value === 'string' ? value : JSON.stringify(value));
  };
  try {
    runtime(first, { port, token: 'tok-first', pid: process.pid });
    runtime(path.join(dir, 'company-2'), { port, token: 'tok-own', pid: process.pid });
    runtime(path.join(dir, 'company-3'), { port, token: 'tok-3', pid: process.pid });
    runtime(path.join(dir, 'company-4'), { port, token: 'tok-gone', pid: 2147483647 }); // that runtime ended: its port may be anyone's now
    runtime(path.join(dir, 'company-5'), '{broken');
    runtime(path.join(dir, 'company-8'), { port: 70_000, token: 'tok-8', pid: process.pid });
    runtime(path.join(dir, 'company-9'), { port, token: 'tok\r\nX-Evil: 1', pid: process.pid });
    runtime(path.join(dir, 'Not An Id'), { port, token: 'tok-no-id', pid: process.pid });
    mkdirSync(path.join(dir, 'company-6'), { recursive: true }); // never started
    await stopOtherCompanies({ first, dir }, path.join(dir, 'company-2'));
    assert.deepEqual(seen.map((call) => call.auth).sort(), ['Bearer tok-3', 'Bearer tok-first']);
    for (const call of seen) {
      assert.equal(call.method, 'POST');
      assert.equal(call.url, '/rpc');
      assert.deepEqual(JSON.parse(call.body), { id: 1, method: 'work.stop' });
    }
    seen.length = 0;
    await stopOtherCompanies({ first, dir }, first);
    assert.deepEqual(seen.map((call) => call.auth).sort(), ['Bearer tok-3', 'Bearer tok-own'], 'from the first company: the others');
    runtime(path.join(dir, 'company-7'), { port, token: 'tok-error', pid: process.pid });
    assert.equal(await callCompany(path.join(dir, 'company-3'), 'work.stop'), true);
    assert.equal(await callCompany(path.join(dir, 'company-7'), 'work.stop'), false, 'an error answer is no stop');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await callCompany(path.join(dir, 'company-3'), 'work.stop'), false, 'nothing listens: false, no throw');
});

test('a Windows launcher recovers only opted-in profiles not yet started this boot, even with no own task', () => {
  const first = path.join(tmp, 'logon', 'Autark'), dir = companiesDir(first);
  function profile(folder: string, settings: string, state?: 'old-system-quit' | 'this-boot-quit') {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'settings.json'), settings);
    if (state) writeRunState(folder, { state: 'quit', by: state === 'old-system-quit' ? 'system' : 'person', at: state === 'old-system-quit' ? 500 : 1500 });
    return folder;
  }
  const on = '{/* comment */"preferences": {"openAtLogin": true,},}', off = '{"preferences": {"openAtLogin": false}}';
  profile(first, on, 'old-system-quit');
  profile(path.join(dir, 'company-2'), on, 'old-system-quit');
  profile(path.join(dir, 'company-3'), off, 'old-system-quit');
  profile(path.join(dir, 'company-4'), on, 'old-system-quit');
  profile(path.join(dir, 'company-5'), on, 'this-boot-quit');
  profile(path.join(dir, 'company-6'), '{"preferences": {"openAtLogin": "true"}}');
  profile(path.join(dir, 'company-7'), '{ malformed');
  const removed = profile(path.join(dir, 'company-8'), on);
  writeFileSync(path.join(removed, REMOVED_FILE), '');
  const calls: string[][] = [];
  assert.equal(launchWindowsCompanies({
    companies: { first, dir }, current: 'company-2', dataDir: path.join(dir, 'company-2'), bootAt: 1000,
    start: args => calls.push(args),
  }), true);
  assert.deepEqual(calls, [
    ['--background', '--launcher', '--launcher-peer'],
    ['--background', '--launcher', '--launcher-peer', '--company=company-4'],
  ]);
});

test('a company is the only start when First and all siblings opted out; isolated test profiles never start', () => {
  const first = path.join(tmp, 'single-logon', 'Autark'), dir = companiesDir(first), dataDir = path.join(dir, 'company-2');
  const later = path.join(dir, 'company-3');
  for (const folder of [first, dataDir, later]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(first, 'settings.json'), '{}'); // default First company: false
  writeFileSync(path.join(dataDir, 'settings.json'), '{"preferences": {"openAtLogin": true}}');
  writeFileSync(path.join(later, 'settings.json'), '{"preferences": {"openAtLogin": false}}');
  const calls: string[][] = [];
  const invokes = {
    current: 'company-2', dataDir, bootAt: 1000,
    start: (args: string[]) => calls.push(args),
  };
  assert.equal(launchWindowsCompanies({ ...invokes, companies: { first, dir } }), true);
  assert.equal(launchWindowsCompanies({ ...invokes, companies: null }), false, 'WORKFORCE_TEST_DATA cannot start despite its opted-in settings');
  assert.equal(launchWindowsCompanies({ ...invokes, current: null, dataDir: first, companies: { first, dir }, peer: true }), false, 'First also cannot be started by an old task');
  assert.deepEqual(calls, [], 'no extra processes started');
});
