// Measures the app's memory per process in a fresh test profile (demo engine, nothing touches the person's data):
// boots the built app, finishes onboarding, chats once, opens Team, Tasks and Settings, back to the chat,
// waits idle and prints each process's private memory (what Task Manager counts) and working set, the window's JS
// heap and the runtime's heap; then the same with the window minimized.
// Run (after npm run build): node scripts/measure-memory.mjs [--idle <seconds>] [--json <file>] [--flags "<switches>"]
// Owns: nothing in the app. Never: runs against the person's profile.

import { testNetworkEnv } from './test-network-env.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../test/e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const idleMs = Number(arg('--idle', '45')) * 1000;
const jsonOut = arg('--json', '');
/** --flags "--a --b": extra Electron/Chromium switches for an experiment. */
const flags = arg('--flags', '').split(' ').filter(Boolean);

const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-mem-'));
const app = await electron.launch({
  executablePath: electronPath, args: [root, ...flags], cwd: root, timeout: 90_000,
  env: testNetworkEnv(profile, { WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' }),
});
let rpc;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.shell', { timeout: 90_000 });
  await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(1280, 820); win.center(); });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const { conversationId } = await rpc.call('onboarding.start');
  await page.locator('.first-run-view').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => undefined);
  const go = async (hash) => { await page.evaluate((value) => { location.hash = value; }, hash); await page.waitForTimeout(1500); };
  await go(`#/chat/${encodeURIComponent(conversationId)}`);
  const composer = page.locator('textarea').first();
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await composer.fill('Hello from the memory measurement');
  await page.locator('button.send-button').first().click();
  await page.getByText(/Echo: .*memory measurement/).first().waitFor({ timeout: 90_000 });
  for (const hash of ['#/team', '#/tasks', '#/settings']) await go(hash);
  await go(`#/chat/${encodeURIComponent(conversationId)}`);

  const sample = async (label) => {
    const processes = await app.evaluate(({ app: electronApp, webContents }) => {
      const owners = new Map();
      for (const contents of webContents.getAllWebContents()) {
        const pid = contents.getOSProcessId();
        owners.set(pid, [...(owners.get(pid) ?? []), `${contents.getType()} ${contents.getURL().slice(0, 60)}`]);
      }
      return electronApp.getAppMetrics().map((metric) => ({
        pid: metric.pid, type: metric.type, name: metric.serviceName ?? metric.name ?? '',
        privateMb: Math.round((metric.memory.privateBytes ?? 0) / 1024), workingSetMb: Math.round(metric.memory.workingSetSize / 1024),
        what: (owners.get(metric.pid) ?? []).join(' | '),
      }));
    });
    const windowHeap = await page.evaluate(() => { const memory = performance.memory; return memory ? { usedMb: Math.round(memory.usedJSHeapSize / 1048576), totalMb: Math.round(memory.totalJSHeapSize / 1048576) } : null; });
    const runtime = (await rpc.call('system.resources')).runtime;
    const total = processes.reduce((sum, entry) => sum + entry.privateMb, 0);
    console.log(`\n== ${label}: ${total} MB private in ${processes.length} processes`);
    for (const entry of processes) console.log(`${String(entry.privateMb).padStart(5)} MB private ${String(entry.workingSetMb).padStart(5)} MB ws  ${entry.type.padEnd(8)} ${entry.name.padEnd(28)} ${entry.what}`);
    console.log(`window JS heap ${JSON.stringify(windowHeap)} · runtime ${JSON.stringify({ rss: runtime.rssMb, heapUsed: runtime.heapUsedMb, heapTotal: runtime.heapTotalMb, external: runtime.externalMb })}`);
    return { label, total, processes, windowHeap, runtime };
  };

  await page.waitForTimeout(idleMs);
  const open = await sample(`window open, idle ${idleMs / 1000} s`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await page.waitForTimeout(idleMs);
  const minimized = await sample(`window minimized, idle ${idleMs / 1000} s`);
  if (jsonOut) await writeFile(jsonOut, JSON.stringify({ open, minimized }, null, 2));
} finally {
  rpc?.close?.();
  await app.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
}
