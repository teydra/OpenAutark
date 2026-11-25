// Settings › Security's two lower groups. Public library (17.11.2026): sharing in the public library
// (settings.library.publish, on by default – owner 06.11.2026), the same choice as the first run's tick; off ends only the
// sharing, the agents still search and read the library. Changes (owner 16.11.2026): the last changes of the security
// settings with who, when and old → new (runtime/settings/security-log.ts, settings.securityLog): the setting names
// each row, the recorded role and name or source sit below it (a team agent links to its page), and the recorded
// time is on the right. A change of a text opens
// to the recorded before and after; more than eight entries wait behind "Show all". A session that may not read the log
// gets no group.
// Owns: these two groups. Never: writes the log.

import { useEffect, useState } from 'preact/hooks';
import type { TopicText } from '../../shared/api/methods-security-mode.ts';
import { SECURITY_LOG_MAX, SECURITY_LOG_TEXT, type SecurityChange } from '../../shared/model/security-log.ts';
import { fullDate, logTime } from '../lib/format.ts';
import { rpc } from '../lib/rpc.ts';
import { updateSettings } from '../lib/store.ts';
import { act, ActionButton, Group, Note, Row, Toggle } from './controls.tsx';
import { changeOrigin, changeValues, fieldName, opensToTexts } from './security-model.ts';
import { setPhoneUsage, usePhoneUsage } from './phone-usage.ts';
import { USAGE_HINT, USAGE_TEXT, USAGE_TITLE } from './usage-count.ts';

export function LibraryGroup(props: { share: boolean; locked: boolean; lockNote: string }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const shown = pending ?? props.share;
  const change = (to: boolean) => {
    if (pending !== null || to === props.share) return;
    setPending(to);
    void act(() => updateSettings({ library: { publish: to } }), 'Could not change the sharing').finally(() => setPending(null));
  };
  return (
    <Group title="Public library" hint="Skills and notes your agents find worth sharing go to library.openautark.com for everyone (public, CC0)">
      <Row label="Share in the public library" hint={props.locked ? props.lockNote : 'Each text is checked for secrets, paths, e-mail addresses and internal names first; what fails a check stays here. Off: nothing is shared, the agents still read the library.'}>
        {props.locked ? <Note>{props.share ? 'On' : 'Off'}</Note> : <Toggle label="Share in the public library" checked={shown} onChange={change} />}
      </Row>
    </Group>
  );
}

/** 25.11.2026: the anonymous usage count's switch (settings.usage.count, on by default; each PC its own) – the same choice as the first run's tick. */
export function UsageGroup(props: { on: boolean; locked: boolean; lockNote: string }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const shown = pending ?? props.on;
  const phone = usePhoneUsage();
  const change = (to: boolean) => {
    if (pending !== null || to === props.on) return;
    setPending(to);
    void act(() => updateSettings({ usage: { count: to } }), 'Could not change the usage count').finally(() => setPending(null));
  };
  return (
    <Group title={USAGE_TITLE} hint={USAGE_HINT}>
      <Row label={USAGE_TITLE} hint={props.locked ? props.lockNote : USAGE_TEXT}>
        {props.locked ? <Note>{props.on ? 'On' : 'Off'}</Note> : <Toggle label={USAGE_TITLE} checked={shown} onChange={change} />}
      </Row>
      {phone ? (
        <Row label="This phone" hint={phone.text}>
          <Toggle label={`${USAGE_TITLE} on this phone`} checked={phone.on} onChange={(to) => { setPhoneUsage(to); }} />
        </Row>
      ) : null}
    </Group>
  );
}

const SHOWN_CHANGES = 8;

/** Show the recorded actor's role and name, or a source without actor attribution. */
function Who(props: { by: SecurityChange['by'] }) {
  const origin = changeOrigin(props.by);
  if (origin.kind === 'source') return <div>Source: {origin.name}</div>;
  return (
    <div>Changed by: {origin.role} · {origin.href
      ? <a href={origin.href}>{origin.name}</a>
      : origin.name}
    </div>
  );
}

function ChangeRow(props: { change: SecurityChange }) {
  const { change } = props;
  const [open, setOpen] = useState(false);
  const label = fieldName(change.field);
  const details = opensToTexts(change);
  const preview = changeValues(change);
  return (
    <Row class="sec-change"
      label={details
        ? <button type="button" class="sec-change-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>{label}
        </button>
        : label}
      hint={<>
        <Who by={change.by} />
        {(change.fromLength !== undefined || change.toLength !== undefined) &&
          <div>Only the beginning of long values is shown. A change beyond it may not be visible here.</div>}
        {open
          ? <><span class="sec-change-cap">Before</span><span class="sec-change-text">{change.from || '(empty)'}</span><span class="sec-change-cap">After</span><span class="sec-change-text">{change.to || '(empty)'}</span></>
          : <div class="sec-change-preview" title={details ? preview : undefined}>{preview}</div>}
      </>}>
      <Note><span title={fullDate(change.at)}>{logTime(change.at)}</span></Note>
    </Row>
  );
}

export function ChangesGroup(props: { token: string; topics: Partial<Record<string, TopicText>> | null | undefined }) {
  const [changes, setChanges] = useState<SecurityChange[] | null | undefined>(undefined);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    rpc.call('settings.securityLog').then((list) => { if (live) setChanges(list); }, () => { if (live) setChanges(null); });
    return () => { live = false; };
  }, [props.token, props.topics]);
  if (changes === null) return null; // this session may not read the log
  const list = changes ?? [];
  const evicted = list.find((entry) => entry.evictedTotal !== undefined)?.evictedTotal ?? 0;
  const shown = all ? list : list.slice(0, SHOWN_CHANGES);
  return (
    <Group title="Changes" hint={`This local history keeps the latest ${SECURITY_LOG_MAX} entries and up to ${SECURITY_LOG_TEXT} characters per value. This covers security switches, library sharing and agreement texts, not every security event. File edits are not attributed to a person or agent; a person entry identifies the session, not who operated it. Quick edits may appear as one. The history is not tamper-proof.`}>
      {shown.length === 0
        ? <Row label="" stack><Note>{changes ? 'No changes yet.' : ''}</Note></Row>
        : shown.map((change, index) => <ChangeRow key={`${change.at}-${change.field}-${list.length - index}`} change={change} />)}
      {evicted > 0 && <Row label="" stack><Note>At least {evicted} older {evicted === 1 ? 'entry was' : 'entries were'} removed to keep this history within its limit.</Note></Row>}
      {list.length > shown.length && <Row label="" stack><ActionButton variant="ghost" label={`Show all ${list.length}`} onClick={() => setAll(true)} /></Row>}
    </Group>
  );
}
