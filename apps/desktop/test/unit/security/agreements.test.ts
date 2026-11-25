// Owns: the stable prompt's "## What <name> and I agreed" (runtime/security/agreements.ts): Trust AI mode – the mode line
// with the folder, a fact line only for a grave switch set to ask, the Trust texts under their headings; Secure mode – the
// closed paragraph, one fact line per switch in order with its note below, money closed, Autark's window never, the
// folder and app lists, the general and bot-check texts; deterministic.
// Never: reading files (topics.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreementsSection, type AgreementsInput } from '../../../src/runtime/security/agreements.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';

const texts: Record<string, string> = {
  'trust/general': 'I check with Ada when I guess.',
  'trust/money': 'Money spent is gone.',
  'trust/captcha': 'No bot checks.',
  'secure/read': 'Tax papers are private.\nThe rest is fine.',
  'secure/money': 'Nothing is bought here.',
  'secure/general': 'I picture Ada watching.',
  'secure/captcha': 'No bot checks.',
};
const input = (security: SecuritySettings, name = 'Ada'): AgreementsInput => ({
  security, name, folder: (mode) => `C:\\Data\\security\\${mode}`, text: (mode, topic) => texts[`${mode}/${topic}`] ?? '',
});

test('Trust AI mode: the mode line names the folder; a grave switch on ask is one fact line; the texts follow under their headings', () => {
  const open = agreementsSection(input(securityDefaults('trust')));
  assert.equal(open, [
    '## What Ada and I agreed',
    'Ada runs this PC in Trust AI mode: I work wherever the task needs and decide myself; the agreements below say how Ada wants it done. They are files in C:\\Data\\security\\trust – I change one when Ada clearly wants it changed, in their own words, not because it would suit me. The PC\'s own permission requests – a Yes, a password, an administrator prompt – and the lock screen are mine to answer too, on any device: with the code or password from the secrets catalog I approve and unlock myself, Ada doesn\'t have to.',
    '',
    '### How I decide',
    'I check with Ada when I guess.',
    '',
    '### Spending money',
    'Money spent is gone.',
    '',
    '### Bot checks ("I\'m not a robot")',
    'No bot checks.',
  ].join('\n'));
  const asks = agreementsSection(input({ ...securityDefaults('trust'), money: 'ask', publish: 'ask', commands: 'ask' }));
  assert.match(asks, /\n- Spending money: the app asks Ada before each payment and holds it until they answer\.\n- Publishing: the app asks Ada before each post and holds it until they answer\.\n- A step the app blocked or Ada declined did not happen: I never report it, or the work that needed it, as done – my answer says plainly what was blocked and what is still missing\.\n\n### How I decide\n/);
  assert.doesNotMatch(asks, /Running commands/, 'Trust AI mode reads only its three switches');
  assert.equal(agreementsSection(input(securityDefaults('trust'))), open, 'deterministic');
});

test('Secure mode: one fact line per switch in order with its note below; money closed; lists named; the extra texts last', () => {
  const security: SecuritySettings = { ...securityDefaults('secure'), readFolders: ['C:\\Users\\Ada\\Docs', 'D:\\Work'], computer: 'chosen', computerApps: ['excel', 'chrome'], web: 'yes' };
  const text = agreementsSection(input(security));
  const lines = text.split('\n');
  assert.equal(lines[0], '## What Ada and I agreed');
  assert.match(lines[1], /^Ada runs this PC in Secure mode\. Some things are closed: the app holds them closed and asks Ada when I need one – once, always for that setting, or always for that place\./);
  assert.match(lines[1], /These agreements and the security settings are Ada's; the app keeps them closed to me\.$/);
  const facts = lines.filter((line) => line.startsWith('- ')).map((line) => line.split(':')[0]);
  assert.deepEqual(facts, ['- Reading files', '- Changing and deleting files', '- Running commands', '- The web', '- Operating apps on this PC', '- Operating Ada\'s phone', '- Messages to people outside the company', '- Publishing', '- Accounts, sign-ins and passwords', '- Autark\'s own setup', '- Hiring and changing agents', '- Spending money']);
  assert.ok(text.includes('- Reading files: open in the team\'s own folders: the workspace and its projects, the company\'s data folder (not its keys, secrets, sign-ins or database), the app\'s resources and the temp folders and in C:\\Users\\Ada\\Docs, D:\\Work; elsewhere the app asks Ada first.\n  Tax papers are private.\n  The rest is fine.\n- Changing'), 'the note under its fact line');
  assert.ok(text.includes('- Changing and deleting files: open in the team\'s own folders: the workspace and its projects (not its shared skills), my home and the memory in the company\'s data folder, and the temp folders; elsewhere the app asks Ada first.'));
  assert.ok(text.includes('- Running commands: the app asks Ada before each command.'));
  assert.ok(text.includes('- The web: open.'));
  assert.ok(text.includes('- Operating apps on this PC: open for excel, chrome; for any other app the app asks Ada first; Autark\'s own window is never mine to operate.'));
  assert.ok(text.includes('- Hiring and changing agents: open.'));
  assert.ok(text.includes('- Spending money: closed – the app refuses stored cards and its spending tools, whatever a chat says; a payment the app can\'t see (a shop\'s saved card behind a Buy button) is still mine not to make.\n  Nothing is bought here.'));
  assert.ok(text.endsWith('\n\n### When I check with Ada\nI picture Ada watching.\n\n### Bot checks ("I\'m not a robot")\nNo bot checks.'));
  const money = agreementsSection(input({ ...security, money: 'yes' }));
  assert.ok(money.includes('- Spending money: closed'), 'closed whatever the switch says');
});

test('Secure mode: computer all apps or ask, files everywhere; no name reads "the person"', () => {
  const all = agreementsSection(input({ ...securityDefaults('secure'), computer: 'yes', read: 'all' }, 'the person'));
  assert.match(all, /^## What the person and I agreed\nThe person runs this PC in Secure mode\./);
  assert.ok(all.includes('- Operating apps on this PC: open for every app; Autark\'s own window is never mine to operate.'));
  assert.ok(all.includes('- Reading files: open everywhere on this PC.'));
  const ask = agreementsSection(input({ ...securityDefaults('secure'), computer: 'chosen', computerApps: [] }));
  assert.ok(ask.includes('- Operating apps on this PC: the app asks Ada before each app I operate; Autark\'s own window is never mine to operate.'), 'chosen with no app: each app asks');
});
