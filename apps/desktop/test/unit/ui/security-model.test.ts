// Settings › Security and the first run's mode choice, pure part (src/ui/settings/security-model.ts, owner 19.11.2026):
// the two modes' words, which fields are locked behind the double confirm, the lock's steps, the choices per switch, what
// a mode switch and the first run write, the cleaned folder and app entries, a waiting request's answers in the to-do's
// words, what leaving a text field saves, and the Changes group's lines for known and unknown fields.
// Owns: these assertions only. Never: a DOM or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRITICAL_TOPICS, securityDefaults } from '../../../src/shared/model/security-settings.ts';
import {
  addTo, answerOptions, changeOrigin, changeValues, choiceLabel, cleanApp, cleanFolder, cleanSite, COMMANDS_OPEN_HINT, confirmText, fieldName, firstRunSecurity, listInForce, listKey,
  lockedState, LOCK_WORD, MODE_ROWS, MODE_TEXT, modeTitle, needsDoubleConfirm, nextLock, opensToTexts, placeName, plainNote,
  SWITCH_HINT, switchChoices, switchHint, switchMode, topicWrite,
} from '../../../src/ui/settings/security-model.ts';

test('the two modes: Trust AI and Secure, one or two plain sentences each, and the page\'s two-line text', () => {
  assert.deepEqual(MODE_ROWS.map((row) => [row.id, row.title]), [['trust', 'Trust AI'], ['secure', 'Secure']]);
  assert.match(MODE_ROWS[0].text, /everywhere on its own .* Settings › Security\.$/);
  assert.match(MODE_ROWS[1].text, /own folders.*asks you before anything else.*Spending money stays closed\.$/);
  for (const row of MODE_ROWS) assert.ok(row.text.split(/(?<=\.) /).length <= 2, `${row.title}: one or two sentences`);
  for (const text of Object.values(MODE_TEXT)) assert.ok(text.length <= 120, 'fits the reserved two lines at phone width');
  assert.equal(modeTitle('secure'), 'Secure');
});

test('the double confirm: the mode always, the critical texts of the shown mode, nothing else', () => {
  assert.equal(needsDoubleConfirm('trust', 'mode'), true);
  assert.equal(needsDoubleConfirm('secure', 'mode'), true);
  assert.equal(needsDoubleConfirm('trust', 'money'), true);
  assert.equal(needsDoubleConfirm('trust', 'captcha'), false, 'only Secure mode guards the bot-check text');
  for (const topic of CRITICAL_TOPICS.secure) assert.equal(needsDoubleConfirm('secure', topic), true, topic);
  assert.equal(needsDoubleConfirm('secure', 'general'), false);
  assert.equal(needsDoubleConfirm('secure', 'read'), false);
  for (const field of ['mode', 'money', 'accounts', 'setup', 'captcha'] as const) {
    assert.match(confirmText('secure', field), /\?$/, `${field}: the question ends in a question mark`);
  }
  assert.match(confirmText('trust', 'mode'), /^Secure /, 'from Trust AI the question names what Secure does');
});

test('the lock: Edit, then Yes, change it, then open – every time; a field without the double confirm rests open', () => {
  assert.equal(lockedState(true), 'locked');
  assert.equal(lockedState(false), 'open');
  assert.equal(nextLock('locked'), 'confirm');
  assert.equal(nextLock('confirm'), 'open');
  assert.deepEqual(LOCK_WORD, { locked: 'Edit', confirm: 'Yes, change it', open: 'Done' });
});

