// The PC of the Simulator run (.github/workflows/ios-e2e.yml): the REAL headless runtime of apps/desktop (app/runtime-cli.mjs with the
// deterministic fake engine – a chat gets an "Echo: …" answer without a real model) and the REAL meeting server (services/remote-relay),
// both started the way apps/desktop/test/e2e/hosted-iphone.test.mjs starts them for the web phone. Nothing under apps/desktop is changed:
// the harness only imports its test helper and talks to the runtime over its RPC (the person token printed by runtime-cli).
//
// usage: node e2e-pc.mjs <checkout-root> <out-dir>
//   <checkout-root> holds apps/desktop (built: `node scripts/build.mjs --only cli,ui`, npm ci) and services/remote-relay (npm ci).
//   <out-dir>/pc.json   is written once the PC is ready: {relay, remoteId, chatId, chatTitle, runtimePort}
//   <out-dir>/pc.log    gets one JSON line per event (request accepted, phone listed, new chat messages, …)
//   <out-dir>/send.txt  when it appears, its text is sent into the chat as the person (a fallback when the phone does not type itself)
//   <out-dir>/stop      when it appears (or on SIGTERM), everything is stopped and the data folder removed.
// The PC accepts every connect request of role 'phone' (the person's "Yes, add") – this is a throw-away PC of one CI run.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] ?? '');
const out = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) { console.error('usage: node e2e-pc.mjs <checkout-root> <out-dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const logFile = path.join(out, 'pc.log');
const say = (event, data = {}) => { const line = JSON.stringify({ at: new Date().toISOString().slice(11, 23), event, ...data }); appendFileSync(logFile, line + '\n'); console.log(line); };

const desktop = path.join(root, 'apps', 'desktop');
const { startRuntime } = await import(pathToFileURL(path.join(desktop, 'test', 'e2e', 'lib', 'runtime-client.mjs')).href);

// ---- the meeting server (real)
const relayDir = path.join(root, 'services', 'remote-relay');
const relayChild = spawn(process.execPath, [path.join(relayDir, 'src', 'main.ts')], { cwd: relayDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' } });
let relayOut = '';
const relayPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`the meeting server did not start\n${relayOut}`)), 30_000);
  relayChild.stdout.on('data', (chunk) => { relayOut += chunk; const line = relayOut.split('\n').find((entry) => entry.includes('meeting server listening')); if (line) { clearTimeout(timer); resolve(JSON.parse(line).port); } });
  relayChild.stderr.on('data', (chunk) => { relayOut += chunk; });
  relayChild.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the meeting server exited (${code})\n${relayOut}`)); });
});
const relayUrl = `ws://127.0.0.1:${relayPort}`;
say('relay', { url: relayUrl });

// ---- the PC (real headless runtime, fake engine)
const runtime = await startRuntime({ appRoot: desktop });
const owner = runtime.client;
say('runtime', { port: runtime.port });
await owner.call('settings.update', { devices: { relay: relayUrl } });
// Konrad #123 (24.11.2026): the phone names the PC by the name it carries in Autark (Settings › Devices), which is what
// remote1 sends (mesh.selfInfo → the device row). A fresh PC's row falls back to os.hostname() – on a macOS runner a raw
// "iad20-gt1022-….local" – so this throw-away PC gets a name the way the person gives one, through devices.rename.
const pcName = process.env.AUTARK_E2E_PC_NAME ?? 'Studio-PC';
try {
  const selfDevice = (await owner.call('devices.list')).find((device) => device.self);
  if (selfDevice) { await owner.call('devices.rename', { id: selfDevice.id, name: pcName }); say('named', { name: pcName, was: selfDevice.name }); }
  else say('named', { error: 'no self row in devices.list' });
} catch (error) { say('named', { error: String(error?.message ?? error) }); } // a run without the name still proves pairing
const until = async (read, what, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
await until(async () => (await owner.call('remote.relay')).status === 'connected', 'the PC at the meeting server');
const state = await owner.call('remote.state');
const remoteId = String(state.self.remoteId).replace(/\D/g, '');
const agent = (await owner.call('agents.list'))[0];
const chat = await owner.call('chats.create', { title: 'Vom iPhone', agentIds: [agent.id] });
writeFileSync(path.join(out, 'pc.json'), JSON.stringify({ relay: relayUrl, remoteId, chatId: chat.id, chatTitle: 'Vom iPhone', runtimePort: runtime.port }));
say('ready', { remoteId, chat: chat.id, agent: agent.name ?? agent.id });

let stopping = false;
const finish = async (why) => {
  if (stopping) return;
  stopping = true;
  say('stopping', { why });
  try { await runtime.stop(); } catch { /* gone */ }
  relayChild.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGTERM', () => void finish('SIGTERM'));
process.on('SIGINT', () => void finish('SIGINT'));
const deadline = Date.now() + 25 * 60_000;

const seen = new Set();
const answered = new Set();
let sent = false;
while (!stopping) {
  if (existsSync(path.join(out, 'stop'))) { await finish('stop file'); break; }
  if (Date.now() > deadline) { await finish('25 minutes are over'); break; }
  try {
    const now = await owner.call('remote.state');
    for (const request of now.incoming ?? []) {
      if (answered.has(request.id)) continue;
      answered.add(request.id);
      say('request', { id: request.id, role: request.role, name: request.name, code: request.code });
      if (request.role === 'phone') {
        // AUTARK_E2E_ACCEPT_AFTER_MS: the phone's wait level ("Accept on … if it shows the same code") stays up long enough to be photographed
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.AUTARK_E2E_ACCEPT_AFTER_MS ?? 0)));
        await owner.call('remote.decide', { id: request.id, accept: true });
        say('accepted', { id: request.id });
      }
    }
    const phones = (await owner.call('devices.list')).filter((device) => device.kind === 'phone');
    if (phones.length && !seen.has('phone')) { seen.add('phone'); say('phone-listed', { count: phones.length, names: phones.map((device) => device.name) }); }
    const messages = await owner.call('messages.list', { conversationId: chat.id, limit: 30 });
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      say('message', { id: message.id, author: message.authorId === agent.id ? 'agent' : message.authorKind ?? message.authorId, state: message.state, body: String(message.body).slice(0, 120) });
    }
    const sendFile = path.join(out, 'send.txt');
    if (!sent && existsSync(sendFile)) {
      sent = true;
      const body = readFileSync(sendFile, 'utf8').trim();
      await owner.call('messages.send', { conversationId: chat.id, body, clientId: 'e2e-send' });
      say('sent', { body });
    }
  } catch (error) { say('poll-error', { error: String(error?.message ?? error) }); }
  await new Promise((resolve) => setTimeout(resolve, 400));
}
try { rmSync(runtime.dataDir, { recursive: true, force: true }); } catch { /* the runtime's stop() does it too */ }
