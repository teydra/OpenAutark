// task_7ja3mcr6: the delete guard of shell.exec (files/shell-deletes.ts) – recursive deletes read as PowerShell, cmd.exe and
// sh read them, targets checked against the kept folders (files/delete-zones.ts). The incident line of 27.11.2026 is
// refused; the cleanups agents run every day pass. The pure readings use win32 and POSIX paths on any OS; the shell.exec
// runs at the end use a fake shell (and on Windows the real one) on throwaway folders with spaces.
// Owns: these assertions only. Never: deletes outside its own temp folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteZones, stripDevicePrefix } from '../../../src/runtime/files/delete-zones.ts';
import { recursiveDeletes, shellDeleteRefusal } from '../../../src/runtime/files/shell-deletes.ts';
import { fileTools, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const W_HOME = 'C:\\Users\\H';
const W_FIRST = `${W_HOME}\\AppData\\Roaming\\X`;
const W_DIR = `${W_FIRST} Companies`;
const W_DATA = `${W_DIR}\\company-2`;
const W_WS = `${W_DATA}\\workspace`;
const W_ENV = { APPDATA: `${W_HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${W_HOME}\\AppData\\Local` };
const winZones = deleteZones({ platform: 'win32', data: W_DATA, workspace: W_WS, temp: `${W_DATA}\\tmp`, companies: { first: W_FIRST, dir: W_DIR }, home: W_HOME, env: W_ENV, tmp: `${W_HOME}\\AppData\\Local\\Temp` });
const win = (command: string, cwd = W_WS) => shellDeleteRefusal(command, { platform: 'win32', cwd, env: W_ENV, home: W_HOME }, winZones);

const P_HOME = '/home/ada';
const P_FIRST = `${P_HOME}/.config/X`;
const P_DIR = `${P_FIRST} Companies`;
const P_DATA = `${P_DIR}/company-2`;
const P_WS = `${P_DATA}/workspace`;
const P_ENV = { HOME: P_HOME };
const posixZones = deleteZones({ platform: 'linux', data: P_DATA, workspace: P_WS, temp: `${P_DATA}/tmp`, companies: { first: P_FIRST, dir: P_DIR }, home: P_HOME, env: P_ENV, tmp: '/tmp' });
const posix = (command: string, cwd = P_WS) => shellDeleteRefusal(command, { platform: 'linux', cwd, env: P_ENV, home: P_HOME }, posixZones);

test('shell guard: the incident line of 27.11.2026 – cmd /c "rd /s /q <unquoted path with a space>" – is refused before it runs', () => {
  const line = `cmd /c "rd /s /q ${W_WS}\\old wt"`;
  const targets = recursiveDeletes(line, { platform: 'win32', cwd: W_WS, env: W_ENV, home: W_HOME }).map((hit) => hit.target);
  assert.deepEqual(targets, [W_FIRST, `${W_WS}\\Companies\\company-2\\workspace\\old`, `${W_WS}\\wt`], 'cmd splits the path at its spaces, as on 27.11.');
  const refused = win(line);
  assert.match(refused ?? '', /^BLOCKED – not executed\./);
  assert.match(refused ?? '', /X is the first company's data folder/);
  assert.match(refused ?? '', /unquoted path splits at its spaces/);
  assert.match(refused ?? '', /files\.delete/);
  assert.ok(win(`cmd /c rd /s /q ${W_WS}\\old wt`), 'unquoted in PowerShell too');
  assert.ok(win(`cmd.exe /d /c "cd /d ${W_WS} && rmdir /S /Q ${W_DIR}\\company-2\\workspace\\x"`), 'rmdir after cd /d, upper-case switches');
});

test('shell guard: the cleanups agents run pass – quoted rd, Remove-Item -Recurse in the workspace, a worktree, git', () => {
  for (const line of [
    `cmd /c rd /s /q "${W_WS}\\old wt"`,
    `Remove-Item -Recurse -Force -LiteralPath "${W_WS}\\delete-guard\\apps\\desktop\\node_modules"`,
    `Remove-Item -LiteralPath '${W_WS}\\a b\\dist' -Recurse -Force -ErrorAction SilentlyContinue`,
    `cd "${W_WS}\\delete-guard"; Remove-Item -Recurse -Force .\\dist, .\\out`,
    `Remove-Item -Recurse -Force "${W_WS}\\wt\\*"`,
    `Remove-Item -Recurse -Force "${W_DATA}\\tmp\\*"`,
    `git worktree remove "${W_WS}\\delete-guard"; git branch -D feature/x`,
    `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\Temp\\wf-test-123"`,
    `Remove-Item -Recurse ${W_FIRST} -WhatIf`,
    `Remove-Item ${W_FIRST}\\notes.txt`,
  ]) assert.equal(win(line), undefined, line);
});

test('shell guard: PowerShell forms that reach a kept folder are refused', () => {
  for (const line of [
    `Remove-Item -Recurse -Force $env:APPDATA\\X`,
    `rm -rf ${W_FIRST} Companies\\company-2\\workspace\\x`,
    `$p = '${W_FIRST}'; Remove-Item $p -Recurse -Force`,
    `$p='${W_DATA}'; ri -r -fo $p`,
    `cd "${W_WS}"; cd ..; Remove-Item -Recurse -Force .`,
    `cd "${W_WS}"; rd /s /q ..\\..\\company-2`,
    `Get-ChildItem ${W_FIRST} | Remove-Item -Recurse -Force`,
    `Get-ChildItem -Recurse "${W_DIR}" | Remove-Item -Force`,
    `Remove-Item -Recurse -Force "${W_WS}\\*"`,
    `cmd /c "rd /s /q "${W_WS}\\old wt""`, // PowerShell itself ends the argument at the space after "…\X", so cmd gets "…\X" as a target
    `Remove-Item -Recurse -Force ~\\AppData`,
    `pwsh -NoProfile -Command "Remove-Item -Recurse -Force '${W_FIRST}'"`,
    `powershell -NoProfile -EncodedCommand ${Buffer.from(`Remove-Item -Recurse -Force '${W_DATA}'`, 'utf16le').toString('base64')}`,
    `[IO.Directory]::Delete('${W_FIRST}', $true)`,
    `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default"`,
    `cmd /c "del /s /q %APPDATA%\\X\\*"`,
    `if (Test-Path x) { Remove-Item -Recurse -Force "${W_HOME}" }`,
  ]) assert.ok(win(line), line);
});

test('shell guard: sh forms on macOS and Linux – rm -rf, find -delete, bash -c – are read the same way', () => {
  for (const line of [
    `rm -rf ${P_DIR}/company-2/workspace/x`,
    `rm -r -- ~/.mozilla`,
    `sudo rm -Rf "${P_DATA}"`,
    `rm -rf ~/*`,
    `bash -c 'rm -rf "$HOME/.config/X"'`,
    `find ${P_FIRST} -name '*.log' -delete`,
    `D="${P_FIRST}"; rm -rf "$D"`,
  ]) assert.ok(posix(line), line);
  for (const line of [
    `rm -rf "${P_WS}/old wt"`,
    `cd ~/Workforce/wt && rm -rf node_modules dist`,
    `rm -rf ./build/*`,
    `rm -f ${P_FIRST}/notes.txt`,
    `echo "rm -rf ${P_FIRST}"`,
  ]) assert.equal(posix(line), undefined, line);
});

// ---- review of PR #49 (28.11.2026): the findings, one test each

const winWith = (existing: string[]) => (command: string, cwd = W_WS) => shellDeleteRefusal(command, { platform: 'win32', cwd, env: W_ENV, home: W_HOME, exists: (path) => existing.some((one) => one.toLowerCase() === path.toLowerCase()) }, winZones);
const W_TEMP = `${W_HOME}\\AppData\\Local\\Temp`;

test('M1: a `\\\\?\\` or `\\\\.\\` prefix is no wildcard – its target is checked as the plain path', () => {
  for (const line of [
    `Remove-Item -Recurse -Force "\\\\?\\${W_TEMP}\\wf-test 1"`,
    `Remove-Item -Recurse -Force -LiteralPath '\\\\?\\${W_WS}\\old wt'`,
    `Remove-Item -Recurse -Force \\\\?\\${W_TEMP}\\wf-test`,
    `Remove-Item -Recurse -Force -Path "\\\\.\\${W_WS}\\old wt"`,
    `cmd /c rd /s /q "\\\\?\\${W_WS}\\old wt"`,
    `cmd /c rd /s /q \\\\?\\${W_TEMP}\\wf-test`,
    `cmd /c del /s /q "\\\\?\\${W_WS}\\old wt\\*"`,
  ]) assert.equal(win(line), undefined, line);
  for (const line of [ // the prefix does not hide a kept folder, nor does a wildcard behind it
    `Remove-Item -Recurse -Force '\\\\?\\${W_FIRST}'`,
    `Remove-Item -Recurse -Force "\\\\?\\${W_WS}\\*"`,
    `cmd /c rd /s /q "\\\\?\\${W_DATA}"`,
    `cmd /c rd /s /q \\\\?\\${W_FIRST}`,
    `cmd /c rd /s /q \\\\.\\${W_FIRST}`,
  ]) assert.ok(win(line), line);
  assert.equal(stripDevicePrefix('\\\\?\\C:\\a b', 'win32'), 'C:\\a b');
  assert.equal(stripDevicePrefix('\\\\?\\UNC\\srv\\share\\x', 'win32'), '\\\\srv\\share\\x');
  assert.equal(stripDevicePrefix('\\\\.\\C:\\a', 'win32'), 'C:\\a');
  assert.equal(stripDevicePrefix('\\\\?\\a', 'linux'), '\\\\?\\a', 'only Windows reads it');
});

test('M2: `rd /s/q X`, `rd/s/q X` and `rmdir/S/Q X` are the same delete as `rd /s /q X`', () => {
  for (const line of [
    `cmd /c "rd /s/q ${W_FIRST}"`,
    `cmd /c "rd/s/q ${W_FIRST}"`,
    `cmd /c "RMDIR/S/Q ${W_DATA}"`,
    `cmd /c "rd /q/s ${W_FIRST}"`,
    `cmd /c "del/s/q ${W_FIRST}\\*"`,
    `cmd /c "cmd/c rd/s/q ${W_FIRST}"`,
    `cmd /c "cd /d ${W_WS}&&rd/s/q ..\\..\\company-2"`,
  ]) assert.ok(win(line), line);
  assert.equal(win(`cmd /c rd /s/q "${W_WS}\\old wt"`), undefined);
  assert.equal(win(`cmd /c rd/s/q "${W_WS}\\dist"`), undefined, 'the quoted target of the glued form passes');
  assert.ok(win(`cmd /c rd/s/q "${W_FIRST}"`), 'and a quoted kept folder does not');
  assert.equal(win(`cmd /c "rd/q ${W_FIRST}"`), undefined, 'no /s: not recursive');
});

test('M3: a recursive delete behind if exist / if not exist / if /i / errorlevel / defined / else / for … do is read', () => {
  for (const line of [
    `cmd /c "if exist ${W_FIRST} rd /s /q ${W_FIRST}"`,
    `cmd /c "if not exist ${W_WS}\\x echo no & if exist ${W_FIRST} rd /s /q ${W_FIRST}"`,
    `cmd /c "if not exist ${W_FIRST}\\x rd /s /q ${W_FIRST}"`,
    `cmd /c "if /i exist ${W_FIRST} rd /s /q ${W_FIRST}"`,
    `cmd /c "if errorlevel 1 rd /s /q ${W_FIRST}"`,
    `cmd /c "if defined FOO rd /s /q ${W_FIRST}"`,
    `cmd /c "if /i "%A%"=="b" rd /s /q ${W_FIRST}"`,
    `cmd /c "if 1 EQU 1 rd /s /q ${W_FIRST}"`,
    `cmd /c "if exist ${W_WS}\\x (echo a) else (rd /s /q ${W_FIRST})"`,
    `cmd /c "if exist ${W_WS}\\x (rd /s /q ${W_FIRST})"`,
    `cmd /c "@rd /s /q ${W_FIRST}"`,
    `cmd /c "call rd /s /q ${W_FIRST}"`,
    `cmd /c "for /d %i in (${W_FIRST}\\*) do rd /s /q "%i""`,
    `cmd /c "for /d %i in (${W_FIRST}) do rd /s /q %i"`,
    `cmd /c "for /d %i in (${W_WS}\\*) do (echo %i & rd /s /q "%i")"`,
    `cmd /c "for /r ${W_FIRST} %i in (*) do rd /s /q "%i""`,
    `cmd /c "for %%i in (${W_FIRST}) do rd /s /q %%i"`,
    `cmd /c "if exist ${W_FIRST} rd/s/q ${W_FIRST}"`, // glued switches behind a lead word (Felix's check before merge)
    `cmd /c if exist ${W_FIRST} rd/s/q ${W_FIRST}`,
    `cmd /c "for /d %i in (${W_FIRST}) do rd/s/q %i"`,
    `cmd /c "if exist ${W_FIRST} (echo a) else rmdir/s/q ${W_FIRST}"`,
  ]) assert.ok(win(line), line);
  for (const line of [
    `cmd /c "if exist ${W_WS}\\dist rd /s /q "${W_WS}\\dist""`,
    `cmd /c "if not exist ${W_WS}\\x echo none"`,
    `cmd /c "if errorlevel 1 echo failed"`,
    `cmd /c "for /d %i in ("${W_WS}\\old\\*") do rd /s /q "%i""`,
    `cmd /c "for /d %i in ("${W_WS}\\old wt") do rd /s /q "%i""`,
    `cmd /c "for /f %i in ('dir /b') do rd /s /q %i"`,
    `cmd /c "if exist ${W_WS}\\x (echo yes) else (echo no)"`,
    `cmd /c "if exist ${W_WS}\\dist rd/s/q ${W_WS}\\dist"`,
    `cmd /c "if exist ${W_WS}\\dist rd/q ${W_WS}\\dist"`,
  ]) assert.equal(win(line), undefined, line);
});

test('M4: an unquoted path with spaces in rd/rmdir/del /s is blocked when cmd would split it into wrong targets', () => {
  const real = `${W_HOME}\\Projekte\\Proactive Agent Workforce\\dist`;
  const check = winWith([real, `${W_HOME}\\Projekte\\Proactive Agent Workforce`]);
  const refused = check(`cmd /c "rd /s /q ${real}"`);
  assert.match(refused ?? '', /^BLOCKED – not executed\./);
  assert.match(refused ?? '', /3 targets/);
  assert.match(refused ?? '', /Write the path in quotes: rd \/s \/q "C:\\Users\\H\\Projekte\\Proactive Agent Workforce\\dist"/);
  assert.match(check(`cmd /c "rmdir /s /q ${W_HOME}\\Projekte\\Proactive Agent Workforce\\build"`) ?? '', /folder .* exists/, 'the folder of a target that is not there yet exists');
  assert.match(check(`cmd /c "del /s /q ${real}\\*.tmp"`) ?? '', /BLOCKED/);
  assert.match(check(`cmd /c "rd /s /q ${W_HOME}\\Projekte\\old wt"`) ?? '', /a relative word follows an absolute path/, 'nothing of it exists: a relative word after an absolute one');
  assert.match(check(`cmd /c "rd /s /q Proactive Agent Workforce\\dist"`, `${W_HOME}\\Projekte`) ?? '', /exists as one path/, 'relative from the current folder');
  for (const line of [ // separate targets and quoted paths pass
    `cmd /c rd /s /q "${real}"`,
    `cmd /c rd /s /q "${real}" "${W_WS}\\x y"`,
    `cmd /c "rd /s /q ${W_HOME}\\Projekte\\a ${W_HOME}\\Projekte\\b"`,
    `cmd /c "rd /s /q dist build"`,
    `cmd /c "rd /s /q out\\a out\\b"`,
    `cmd /c "rd /s /q "${W_HOME}\\Projekte\\a b" dist"`,
  ]) assert.equal(check(line, W_WS), undefined, line);
});

test('L2: -Path:\'x\' and -LiteralPath:"x" are the path x, not a relative `-Path:x`', () => {
  for (const line of [
    `Remove-Item -Recurse -Path:'${W_FIRST}'`,
    `Remove-Item -Recurse -LiteralPath:"${W_FIRST}"`,
    `Remove-Item -Recurse -Force -LiteralPath:'${W_DATA}'`,
    `Remove-Item -Path:"${W_FIRST}" -Recurse`,
    `ri -r -lp:'${W_FIRST}'`,
  ]) assert.ok(win(line), line);
  assert.equal(win(`Remove-Item -Recurse -LiteralPath:'${W_WS}\\a b\\dist' -Force`), undefined);
  assert.equal(win(`Remove-Item -Recurse -Path:"${W_WS}\\old\\*"`), undefined);
  assert.equal(win(`Remove-Item -Recurse -Force:$true -LiteralPath:'${W_WS}\\old'`), undefined);
});

test('L1: Where-Object / Select-Object between Get-ChildItem and Remove-Item keep the pipeline', () => {
  for (const line of [
    `Get-ChildItem ${W_FIRST} | Where-Object { $_.Name -like 'a*' } | Remove-Item -Recurse -Force`,
    `gci "${W_FIRST}" | ? { $_.Length -gt 5 } | ri -r -fo`,
    `Get-ChildItem "${W_FIRST}" | Sort-Object Name | Select-Object -First 3 | Remove-Item -Recurse`,
    `Get-ChildItem "${W_WS}\\*" | where { $_.PSIsContainer } | Remove-Item -Recurse -Force`,
  ]) assert.ok(win(line), line);
  assert.equal(win(`Get-ChildItem "${W_WS}\\old" | Where-Object { $_.Length -gt 5 } | Remove-Item -Recurse -Force`), undefined);
  assert.equal(win(`Get-ChildItem "${W_WS}\\old" -Filter *.log | Where-Object { $_.LastWriteTime -lt (Get-Date) } | Remove-Item`), undefined, 'not recursive');
});

test('L7: thousands of targets are not all followed through links; a kept one among them is still refused as written', () => {
  const many = Array.from({ length: 3800 }, (_x, i) => `"${W_TEMP}\\wf ${i}"`).join(' ');
  const started = Date.now();
  assert.equal(win(`Remove-Item -Recurse ${many}`), undefined);
  assert.match(win(`Remove-Item -Recurse ${many} "${W_FIRST}"`) ?? '', /first company's data folder/, 'the last one is checked as written');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

// ---- shell.exec itself: the guard runs before the shell starts

function world(t: { after(fn: () => void): void }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'wf-shell-guard-'))); // the space is in "X Companies"
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const first = path.join(base, 'X');
  const companies = path.join(base, 'X Companies');
  const workspace = path.join(companies, 'company-2', 'workspace');
  mkdirSync(first, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(first, 'sentinel.txt'), 'stays');
  const ctx = {
    agent: { id: 'ag_a', name: 'Ada' }, runId: 'r1', mode: 'general', signal: new AbortController().signal, status: () => undefined,
    services: { paths: { workspace, temp: path.join(companies, 'company-2', 'tmp') }, host: { app: { companies: { first, dir: companies }, packaged: false, executable: process.execPath, resourcesDir: base, dataDir: path.join(companies, 'company-2'), version: '0' } }, secrets: { redact: (value: string) => value } },
  } as unknown as ToolContext;
  return { base, first, workspace, ctx };
}

const textOf = (out: ToolOutput) => (out.content[0].type === 'text' ? out.content[0].text : '');

test('shell.exec: the incident line never reaches the shell; an allowed rd/Remove-Item line does', async (t) => {
  const w = world(t);
  const ran: string[] = [];
  const shell: ShellSpawn = (command) => {
    ran.push(command);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: null, kill: () => true });
    setImmediate(() => child.emit('close', 0));
    return child as unknown as ReturnType<ShellSpawn>;
  };
  const exec = fileTools({ shell }).find((tool) => tool.name === 'shell.exec')!;
  const win32 = process.platform === 'win32';
  const incident = win32 ? `cmd /c "rd /s /q ${w.workspace}\\old wt"` : `rm -rf ${w.workspace}/old wt`;
  const blocked = await exec.run({ command: incident }, w.ctx);
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /^BLOCKED – not executed\./);
  assert.deepEqual(ran, [], 'the shell never started');
  const allowed = win32 ? `cmd /c rd /s /q "${w.workspace}\\old wt"; Remove-Item -Recurse -Force -LiteralPath "${w.workspace}\\dist"` : `rm -rf "${w.workspace}/old wt" "${w.workspace}/dist"`;
  const passed = await exec.run({ command: allowed }, w.ctx);
  assert.notEqual(passed.isError, true, textOf(passed));
  assert.deepEqual(ran, [allowed]);
});

