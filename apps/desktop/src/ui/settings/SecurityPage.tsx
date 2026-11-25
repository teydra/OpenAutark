// Settings › Security (owner 19.11.2026: two modes per company – "Trust AI Mode … der Full Access Mode, den wir aktuell
// haben" and the Secure mode, "wie beim alten … man kann einzeln einstellen"), a view on settings.json `security`
// (shared/model/security-settings.ts) and the topic files under <data>/security/<mode>/ (security.topics / saveTopic):
// (1) Mode – Trust AI | Secure with two reserved lines saying what the mode means; a change needs Edit and then
// "Yes, change it" every time (security-fields.tsx ModeRow), and the Manager hears of it (onboarding/security-mode.ts).
// (6, last so an answer moves nothing above it) Waiting requests – what agents need that is closed now (security-requests.tsx). (3) Trust AI: Agreements – one
// text per topic (each a file), the three switches for the gravest steps (Yes / Ask) with their texts under them.
// Secure: What the team does on its own – one row per switch with its choices, the folder or app list where it has one
// and an optional note under each (security-switches.tsx), money fixed closed; then the two remaining agreements. The
// texts security-model.ts needsDoubleConfirm names are read-only until Edit and "Yes, change it", every time.
// Umzug 21.11.2026 (PCSEC): the head names this PC ("This PC – <name>") with one line that each PC keeps its own mode, and
// holds, under the mode in both modes, what calls from agents on the person's other PCs get here (otherPcs).
// (4) Public library and (5) Changes (security-changes.tsx). A session that may not change the company's settings sees
// everything read-only (canEditOwnerSettings, as on General).
// Owns: the page's order and the topic texts it shows. Never: holds a switch's value of its own, edits an agent's text,
// or decides what a switch does at run time.

import { useEffect, useState } from 'preact/hooks';
import type { TopicText } from '../../shared/api/methods-security-mode.ts';
import {
  SECURE_EXTRA_TOPICS, SECURITY_LABELS, SECURITY_SWITCHES, TRUST_SWITCHES, TRUST_TOPICS,
  type SecurityMode, type SecuritySettings, type SecurityTopic,
} from '../../shared/model/security-settings.ts';
import { securityOf, type Settings } from '../../shared/model/system.ts';
import { isPersonSession } from '../lib/people.ts';
import { rpc } from '../lib/rpc.ts';
import { can, canEditOwnerSettings, HTTPS_NOTE, PC_NOTE, session } from '../lib/session.ts';
import { settings } from '../lib/store.ts';
import { Group } from './controls.tsx';
import { ChangesGroup, LibraryGroup, UsageGroup } from './security-changes.tsx';
import { ModeRow, TopicField } from './security-fields.tsx';
import { plainNote } from './security-model.ts';
import { RequestsGroup } from './security-requests.tsx';
import { ScopeList, SwitchRow } from './security-switches.tsx';
import { usageOn } from './usage-count.ts';

/** The note of a session that may not change the company's settings (as on General). */
function lockNote(): string {
  if (isPersonSession()) return 'Set by the owner of the organisation';
  const info = session.value;
  return info?.kind === 'device' && info.capabilities.includes('settings') && !info.secure ? HTTPS_NOTE : PC_NOTE;
}

type Topics = Partial<Record<SecurityTopic, TopicText>>;

/** This PC's name (the PC this app's runtime runs on), once the device list is there; again after a reconnect. */
function useThisPc(): string | undefined {
  const [name, setName] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () => { if (can('devices.list')) rpc.call('devices.list').then((list) => { if (live) setName(list.find((device) => device.self)?.name); }, () => undefined); };
    load();
    const off = rpc.onOpen(load);
    return () => { live = false; off(); };
  }, []);
  return name;
}

/** The shown mode's topic texts (null: this session may not read them); again after a settings change or a reconnect. */
function useTopics(mode: SecurityMode): [Topics | null | undefined, (text: TopicText) => void] {
  const [loaded, setLoaded] = useState<{ mode: SecurityMode; topics: Topics | null } | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    rpc.call('security.topics', { mode }).then(
      (list) => { if (live) setLoaded({ mode, topics: Object.fromEntries(list.map((text) => [text.topic, text])) }); },
      () => { if (live) setLoaded({ mode, topics: null }); },
    );
    return () => { live = false; };
  }, [mode, tick]);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const offs = [rpc.on('settings.updated', again), rpc.onOpen(again)];
    return () => { for (const off of offs) off(); };
  }, []);
  const topics = loaded?.mode === mode ? loaded.topics : undefined; // another mode's texts never show under this one
  return [topics, (text) => setLoaded((now) => (now?.mode === mode ? { mode, topics: { ...now.topics, [text.topic]: text } } : now))];
}