test('the choices per switch, the values\' words and the lists', () => {
  assert.deepEqual(switchChoices('read').map((choice) => choice.label), ['Everywhere', 'Chosen folders']);
  assert.deepEqual(switchChoices('computer').map((choice) => choice.value), ['yes', 'chosen', 'ask']);
  assert.deepEqual(switchChoices('money').map((choice) => choice.label), ['Yes', 'Ask']);
  assert.deepEqual(switchChoices('otherPcs').map((choice) => choice.label), ['Yes', 'Ask', 'No'], 'Umzug 21.11.2026: calls from agents on other PCs');
  assert.equal(choiceLabel('computer', 'chosen'), 'Chosen apps');
  assert.deepEqual([listKey('read'), listKey('write'), listKey('computer'), listKey('web'), listKey('commands')], ['readFolders', 'writeFolders', 'computerApps', 'webDomains', undefined]);
  // 25.11.2026: the web switch – all sites, the chosen ones (a new one asks once), or ask each time
  assert.deepEqual(switchChoices('web').map((choice) => [choice.value, choice.label]), [['yes', 'All sites'], ['chosen', 'Chosen sites'], ['ask', 'Ask']]);
  assert.equal(listInForce(securityDefaults('secure'), 'web'), true, 'Secure mode starts with chosen sites');
  assert.equal(fieldName('security.webDomains'), 'Chosen sites');
  assert.deepEqual([cleanSite('https://WWW.Example.com/a?b'), cleanSite('example.org'), cleanSite('docs.example.org:8443'), cleanSite('[::1]')], ['example.com', 'example.org', 'docs.example.org', '::1']);
  assert.deepEqual([cleanSite(''), cleanSite('two words'), cleanSite('file:///etc/passwd'), cleanSite('data:text/html,x')], [null, null, null, null]);
  assert.equal(placeName({ kind: 'site', value: 'example.com' }), 'example.com');
  assert.deepEqual(answerOptions({ capability: 'web', place: { kind: 'site', value: 'example.com' } }).map((option) => option.label), ['Allow once', 'Always: Web', 'Always: example.com', 'Decline']);
  // Konrad 25.11.2026: commands open in Secure mode reads past the folder rules – the row says so
  assert.equal(switchHint('secure', 'commands', 'yes'), COMMANDS_OPEN_HINT);
  assert.equal(COMMANDS_OPEN_HINT, 'Open: commands run without asking and can read any file this user can, including keys');
  assert.equal(switchHint('secure', 'commands', 'ask'), SWITCH_HINT.commands);
  assert.equal(switchHint('trust', 'commands', 'yes'), SWITCH_HINT.commands, 'Trust AI mode: commands are open anyway');
  const secure = securityDefaults('secure');
  assert.equal(listInForce(secure, 'read'), true);
  assert.equal(listInForce({ ...secure, read: 'all' }, 'read'), false);
  assert.equal(plainNote('secure', 'read'), true, 'a note whose default is empty');
  assert.equal(plainNote('secure', 'money'), false, 'a critical note keeps its head line');
  assert.equal(plainNote('trust', 'publish'), false);
});

test('a mode switch keeps the person\'s values; a company only ever in Trust AI mode starts Secure from its defaults', () => {
  const trust = securityDefaults('trust');
  assert.deepEqual(switchMode(trust, 'secure'), securityDefaults('secure'), 'never "Secure" with everything open');
  assert.deepEqual(switchMode({ ...trust, money: 'ask' }, 'secure'), securityDefaults('secure'), 'a Trust switch alone keeps it untouched');
  assert.deepEqual(switchMode({ ...trust, otherPcs: 'no' }, 'secure'), { ...securityDefaults('secure'), otherPcs: 'no' }, 'otherPcs counts in both modes and stays');
  const own = { ...securityDefaults('secure'), read: 'all' as const, readFolders: ['D:\\Work'] };
  const back = switchMode(own, 'trust');
  assert.deepEqual(back, { ...own, mode: 'trust' }, 'Secure values wait for the way back');
  assert.deepEqual(switchMode(back, 'secure'), own);
  assert.deepEqual(switchMode({ ...trust, computerApps: ['excel'] }, 'secure'), { ...trust, computerApps: ['excel'], mode: 'secure' });
});

test('the first run writes the chosen mode\'s defaults, but Set up again keeps a company\'s own switches in the same mode', () => {
  assert.deepEqual(firstRunSecurity(undefined, 'trust'), securityDefaults('trust'));
  assert.deepEqual(firstRunSecurity(undefined, 'secure'), securityDefaults('secure'));
  assert.equal(firstRunSecurity({ ...securityDefaults('secure'), commands: 'yes' }, 'secure'), undefined);
  assert.deepEqual(firstRunSecurity(securityDefaults('secure'), 'trust'), securityDefaults('trust'));
});

test('folders and apps typed or picked are cleaned; a list takes an entry once', () => {
  assert.equal(cleanFolder('  C:\\Users\\Ada\\Docs\\ '), 'C:\\Users\\Ada\\Docs');
  assert.equal(cleanFolder('"D:\\Work"'), 'D:\\Work');
  assert.equal(cleanFolder('C:\\'), 'C:\\', 'a drive root keeps its slash');
  assert.equal(cleanFolder('/home/ada/'), '/home/ada');
  assert.equal(cleanFolder('\\\\server\\share'), '\\\\server\\share');
  assert.equal(cleanFolder('Docs'), null, 'a relative path is no folder on the PC');
  assert.equal(cleanFolder(''), null);
  assert.equal(cleanApp(' EXCEL.EXE '), 'excel');
  assert.equal(cleanApp('C:\\Program Files\\Google\\chrome.exe'), 'chrome');
  assert.equal(cleanApp('  '), null);
  assert.deepEqual(addTo(['excel'], 'chrome'), ['excel', 'chrome']);
  assert.equal(addTo(['D:\\Work'], 'd:\\work'), null, 'already there');
  assert.equal(addTo(Array.from({ length: 50 }, (_, i) => `a${i}`), 'b'), null, 'full');
});

