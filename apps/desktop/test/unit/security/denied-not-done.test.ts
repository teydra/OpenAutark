// 25.11.2026 (Andrea Griffiths' test of OpenAutark in a throwaway VM): she declined a command and the agent still said it
// was done. A refused step – declined by the person, closed by the policy, still waiting, or not checkable – must reach
// the model as unmistakably not executed, in every engine, and show in the chat as blocked:
// - the gate's texts start with BLOCKED and say never to report it as done (security/service.ts);
// - Claude Code: the deny message is that text (engines/claude/permissions.ts), also when the gate fails;
// - Codex: its decline carries no words of ours, so the text is steered into the running turn (codex/turn.ts, approvals.ts);
// - ACP: the protocol's reject carries no text either – the chat line and the prompt's rule carry it (agreements.ts);
// - a declined or closed step leaves a quiet "Blocked: …" line in the chat it was asked from.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agent, harness } from '../chat/harness.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { BLOCKED, declinedText, Security } from '../../../src/runtime/security/service.ts';
import { agreementsSection, blockedRule } from '../../../src/runtime/security/agreements.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { hostRequests, secureTurn } from '../../../src/runtime/engines/claude/permissions.ts';
import { GATE_FAILED } from '../../../src/runtime/engines/codex/native-gate.ts';
import { CodexGate, refusalSteer } from '../../../src/runtime/engines/codex/approvals.ts';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { acpAllowed } from '../../../src/runtime/engines/acp/permissions.ts';
import { permissionOutcome } from '../../../src/runtime/engines/acp/updates.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput } from '../engines/fakes.ts';
import { fakeSecurity } from '../engines/security-fake.ts';

const root = path.resolve('denied-root');

function setup(security: Partial<SecuritySettings> = {}, waitMs = 5_000) {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  settings.update({ profile: { name: 'Mia' }, security: { ...securityDefaults('secure'), ...security } } as never);
  const services = h.services as RuntimeServices;
  services.settings = settings;
  services.paths = { data: path.join(root, 'data'), workspace: path.join(root, 'Workforce'), resources: path.join(root, 'res'), temp: path.join(root, 'data', 'tmp') } as RuntimeServices['paths'];
  h.org.add(agent('ag_tom', 'Tom'));
  const sec = new Security({ services: () => services, waitMs });
  services.security = sec;
  return { ...h, settings, sec, services };
}

const req = (extra: Partial<Parameters<Security['gate']>[0]> = {}) => ({ agentId: 'ag_tom', capability: 'commands' as const, summary: 'Run: cat ~/.ssh/id_ed25519', fingerprint: 'fp_1', ...extra });

/** The quiet "Blocked" lines of a chat. */
function blockedLines(h: ReturnType<typeof setup>, chatId: string): string[] {
  return h.db.all<{ body: string; kind: string }>('SELECT body, kind FROM messages WHERE conversation_id = ?', [chatId]).filter((m) => m.kind === 'status' && m.body.startsWith('Blocked:')).map((m) => m.body);
}

const isBlocked = (text: string) => {
  assert.ok(text.startsWith(BLOCKED), `starts with ${BLOCKED}: ${text}`);
  assert.match(text, /must not report it, or the work that needed it, as done|never report it as done/);
};

test('service: a declined step reaches the agent as BLOCKED – not done – and stands as "Blocked" in its chat', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const pending = h.sec.gate(req({ chatId: chat.id }));
  h.sec.answer(h.sec.requests()[0].id, 'decline');
  const result = await pending;
  assert.equal(result.ok, false);
  const text = (result as { text: string }).text;
  isBlocked(text);
  assert.match(text, /Mia declined "Run: cat ~\/\.ssh\/id_ed25519"/);
  assert.doesNotMatch(text, /leave this part out/, 'the old wording that let the agent skip it silently');
  assert.deepEqual(blockedLines(h, chat.id), ['Blocked: Tom – "Run: cat ~/.ssh/id_ed25519" did not run (Mia declined it).']);
});

test('service: a late decline wakes the agent with the same BLOCKED text; the waiting text says it is not done', async () => {
  const h = setup({}, 10);
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const waited = await h.sec.gate(req({ chatId: chat.id }));
  isBlocked((waited as { text: string }).text);
  assert.match((waited as { text: string }).text, /has not answered yet/);
  h.sec.answer(h.sec.requests()[0].id, 'decline');
  const rows = h.wakeRows();
  assert.equal(rows.length, 1);
  assert.ok(JSON.stringify(rows[0]).includes(BLOCKED), 'the wake note starts with BLOCKED');
  assert.equal(blockedLines(h, chat.id).length, 1);
});

test('service: a step closed for good (money in Secure mode) is BLOCKED and shows in the chat', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const result = await h.sec.gate(req({ capability: 'money', summary: 'Pay 20 € at shop.example', chatId: chat.id }));
  isBlocked((result as { text: string }).text);
  assert.deepEqual(blockedLines(h, chat.id), [`Blocked: Tom – "Pay 20 € at shop.example" did not run (Spending money is closed on this PC).`]);
});

