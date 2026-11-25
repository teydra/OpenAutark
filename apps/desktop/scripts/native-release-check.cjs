// Owns: native packaged-runtime and window checks on disposable CI hosts.
// Never: uses real providers, installs an app or disables the renderer sandbox.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { _electron: electron } = require('playwright-core');
const root = process.cwd();
const version = require(path.join(root, 'package.json')).version;
// electron-builder 26: productName on Windows and macOS, the package name "autark" lower-cased on Linux.
const names = {
  win32: 'dist/win-unpacked/Autark.exe',
  darwin: 'dist/mac-universal/Autark.app/Contents/MacOS/Autark',
  linux: 'dist/linux-unpacked/autark',
};
const exe = path.resolve(names[process.platform]);
const resources = path.join(path.dirname(exe), ...(process.platform === 'darwin' ? ['..', 'Resources'] : ['resources']));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'XAUTHORITY' || !/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|ACTIONS_|GITHUB_|API_KEY/iu.test(key)));
delete env.ELECTRON_RUN_AS_NODE;
const result = { platform: process.platform, architecture: process.arch, version };
const data = awaitRoot();

async function awaitRoot() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'workforce-native-release-'));
  await fs.mkdir('test-results', { recursive: true });
  return profile;
}

async function main() {
  const profile = await data;
  const probe = `const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path'); const {createRequire}=require('node:module');
    const resources=${JSON.stringify(resources)}; const nested=path.join(resources,'app-'+process.arch+'.asar'); const archive=fs.existsSync(nested)?nested:path.join(resources,'app.asar');
    const req=createRequire(path.join(archive,'package.json')); assert.equal(req('./package.json').version,${JSON.stringify(version)});
    const db=new(require('node:sqlite').DatabaseSync)(':memory:'); assert.equal(db.prepare('select 42 as n').get().n,42); db.close();
    assert.ok(Object.keys(req('sherpa-onnx-node')).length); console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,sqlite:true,speechAddon:true,archive}));`;
  const native = spawnSync(exe, ['--eval', probe], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(native.status, 0, native.stderr);
  const info = JSON.parse(native.stdout.trim());
  result.native = { ...info, archive: path.basename(info.archive) };
  const asar = require('@electron/asar');
  assert.ok(!asar.listPackage(info.archive).some(file => /^\/(?:src|test|\.git|\.github)(?:\/|$)/u.test(file.replaceAll('\\', '/'))));
  let verified = 0;
  for (const file of await fs.readdir('app', { recursive: true })) {
    const original = path.join('app', file);
    if (!(await fs.stat(original)).isFile()) continue;
    assert.deepEqual(asar.extractFile(info.archive, original), await fs.readFile(original), original);
    verified++;
  }
  result.verifiedBuildFiles = verified;
  const runtime = spawn(exe, [path.join(info.archive, 'app/runtime-cli.mjs'), '--data', path.join(profile, 'runtime'), '--resources', path.join(info.archive, 'resources'), '--ui', path.join(info.archive, 'app/ui'), '--port', '0', '--fake'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const connection = await new Promise((resolve, reject) => {
      let output = ''; let errors = '';
      const timer = setTimeout(() => reject(new Error(`Runtime startup timeout: ${errors.slice(-2000)}`)), 60000);
      runtime.stderr.on('data', part => { errors += part; });
      runtime.stdout.on('data', part => { output += part; const line = output.split('\n').find(line => line.startsWith('{')); if (line) { clearTimeout(timer); resolve(JSON.parse(line)); } });
      runtime.once('exit', code => { clearTimeout(timer); reject(new Error(`Runtime exited ${code}: ${errors.slice(-2000)}`)); });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${connection.port}/ws`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ protocol: 1, token: connection.token, client: 'cli' }));
    const pending = new Map(); let id = 0; let final;
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      if ((message.event === 'message.created' || message.event === 'message.updated') && message.data?.state === 'final' && /Echo:.*native release check/u.test(message.data.body)) final?.(message.data);
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; const timer = setTimeout(() => { pending.delete(next); reject(new Error(`RPC timeout: ${method}`)); }, 30000); pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); ws.send(JSON.stringify({ id: next, method, params })); });
    try {
      assert.equal((await call('system.info')).version, version);
      const agents = await call('agents.list');
      const manager = agents.find(agent => agent.template === 'manager') ?? agents[0];
      assert.ok(manager);
      const chat = await call('chats.create', { title: 'Native release check', agentIds: [manager.id] });
      await call('events.subscribe', { topics: [`chat:${chat.id}`] });
      const answer = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Demo chat reply timeout')), 30000); final = value => { clearTimeout(timer); resolve(value); }; });
      await call('messages.send', { conversationId: chat.id, body: 'native release check' });
      await answer;
      result.packagedRuntime = { version: true, rpc: true, demoChat: true };
    } finally { ws.close(); }
  } finally {
    runtime.kill();
    await new Promise(resolve => { if (runtime.exitCode !== null) resolve(); else runtime.once('exit', resolve); setTimeout(resolve, 10000).unref(); });
  }
  const app = await electron.launch({ executablePath: exe, args: [], cwd: root, chromiumSandbox: true, timeout: 120000, env: { ...env, WORKFORCE_TEST_DATA: path.join(profile, 'desktop'), WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' } });
  try {
    const page = await app.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.locator('.shell').waitFor({ timeout: 90000 });
      await page.locator('.first-run-view').waitFor({ timeout: 90000 });
    } catch (error) {
      const diagnostics = { message: error.message, url: page.url(), body: await page.locator('body').innerText().catch(() => ''), errors };
      diagnostics.windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ url: win.webContents.getURL(), visible: win.isVisible() })));
      diagnostics.secureStorage = await app.evaluate(({ app, safeStorage }) => ({ ready: app.isReady(), available: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend?.() ?? 'platform' }));
      diagnostics.logs = [];
      for (const name of await fs.readdir(path.join(profile, 'desktop/logs')).catch(() => [])) {
        if (!name.endsWith('.log')) continue;
        const lines = (await fs.readFile(path.join(profile, 'desktop/logs', name), 'utf8')).split('\n').filter(Boolean).slice(-30);
        diagnostics.logs.push({ file: name, entries: lines.map(line => { try { const row = JSON.parse(line); return { level: row.level, message: row.msg, error: typeof row.data?.error === 'string' ? row.data.error.slice(0, 2000) : undefined }; } catch { return { message: line.slice(0, 1000) }; } }) });
      }
      await page.screenshot({ path: `test-results/native-${process.platform}-failure.png` }).catch(() => {});
      await fs.writeFile(`test-results/native-${process.platform}-failure.json`, JSON.stringify(diagnostics, null, 2));
      console.log(JSON.stringify(diagnostics));
      throw error;
    }
    const facts = await app.evaluate(({ app, BrowserWindow }) => { const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return { version: app.getVersion(), packaged: app.isPackaged, sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration }; });
    assert.deepEqual(facts, { version, packaged: true, sandbox: true, contextIsolation: true, nodeIntegration: false });
    assert.deepEqual(errors, []);
    result.secureStorage = await app.evaluate(({ safeStorage }) => ({ available: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend?.() ?? 'platform' }));
    assert.equal(result.secureStorage.available, true);
    if (process.platform === 'linux') assert.notEqual(result.secureStorage.backend, 'basic_text');
    await page.screenshot({ path: `test-results/native-${process.platform}.png` });
    result.window = { ...facts, firstRunVisible: true, rendererErrors: errors };
  } finally { await app.close(); }
  await fs.writeFile(`test-results/native-${process.platform}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