test('a waiting request offers the to-do\'s answers: once, always the setting, always the place, decline', () => {
  const folder = answerOptions({ capability: 'read', place: { kind: 'folder', value: 'C:\\Users\\Ada\\Taxes\\' } });
  assert.deepEqual(folder.map((option) => option.answer), ['once', 'setting', 'place', 'decline']);
  assert.deepEqual(folder.map((option) => option.label), ['Allow once', 'Always: Reading files', 'Always: Taxes', 'Decline']);
  assert.equal(folder[2].title, 'C:\\Users\\Ada\\Taxes\\', 'the full place as the tooltip');
  assert.deepEqual(answerOptions({ capability: 'commands' }).map((option) => option.answer), ['once', 'setting', 'decline'], 'no place, no place answer');
  assert.equal(placeName({ kind: 'app', value: 'excel' }), 'excel');
});

test('leaving a text field saves only a change; an emptied note goes back to its empty default', () => {
  assert.equal(topicWrite({ text: 'Keep it.' }, ' Keep it.\r\n', false), undefined, 'unchanged');
  assert.equal(topicWrite({ text: 'a' }, 'b\r\nc', false), 'b\nc', 'LF only');
  assert.equal(topicWrite({ text: 'a' }, '  ', true), null, 'a plain note: back to the default');
  assert.equal(topicWrite({ text: 'a' }, '', false), '', 'a topic with a default text: an empty file says "nothing here"');
});

test('the Changes group titles: current and legacy settings by their words, unknown fields by their name', () => {
  assert.deepEqual(
    ['securityMode', 'money', 'security.read', 'topic:secure/general', 'security/secure/general.md', 'forEveryAgent', 'libraryPublish', 'somethingNew'].map(fieldName),
    ['Mode', 'Spending money', 'Reading files', 'When to check with you', 'When to check with you – text (Secure)', 'For every agent', 'Share in the public library', 'Something New'],
  );
});

test('change previews keep the old and new values; text entries can open to before and after', () => {
  assert.equal(changeValues({ from: 'trust', to: 'secure' }), 'Trust AI → Secure');
  assert.equal(changeValues({ from: 'chosen', to: 'all' }), 'Chosen → Everywhere');
  assert.equal(changeValues({ from: 'on', to: 'off' }), 'On → Off');
  assert.equal(changeValues({ from: 'a\nb', to: 'c' }), '"a b" → "c"');
  assert.equal(opensToTexts({ from: 'yes', to: 'ask' }), false);
  assert.equal(opensToTexts({ from: '', to: 'a new text' }), true);
});

test('change origins distinguish the recorded actor roles without interpreting the name', () => {
  const name = 'settings.json or a linked PC';
  for (const [kind, role] of [['person', 'Person'], ['phone', 'Phone'], ['agent', 'Agent'], ['colleague', 'Colleague']] as const) {
    assert.deepEqual(changeOrigin({ kind, name }), { kind: 'actor', role, name });
  }
});

test('only a team agent gets an agent profile link', () => {
  assert.deepEqual(changeOrigin({ kind: 'agent', id: 'ag_1', name: 'Example agent' }), {
    kind: 'actor', role: 'Agent', name: 'Example agent', href: '#/team/ag_1',
  });
  assert.deepEqual(changeOrigin({ kind: 'agent', id: 'external_1', name: 'An external agent' }), {
    kind: 'actor', role: 'Agent', name: 'An external agent',
  });
  assert.deepEqual(changeOrigin({ kind: 'colleague', id: 'ag_1', name: 'A colleague' }), {
    kind: 'actor', role: 'Colleague', name: 'A colleague',
  });
});

test('unattributed changes show the known source, not when they happened', () => {
  for (const [name, display] of [
    ['settings.json or a linked PC', 'Direct file edit or a linked PC'],
    ['An edit of the file (an agent, an editor or a script)', 'Direct file edit'],
    ['A command on this PC (wf or a script, no agent named)', 'Command on this PC (no agent named)'],
    ['A linked PC', 'A linked PC'],
    ['While Autark was not running', 'Unknown'],
    ['  ', 'Unknown'],
  ]) {
    assert.deepEqual(changeOrigin({ kind: 'other', name }), { kind: 'source', name: display });
  }
});