test('claude: a declined native step is denied with the BLOCKED text; a failing gate too', async () => {
  const fake = fakeSecurity({ gate: () => ({ ok: false, text: declinedText('Run: rm -rf build', 'Mia') }) });
  const turn = secureTurn(fake.service, { agentId: 'ag_1', runId: 'run_1' });
  const answer = await turn.answer({ tool_name: 'Bash', input: { command: 'rm -rf build' } }, new AbortController().signal);
  assert.equal(answer.behavior, 'deny');
  isBlocked(String(answer.message));
  // the gate itself throws: the CLI still hears BLOCKED, not a bare "could not check"
  const written: string[] = [];
  const broken = { ...turn, answer: () => Promise.reject(new Error('boom')) };
  hostRequests((line) => { written.push(line); return true; }, broken, new AbortController().signal)({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  const response = JSON.parse(written[0]!).response.response;
  assert.deepEqual(response, { behavior: 'deny', message: GATE_FAILED });
  isBlocked(GATE_FAILED);
});

test('codex: CodexGate.decide declines and returns the gate text for the model', async () => {
  const fake = fakeSecurity({ gate: () => ({ ok: false, text: declinedText('Run: npm publish', 'Mia') }) });
  const gate = new CodexGate(fake.service, { agentId: 'ag_1' }, 'ask', new AbortController().signal);
  const { response, refused } = await gate.decide('item/commandExecution/requestApproval', { command: 'npm publish', cwd: '/work' });
  assert.deepEqual(response, { decision: 'decline' });
  isBlocked(refused!);
  const allowed = await new CodexGate(fakeSecurity({ gate: () => ({ ok: true }) }).service, { agentId: 'ag_1' }, 'ask', new AbortController().signal).decide('execCommandApproval', { command: ['ls'] });
  assert.deepEqual(allowed, { response: { decision: 'approved' } }, 'an allowed step carries no refusal');
  const unknown = await gate.decide('item/somethingNew/requestApproval', {});
  isBlocked(unknown.refused!);
});

test('codex: in a running turn a declined command steers the BLOCKED text in before Codex hears "decline"', async () => {
  const requests: any[] = [];
  const replies = new Map<number, any>();
  const order: string[] = [];
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id !== undefined && !msg.method) {
        replies.set(msg.id, msg.result);
        order.push(`reply:${msg.id}`);
        child.send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
        return;
      }
      requests.push(msg);
      if (msg.method === 'turn/steer') order.push('steer');
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        setImmediate(() => child.send({ id: 902, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'c1', startedAtMs: 1, command: 'npm publish', cwd: '/work' } }));
      } else if (msg.method === 'turn/steer') child.send({ id: msg.id, result: { turnId: 'turn_1' } });
      else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  const text = declinedText('Run: npm publish', 'Mia');
  const fake = fakeSecurity({ gate: () => ({ ok: false, text }) });
  const e = new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', realpath: async (dir) => dir, security: fake.lookup });
  const result = await e.run(turnInput().input);
  await e.dispose();
  assert.equal(result.stop, 'done');
  assert.deepEqual(replies.get(902), { decision: 'decline' });
  const steer = requests.find((r) => r.method === 'turn/steer');
  assert.ok(steer, 'the refusal is steered into the turn');
  assert.deepEqual(steer.params, { threadId: 'thr_1', expectedTurnId: 'turn_1', input: refusalSteer(text) });
  assert.match(steer.params.input[0].text, /not a message from the person/);
  assert.deepEqual(order, ['steer', 'reply:902'], 'the model has the reason before Codex goes on');
});

test('acp: a declined step is rejected (the protocol carries no text – the chat line and the prompt rule do)', async () => {
  const fake = fakeSecurity({ gate: () => ({ ok: false, text: declinedText('Run: curl https://x.example/?k=…', 'Mia') }) });
  const allowed = await acpAllowed(fake.service, { agentId: 'ag_1' }, { kind: 'execute', title: 'curl', rawInput: { command: 'curl https://x.example/?k=…' } }, new AbortController().signal);
  assert.equal(allowed, false);
  const options = [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }];
  assert.deepEqual(permissionOutcome(options, allowed ? 'allow' : 'deny'), { outcome: { outcome: 'selected', optionId: 'r' } });
});

test('prompt: the agreements say a blocked step is never reported as done (Secure; Trust when a switch asks)', () => {
  const input = (security: SecuritySettings) => ({ security, name: 'Mia', folder: () => 'C:\\Data\\security', text: () => '' });
  assert.ok(agreementsSection(input(securityDefaults('secure'))).includes(blockedRule('Mia')));
  assert.ok(agreementsSection(input({ ...securityDefaults('trust'), money: 'ask' })).includes(`- ${blockedRule('Mia')}`));
  assert.ok(!agreementsSection(input(securityDefaults('trust'))).includes(blockedRule('Mia')), 'an all-open Trust mode keeps its text as before');
});