test('L6: when the zones cannot be known, shell.exec runs the command as before (fail open) instead of failing', async (t) => {
  const w = world(t);
  const ran: string[] = [];
  const shell: ShellSpawn = (command) => {
    ran.push(command);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: null, kill: () => true });
    setImmediate(() => child.emit('close', 0));
    return child as unknown as ReturnType<ShellSpawn>;
  };
  const exec = fileTools({ shell }).find((tool) => tool.name === 'shell.exec')!;
  const broken = { ...w.ctx, services: { ...w.ctx.services, paths: { ...w.ctx.services.paths, accounts: 5 } } } as unknown as ToolContext; // path.resolve(5) throws inside deleteZones
  const out = await exec.run({ command: 'echo hello' }, broken);
  assert.notEqual(out.isError, true, textOf(out));
  assert.deepEqual(ran, ['echo hello']);
});

test('shell.exec on Windows, real shell: the quoted rd deletes the worktree; the incident line leaves the bait whole', { skip: process.platform !== 'win32' }, async (t) => {
  const w = world(t);
  const exec = fileTools().find((tool) => tool.name === 'shell.exec')!;
  const tree = path.join(w.workspace, 'old wt');
  mkdirSync(path.join(tree, 'node_modules', 'a b'), { recursive: true });
  writeFileSync(path.join(tree, 'node_modules', 'a b', 'f.txt'), 'x');
  const blocked = await exec.run({ command: `cmd /c "rd /s /q ${tree}"` }, w.ctx);
  assert.match(textOf(blocked), /^BLOCKED/);
  assert.equal(readFileSync(path.join(w.first, 'sentinel.txt'), 'utf8'), 'stays');
  assert.ok(existsSync(tree));
  const done = await exec.run({ command: `cmd /c rd /s /q "${tree}"` }, w.ctx);
  assert.notEqual(done.isError, true, textOf(done));
  assert.ok(!existsSync(tree), 'the quoted rd ran and deleted the worktree');
  assert.equal(readFileSync(path.join(w.first, 'sentinel.txt'), 'utf8'), 'stays');
});
