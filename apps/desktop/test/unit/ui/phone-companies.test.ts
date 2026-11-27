// B-084 (decision 7) the Android app's companies on the page (ui/pwa/phone-companies.ts): the 'companies' list is
// parsed defensively (rows without an id skipped, a picture only as a small image data URL), the status line reads
// "<company> · <PC>" or "Connecting…", and a pick / "Add a company" are one port message each (no PC picker, 27.11.2026).
// Owns: these assertions with a fake port. Never: a WebView or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptPort, resetNativePort } from '../../../src/ui/pwa/native-port.ts';
import { addCompany, parseCompanies, parseStatus, statusLine, switchCompany } from '../../../src/ui/pwa/phone-companies.ts';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

test('the list: ids required, names trimmed (the id when empty), current only when true, pictures only as image data URLs', () => {
  const list = parseCompanies({
    t: 'companies',
    list: [
      { id: 'c1', name: '  Teydra Lab ', avatar: JPEG, current: true, pc: 'Office PC' },
      { id: 'c2', name: '', current: 'yes', avatar: 'https://example.com/x.png' },
      { name: 'no id' },
      null,
      'c3',
      { id: 'c4', name: 'Script', avatar: 'data:text/html;base64,PHNjcmlwdD4=' },
      { id: 'c5', name: 'Big', avatar: `data:image/png;base64,${'A'.repeat(40_000)}` },
    ],
  });
  assert.deepEqual(list, [
    { id: 'c1', name: 'Teydra Lab', current: true, avatar: JPEG, pc: 'Office PC' },
    { id: 'c2', name: 'c2', current: false },
    { id: 'c4', name: 'Script', current: false },
    { id: 'c5', name: 'Big', current: false },
  ]);
  assert.deepEqual(parseCompanies({ t: 'companies' }), []);
  assert.deepEqual(parseCompanies({ t: 'companies', list: 'x' }), []);
});

test('status and the one status line', () => {
  assert.deepEqual(parseStatus({ t: 'status', connected: true, pc: ' Office PC ' }), { connected: true, pc: 'Office PC' });
  assert.deepEqual(parseStatus({ t: 'status', connected: 'true' }), { connected: false });
  assert.equal(statusLine('Teydra Lab', { connected: true, pc: 'Office PC' }), 'Teydra Lab · Office PC');
  assert.equal(statusLine('Teydra Lab', { connected: true }), 'Teydra Lab');
  assert.equal(statusLine('Teydra Lab', { connected: false, pc: 'Office PC' }), 'Connecting…');
  assert.equal(statusLine('Teydra Lab', null), 'Connecting…');
});

test('switch and add are one message each, there is no PC picker; nothing without the port', () => {
  resetNativePort();
  assert.equal(switchCompany('c2'), false);
  assert.equal(addCompany(), false);
  const sent: unknown[] = [];
  adoptPort({ postMessage: (data: unknown) => sent.push(data), close: () => undefined, onmessage: null } as unknown as MessagePort);
  assert.equal(switchCompany('c2'), true);
  assert.equal(addCompany(), true);
  assert.deepEqual(sent.map((data) => JSON.parse(String(data))), [{ t: 'switch', id: 'c2' }, { t: 'add' }]);
  resetNativePort();
});
