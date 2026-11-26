// 26.11.2026 (owner): the agent page's model choice (src/ui/team/agent-model.ts, AgentDetails.tsx) and Settings › Models'
// "Advanced" disclosure (ModelUses.tsx, uses-view.ts modelsStatus). The .tsx cannot be imported by node --test, so its
// wiring is read from the source; the rules live in the .ts files and are asserted directly.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pendingModel, SWITCH_HINT, SWITCH_LABEL, SWITCH_NOW_CONFIRM, switchRequest } from '../../../src/ui/team/agent-model.ts';
import { modelsStatus } from '../../../src/ui/settings/uses-view.ts';

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (file: string) => readFileSync(path.join(ui, file), 'utf8');

const OPUS = 'claude:claude-opus-5-5';
const SOL = 'codex:gpt-6.1-sol';

test('two ways: "From next context" is the start model alone, "Now" adds now; Auto has only the first', () => {
  assert.deepEqual(SWITCH_LABEL, { next: 'From next context', now: 'Now' });
  assert.ok(SWITCH_HINT.next && SWITCH_HINT.now);
  assert.deepEqual(switchRequest('ag_1', undefined, OPUS, 'next'), { agentId: 'ag_1', policy: { pin: OPUS } });
  assert.deepEqual(switchRequest('ag_1', undefined, OPUS, 'now'), { agentId: 'ag_1', policy: { pin: OPUS }, now: true });
  // the policy's other fields stay; who set the start model (pinBy) is the runtime's to write
  const current = { pin: OPUS, pinBy: { name: 'Manager', at: 5 }, effort: 'high' as const, avoid: [SOL] };
  assert.deepEqual(switchRequest('ag_1', current, SOL, 'now'), { agentId: 'ag_1', policy: { effort: 'high', avoid: [SOL], pin: SOL }, now: true });
  assert.deepEqual(switchRequest('ag_1', current, '', 'now'), { agentId: 'ag_1', policy: { effort: 'high', avoid: [SOL] } }, 'Auto: the start model goes, nothing to switch to now');
});

test('"Now" asks first, in English: title, text and the two buttons', () => {
  assert.deepEqual(SWITCH_NOW_CONFIRM, {
    title: 'Switch model now?',
    body: 'The agent reads the whole conversation again with the new model. That costs more.',
    confirmLabel: 'Switch now',
  });
  const page = read('team/AgentDetails.tsx');
  assert.match(page, /if \(when === 'now' && model && !\(await confirm\(SWITCH_NOW_CONFIRM\)\)\) return;/, 'cancel: nothing is sent');
  assert.match(page, /rpc\.call\('models\.setPolicy', switchRequest\(agentId, agent\.modelPolicy, model, when\)\)/);
  const dialog = read('lib/dialog.tsx');
  assert.match(dialog, /Cancel/, 'the confirm dialog has its Cancel');
});

test('a start model that waits for the next context is named pending until the agent runs on it', () => {
  assert.equal(pendingModel(SOL, OPUS), SOL);
  assert.equal(pendingModel(SOL, SOL), undefined, 'applied at the rebuild: no longer pending');
  assert.equal(pendingModel(undefined, OPUS), undefined);
  assert.equal(pendingModel('auto', OPUS), undefined);
  assert.equal(pendingModel(SOL, undefined), SOL, 'it has not run yet');
  assert.match(read('team/AgentDetails.tsx'), /`\$\{pendingName\} from its next context`/);
});

test('the agent page shows the model it is on and opens the choice on a click', () => {
  const page = read('team/AgentDetails.tsx');
  assert.match(page, /<Row label="Model" hint=\{hint\}>/);
  assert.match(page, /onClick=\{\(\) => setOpen\(!open\)\}>\s*<span class="chip-label">\{value\}<\/span>/, 'the button carries the current model');
  assert.doesNotMatch(page, /Start model/, 'one row: the former Now and Start model rows are one');
});

test('Settings › Models: up front only whether models work; the ten uses and Model choice are behind "Advanced"', () => {
  assert.deepEqual(modelsStatus(undefined), { state: 'pending', text: '' });
  assert.deepEqual(modelsStatus([{ use: 'work', state: 'ready' }, { use: 'voice', state: 'off' }]), { state: 'ready', text: 'Models work' });
  assert.deepEqual(modelsStatus([{ use: 'work', state: 'ready' }, { use: 'stt', state: 'setup' }]), { state: 'ready', text: 'Models work · 1 more use needs one step' });
  assert.deepEqual(modelsStatus([{ use: 'work', state: 'ready' }, { use: 'stt', state: 'setup' }, { use: 'tts', state: 'setup' }]).text, 'Models work · 2 more uses need one step');
  assert.deepEqual(modelsStatus([{ use: 'work', state: 'setup' }]), { state: 'setup', text: 'Models need one step' });
  assert.deepEqual(modelsStatus([{ use: 'voice', state: 'ready' }]), { state: 'setup', text: 'Models need one step' }, 'no ready work use');
  const uses = read('settings/ModelUses.tsx');
  assert.match(uses, /<span>Advanced<\/span>/);
  assert.match(uses, /aria-expanded=\{shown\}/);
  assert.match(uses, /\{shown && \(\s*<div id="settings-uses-advanced" class="uses-advanced">\s*\{MODEL_USES\.map\(/, 'the rows exist only while it is open');
  assert.match(uses, /const shown = advanced \|\| settingsSearch\.value\.trim\(\) !== '';/, 'a settings search opens it');
  assert.match(uses, /const \[advanced, setAdvanced\] = useState\(false\);/, 'closed to begin with');
});
