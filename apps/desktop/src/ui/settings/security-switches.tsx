// Settings › Security's switch rows (owner 19.11.2026: "Pro Einstellung Ja/Nein oder fein: Dateien lesen/schreiben –
// alle / … / ausgewählte Ordner … Computer Use: … andere Apps: alle oder pro App"): one row per switch with its choices
// (security-model.ts switchChoices) writing settings.json `security` whole; files and apps keep their list under the row
// – always there, quiet while the switch does not use it, so a choice moves nothing. Folders come from the system's
// folder dialog on the desktop (files.pickFolder 'security'); elsewhere (a phone, a browser) a PC path is typed. Apps come
// from the apps with a window on the PC right now (security.apps, offered while typing) or are typed. Spending money in
// Secure mode is a fixed "Closed in Secure mode". 25.11.2026: the web switch keeps its sites the same way (typed, each
// removable; a site answered with "Always" joins by itself). Umzug 21.11.2026: the same row serves `otherPcs` (Yes / Ask / No) in the page's head.
// Owns: these rows and lists. Never: decides what a switch means at run time (runtime/security/policy.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { SecurityMode, SecuritySettings, SecuritySwitch } from '../../shared/model/security-settings.ts';
import { otherPcsOf, SECURITY_LABELS } from '../../shared/model/security-settings.ts';
import { bridge } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { updateSettings } from '../lib/store.ts';
import { Button } from '../lib/ui.tsx';
import { act, Note, Row } from './controls.tsx';
import { LockButton, leftBox, useDoubleConfirm } from './security-fields.tsx';
import {
  addTo, choiceLabel, cleanApp, cleanFolder, cleanSite, confirmText, listInForce, listKey, MONEY_CLOSED, MONEY_CLOSED_HINT, switchChoices, switchHint,
} from './security-model.ts';

/** Writes the whole section with one change (lists are replaced whole). */
export function saveSecurity(current: SecuritySettings, change: Partial<SecuritySettings>): Promise<void | undefined> {
  return act(() => updateSettings({ security: { ...current, ...change } }), 'Could not change the security setting');
}

/** One switch: its choices, or the fixed money note in Secure mode; a read-only word where this session may not change it. */
export function SwitchRow(props: { mode: SecurityMode; name: SecuritySwitch; settings: SecuritySettings; editable: boolean }) {
  const { mode, name, settings } = props;
  const value = (name === 'otherPcs' ? otherPcsOf(settings) : settings[name]) as string; // otherPcs: absent = yes
  const closed = mode === 'secure' && name === 'money';
  const choices = switchChoices(name);
  // Trust AI mode's money switch is one of the key agreements: Edit → "Yes, change it" every time (owner 19.11.2026).
  const guarded = mode === 'trust' && name === 'money' && props.editable;
  const lock = useDoubleConfirm(guarded);
  const box = useRef<HTMLDivElement>(null);
  const hint = closed ? MONEY_CLOSED_HINT : lock.state === 'confirm' && name === 'money' ? confirmText(mode, name) : switchHint(mode, name, value);
  return (
    <div ref={box} onFocusOut={(event) => { if (guarded && leftBox(event, box.current)) lock.lock(); }}>
      <Row label={SECURITY_LABELS[name]} hint={hint} reserve class={`sec-switch${lock.state === 'confirm' ? ' sec-confirming' : ''}`}>
        {closed ? <Note>{MONEY_CLOSED}</Note>
          : !props.editable ? <Note>{choiceLabel(name, value)}</Note>
          : (
            <>
              <div class="segmented" role="radiogroup" aria-label={SECURITY_LABELS[name]} aria-disabled={lock.state !== 'open'}>
                {choices.map((choice) => (
                  <button key={choice.value} type="button" role="radio" aria-checked={choice.value === value} class={choice.value === value ? 'selected' : ''}
                    disabled={lock.state !== 'open'}
                    onClick={() => { if (choice.value !== value) void saveSecurity(settings, { [name]: choice.value } as Partial<SecuritySettings>).finally(() => lock.lock()); }}>
                    {choice.label}
                  </button>
                ))}
              </div>
              {guarded && <LockButton state={lock.state} onStep={lock.step} onDone={lock.lock} />}
            </>
          )}
      </Row>
    </div>
  );
}