interface Shown { mode: SecurityMode; security: SecuritySettings; topics: Topics | undefined; editable: boolean; saved: (text: TopicText) => void }

/** A text field of the shown mode; `under` = it sits under its switch. */
function Topic(props: Shown & { topic: SecurityTopic; under?: boolean }) {
  const { mode, topic } = props;
  const plain = props.under && plainNote(mode, topic);
  const label = !props.under ? SECURITY_LABELS[topic] : mode === 'trust' ? 'Agreement' : 'Note for the team';
  return (
    <TopicField mode={mode} topic={topic} text={props.topics?.[topic]} label={plain ? undefined : label} sub={props.under} plain={plain}
      rows={props.under ? (plain ? 2 : 3) : topic === 'general' ? 8 : 4} placeholder={props.under ? 'Note for the team (optional)' : topic === 'general' ? 'Describe when agents should ask you first' : undefined}
      editable={props.editable} onSaved={props.saved} />
  );
}

function TrustGroups(props: Shown) {
  return (
    <Group title="Agreements" hint="These are written agreements, not access controls. The app enforces the switches separately; written agreements cannot override them. Your team changes a text only when you clearly want it.">
      {TRUST_TOPICS.map((topic) => (TRUST_SWITCHES as readonly string[]).includes(topic)
        ? (
          <div key={topic} class="sec-block">
            <SwitchRow mode="trust" name={topic as typeof TRUST_SWITCHES[number]} settings={props.security} editable={props.editable} />
            <Topic {...props} topic={topic} under />
          </div>
        )
        : <div key={topic} class="sec-block"><Topic {...props} topic={topic} /></div>)}
    </Group>
  );
}

function SecureGroups(props: Shown) {
  return (
    <>
      <Group title="What the team does on its own" hint="Its own folders are always open. For what you set to Ask, the app asks you first – once, always for that setting, or always for that place.">
        {SECURITY_SWITCHES.map((name) => (
          <div key={name} class="sec-block">
            <SwitchRow mode="secure" name={name} settings={props.security} editable={props.editable} />
            <ScopeList name={name} settings={props.security} editable={props.editable} />
            <Topic {...props} topic={name} under />
          </div>
        ))}
      </Group>
      <Group title="Agreements" hint="These are written agreements, not access controls. They do not override the switches above. Agents can suggest a change, but a person must apply it here.">
        {SECURE_EXTRA_TOPICS.map((topic) => <div key={topic} class="sec-block"><Topic {...props} topic={topic} /></div>)}
      </Group>
    </>
  );
}

function SecurityBody(props: { settings: Settings }) {
  const security = securityOf(props.settings);
  const editable = canEditOwnerSettings();
  const note = lockNote();
  const [topics, saved] = useTopics(security.mode);
  const share = props.settings.library?.publish !== false;
  const shown: Shown = { mode: security.mode, security, topics: topics ?? undefined, editable, saved };
  const pc = useThisPc();
  return (
    <>
      <Group title={pc ? `This PC – ${pc}` : 'This PC'} hint="Each of your PCs keeps its own security mode and switches; these count for everything agents do on this PC">
        <ModeRow mode={security.mode} editable={editable} lockNote={note} />
        <SwitchRow mode={security.mode} name="otherPcs" settings={security} editable={editable} />
      </Group>
      {security.mode === 'trust' ? <TrustGroups {...shown} /> : <SecureGroups {...shown} />}
      <LibraryGroup share={share} locked={!editable} lockNote={note} />
      <UsageGroup on={usageOn(props.settings)} locked={!editable} lockNote={note} />
      <ChangesGroup token={`${JSON.stringify(security)}|${share}`} topics={topics} />
      <RequestsGroup /> {/* last: answering one changes only the page's end, nothing above it moves (review M5) */}
    </>
  );
}

export function SecurityPage() {
  const current = settings.value;
  return current ? <SecurityBody settings={current} /> : null;
}
