// B-072 the profile menu (owner 04.11.2026: "unten auf dem Profilbild ... kann dann die Account switchen", "einen neuen
// Account erstellen"): in the desktop window it lists the companies on this PC (the current one ticked) above Settings;
// B-078 (owner 06.11.2026): a "+" beside the company name offers New company / Connect with an ID (Eine-ID 22.11.2026:
// no role to pick) / Import a company, each new one a companies.open with its start; picking one calls companies.open (main opens that window
// and sends this one to the tray). The list is loaded when the bubble mounts and again on each opening, so the fixed-width menu opens at its
// full height; the PWA and phones never ask for it. No new icons. B-084: inside the Android app (with its port) the
// menu is the phone sheet (the paired companies with their pictures, Add a company, Settings; one status line);
// "Forget this phone" left the menu for Settings › Devices.
// Owns: these assertions on the source (a .tsx file cannot run under node --test). Never: renders or calls a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const source = readFileSync(path.join(UI, 'shell', 'ProfileMenu.tsx'), 'utf8');

test('the companies come from companies.list, only in the desktop window', () => {
  assert.match(source, /if \(platform !== 'desktop'\) return;[^\n]*\n\s*rpc\.call\('companies\.list', \{ facts: true \}\)/, 'the PWA and phones never ask; 20.11.2026: with the facts of each company (Leave or Delete in its ⋯)');
  assert.match(source, /useEffect\(loadCompanies, \[\]\)/, 'loaded when the bubble mounts');
  assert.match(source, /onClick=\{\(\) => \{ if \(!open\) loadCompanies\(\); setOpen\(!open\); \}\}/, 'and again on each opening');
  assert.match(source, /const companies = signal<CompanyEntry\[\]>\(\[\]\)/, 'kept between openings: the menu opens at its full height');
});

test('one section: the companies (the current one ticked), then Settings; B-078: the "+" beside the company name adds one three ways', () => {
  assert.match(source, /checked: company\.current/);
  assert.match(source, /if \(!company\.current\) openCompany\(\{ id: company\.id \}\)/, 'picking the current one does nothing');
  assert.match(source, /\{ label: 'New company', [^\n]*openCompany\(\{ create: true, start: 'new' \}\) \}/);
  assert.match(source, /\{ label: 'Connect with an ID', [^\n]*openCompany\(\{ create: true, start: 'join' \}\) \}/, 'Eine-ID: one way, the ID typed decides');
  assert.match(source, /\{ label: 'Import a company', [^\n]*importCompany\(\)/);
  assert.doesNotMatch(source, /start: 'mine'|start: 'employee'|as my other device|as employee/, 'no role to pick');
  assert.equal(source.match(/^ {2}\{ label: '/gm)?.length, 4, 'Settings + the three of the "+"');
  assert.match(source, /<IconButton icon="plus" label="Add a company"[^\n]*onClick=\{\(\) => \{ setOpen\(false\); setAdding\(true\); \}\}/, 'the "+" opens the add menu in the same place');
  assert.match(source, /<Menu anchor=\{ref\.current\} open=\{adding\}[^\n]*sections=\{\[\{ items: ADD_ITEMS \}\]\}/);
  assert.match(source, /rpc\.call\('companies\.open', params\)\.catch\(\(error: unknown\) => toastError\(error, 'Could not open the company'\)\)/);
  assert.match(source, /if \(!list\.length\) return \[\];/, 'no list (a test profile): no section');
  assert.match(source, / : \[\.\.\.companySections\(companies\.value, setActing\), \{ items: ITEMS \}\]\}/, 'Settings stays last');
  assert.match(source, /const ITEMS: MenuItem\[\] = \[\n  \{ label: 'Settings', hint: comboLabel\('mod\+,'\), onSelect: \(\) => go\.settings\(\) \},\n\];/);
  assert.doesNotMatch(source, /Forget this phone'/, 'B-084: Forget moved to Settings › Devices');
  assert.doesNotMatch(source, /forgetThisPhone/);
});

test('B-084 the phone sheet inside the Android app: photo, name, one status line, the paired companies, Add a company, Settings', () => {
  assert.match(source, /const phone = isAndroidApp\(\);/, 'the page is the app\'s own: no path for an app without the port');
  assert.match(source, /sections=\{phone \? phoneSections\(phoneCompanies\.value\) : \[\.\.\.companySections\(companies\.value, setActing\), \{ items: ITEMS \}\]\}/, 'the desktop path is unchanged');
  assert.match(source, /return \[\{ items: \[\.\.\.rows, ADD_COMPANY\] \}, \{ items: ITEMS \}\];/, 'companies, Add a company, then Settings');
  assert.match(source, /lead: <CompanyPic company=\{company\} \/>/, 'each company with its picture');
  assert.match(source, /checked: company\.current,\n\s*onSelect: \(\) => \{ if \(!company\.current\) switchCompany\(company\.id\); \}/, 'the current one ticked; a pick lets the app switch');
  assert.match(source, /\{avatar \? <img src=\{avatar\} alt="" \/> : <span>\{avatarInitials\(name\)\}<\/span>\}/, 'the card photo, else initials');
  assert.match(source, /data-color=\{paletteIndex\(id\)\}/, 'on a colour from the id');
  assert.match(source, /const ADD_COMPANY: MenuItem = \{ label: 'Add a company', icon: 'plus', description: 'Scan or type another company\\'s code', onSelect: \(\) => \{ addCompany\(\); \} \};/);
  assert.match(source, /<span class="profile-status">\{statusLine\(current\?\.name \?\? companyLabel\(profile, null\), phoneStatus\.value\)\}<\/span>/, 'the status line is words only: there is no PC picker (owner 27.11.2026)');
  assert.doesNotMatch(source, /showPcs/);
  assert.match(source, /<HumanAvatar size=\{40\} \/>/);
});

test('nothing shifts: the same fixed-width popover; the only icon is the plus of Add a company', () => {
  assert.match(source, /width=\{256\}/);
  assert.equal(source.match(/icon:/g)?.length, 1, 'menu items stay text only, but for Add a company');
  assert.doesNotMatch(source, /<Icon\b/);
  const css = readFileSync(path.join(UI, 'styles', 'settings.css'), 'utf8');
  assert.match(css, /\.profile-status \{[^}]*height: 32px;[^}]*white-space: nowrap;/, 'the status line keeps one fixed height');
  assert.match(css, /\.menu-item > \.company-pic \{ flex: none; width: 24px; height: 24px;/);
});