/** The folder or app list under a files or computer switch, with its way to add one; quiet while the switch does not use it. */
export function ScopeList(props: { name: SecuritySwitch; settings: SecuritySettings; editable: boolean }) {
  const key = listKey(props.name);
  if (!key) return null;
  const list = props.settings[key] ?? []; // webDomains: absent = none
  const apps = key === 'computerApps';
  const sites = key === 'webDomains';
  const off = !listInForce(props.settings, props.name);
  const save = (next: string[]) => saveSecurity(props.settings, { [key]: next } as Partial<SecuritySettings>);
  const add = (raw: string): boolean => {
    const entry = apps ? cleanApp(raw) : sites ? cleanSite(raw) : cleanFolder(raw);
    const next = entry && addTo(list, entry);
    if (next) void save(next);
    return Boolean(next);
  };
  return (
    <div class={`sec-list${off ? ' sec-list-off' : ''}`}>
      <div class="sec-list-items">
        {list.length === 0 && <span class="sec-list-empty">{apps ? 'No apps chosen yet' : sites ? 'No sites yet – the app asks before the first visit to each' : 'Only the team\'s own folders so far'}</span>}
        {list.map((item) => (
          <span key={item} class="sec-item" title={item}>
            <span class="sec-item-text">{item}</span>
            {props.editable && <button type="button" class="sec-item-x" aria-label={`Remove ${item}`} onClick={() => void save(list.filter((other) => other !== item))}>×</button>}
          </span>
        ))}
      </div>
      {props.editable && (apps ? <AddByName add={add} /> : sites ? <AddByName add={add} kind="site" /> : bridge?.files.pickFolder ? <PickFolder add={add} /> : <AddByName add={add} kind="folder" />)}
    </div>
  );
}

function PickFolder(props: { add: (path: string) => boolean }) {
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    const choose = bridge?.files.pickFolder;
    if (!choose) return;
    setBusy(true);
    try {
      const path = await act(() => choose('security'), 'Could not choose a folder');
      if (path) props.add(path);
    } finally { setBusy(false); }
  };
  return <Button variant="ghost" class="small sec-add" busy={busy} onClick={() => void pick()}>Add folder…</Button>;
}

/** A typed folder (a PC path, on a phone), site or app name, with the running apps offered for apps. */
function AddByName(props: { add: (value: string) => boolean; kind?: 'folder' | 'site' }) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const [offered, setOffered] = useState<string[]>([]);
  const app = !props.kind;
  const listId = app ? 'sec-running-apps' : undefined;
  useEffect(() => {
    if (!app || !can('security.apps')) return;
    let live = true; // the running apps, offered while typing: loaded once each time the list shows
    rpc.call('security.apps').then((names) => { if (live) setOffered(names); }, () => undefined);
    return () => { live = false; };
  }, [app]);
  const label = props.kind === 'folder' ? 'Folder on the PC' : props.kind === 'site' ? 'Site' : 'App';
  const placeholder = props.kind === 'folder' ? 'Folder on the PC, e.g. C:\\Users\\…\\Documents' : props.kind === 'site' ? 'Site, e.g. example.com' : 'App, e.g. excel';
  const commit = () => {
    if (!text.trim()) return;
    const ok = props.add(text);
    setBad(!ok);
    if (ok) setText('');
  };
  return (
    <span class="set-inline sec-add-row">
      <input class="set-input" type="text" spellcheck={false} list={listId} value={text} aria-invalid={bad}
        aria-label={label} placeholder={placeholder}
        onInput={(event) => { setText(event.currentTarget.value); setBad(false); }}
        onKeyDown={(event) => { if (event.key === 'Enter') commit(); }} />
      {listId && <datalist id={listId}>{offered.map((name) => <option key={name} value={name} />)}</datalist>}
      <Button variant="secondary" class="small" disabled={!text.trim()} onClick={commit}>Add</Button>
    </span>
  );
}
