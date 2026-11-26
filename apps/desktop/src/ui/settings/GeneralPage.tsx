// Settings › General (B-078, D17 – owner 06.11.2026: only what is really worth it): profile (photo, name, company),
// appearance (the theme, on the PC's window only – a phone follows its own light/dark; finer looks are <data>/theme.css;
// 21.11.2026 the Labels and Text sizes in px, kept on this device – lib/text-size.ts),
// notifications (the sound – to-dos, blockers and important
// messages always arrive, notify/service.ts) and behaviour (start at login – desktop window only; closing the window
// always keeps agents running in the tray, the tray's Quit ends them (20.11.2026: no second toggle for that) –, keep this
// PC awake without keeping the screen on, Enter sends). Language and time zone come from the PC; the AI notices the
// language the person speaks and keeps profile.language and profile.notes itself (skill app-settings). The removed rows'
// keys stay in settings.json for the AI. Every row is a view on settings.json. A securely paired owner phone
// also edits profile and day, and (owner 12.11.2026) the PC's own start at login, marked as changing the PC (the automatic
// update download sits in About, beside the version, on every device); colleagues and plain-LAN devices do not.
// 16.11.2026: last, the companies on this PC like accounts – export, import, leave, delete (CompaniesGroup.tsx).
// Owns: these rows and their mapping onto Settings fields. Never: invents options without effect.

import type { NotificationSettings, Preferences, Profile } from '../../shared/model/system.ts';
import { HumanAvatar } from '../lib/avatar.tsx';
import { uploadFile } from '../lib/files.ts';
import { isPersonSession } from '../lib/people.ts';
import { bridge, os } from '../lib/platform.ts';
import { canEditOwnerSettings, canUploadOwnerPhoto, HTTPS_NOTE, PC_NOTE, session } from '../lib/session.ts';
import { settings, systemInfo, updateSettings } from '../lib/store.ts';
import { CompaniesGroup } from './CompaniesGroup.tsx';
import { LABELS, labelPx, setSize, TEXT, textPx } from '../lib/text-size.ts';
import { act, CLEAR, Group, PxField, Row, Segmented, TextField, Toggle } from './controls.tsx';

const START_HINT = 'Opens the app when the PC starts and keeps agents working in the background';
const THEMES = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as const;

export function GeneralPage() {
  const value = settings.value;
  if (!value) return null;
  const profile = value.profile;
  const prefs = value.preferences;
  const notes = value.notifications;
  const setProfile = (patch: Partial<Profile>) => act(() => updateSettings({ profile: patch }), 'Could not save');
  const setPrefs = (patch: Partial<Preferences>) => act(() => updateSettings({ preferences: patch }), 'Could not save');
  const setNotes = (patch: Partial<NotificationSettings>) => act(() => updateSettings({ notifications: patch }), 'Could not save');
  const locked = !canEditOwnerSettings();
  const photoUpload = canUploadOwnerPhoto();
  const lockNote = session.value?.kind === 'device' && session.value.capabilities.includes('settings') && !session.value.secure ? HTTPS_NOTE : PC_NOTE;
  const person = isPersonSession();
  const installed = systemInfo.value?.packaged === true; // the launcher registers only in the installed app
  const pcOs = bridge ? os : systemInfo.value?.platform === 'win32' ? 'windows' : 'other'; // the PC's, not this phone's
  const start = pcOs === 'windows' ? 'Start with Windows' : 'Start at login';
  const remote = !bridge && !locked; // my secure phone changes the PC's behaviour from here
  const onPc = (hint: string) => (remote ? `On your PC: ${hint}` : hint);

  const pickPhoto = () => {
    if (!canUploadOwnerPhoto()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void act(async () => { const ref = await uploadFile(file); await updateSettings({ profile: { avatarFileId: ref.fileId } }); }, 'Could not upload photo');
    };
    input.click();
  };

  return (
    <>
      <Group title="Profile" hint={locked ? (person ? 'Your name and title are set by the owner of the organisation' : lockNote) : undefined}>
        <Row label="Photo" hint={!locked && !photoUpload ? 'Uploading a photo needs file access on this device' : undefined}>
          <div class="set-inline">
            <HumanAvatar size={36} />
            {photoUpload && <button type="button" class="button secondary small" onClick={pickPhoto}>Change</button>}
            {!locked && <button type="button" class="button ghost small" disabled={!profile.avatarFileId} onClick={() => void setProfile({ avatarFileId: CLEAR })}>Remove</button>}
          </div>
        </Row>
        <Row label="Your name"><TextField label="Your name" value={profile.name} disabled={locked} onCommit={(name) => void setProfile({ name: name.trim() })} /></Row>
        <Row label="Company" hint="Used by your agents"><TextField label="Company" value={profile.company} disabled={locked} onCommit={(company) => void setProfile({ company: company.trim() })} /></Row>
      </Group>

      <Group title="Appearance">
        {bridge && ( // feedback 16.11.2026 F15: a phone follows its own light/dark (lib/theme.ts), so the setting is the PCs'
          <Row label="Theme" hint="More of the look is theme.css in the data folder – ask your AI" reserve>
            <Segmented label="Theme" value={prefs.theme} options={[...THEMES]} onChange={(theme) => void setPrefs({ theme })} />
          </Row>
        )}
        {/* owner 21.11.2026: two text sizes in px, kept on this device (lib/text-size.ts) */}
        <Row label="Labels size" hint={`Headings, chat names, setting names and other short texts · ${LABELS.min}–${LABELS.max} px, ${LABELS.base} by default`}>
          <PxField label="Labels size" value={labelPx.value} min={LABELS.min} max={LABELS.max} onCommit={(px) => setSize(LABELS, px)} />
        </Row>
        <Row label="Text size" hint={`Chats, prompts and other long texts · ${TEXT.min}–${TEXT.max} px, ${TEXT.base} by default${bridge ? ` – also ${os === 'mac' ? '⌘' : 'Ctrl'} + and −` : ''}`}>
          <PxField label="Text size" value={textPx.value} min={TEXT.min} max={TEXT.max} onCommit={(px) => setSize(TEXT, px)} />
        </Row>
      </Group>

      <Group title="Notifications">
        <Row label="Sound" hint="To-dos for you, blockers and important messages always arrive">
          <Toggle label="Sound" checked={notes.sound} onChange={(sound) => void setNotes({ sound })} />
        </Row>
        <Row label="While an agent uses this PC" hint="A line at the bottom says who and what, with Watch to open the screen">
          <Toggle label="Show a line while an agent uses this PC" checked={notes.computerUse} onChange={(computerUse) => void setNotes({ computerUse })} />
        </Row>
      </Group>

      <Group title="Behavior">
        {(bridge || remote) && (
          <Row label={start} hint={onPc(installed ? START_HINT : `${START_HINT} – in the installed app`)} disabled={!installed}>
            <Toggle label={start} checked={prefs.openAtLogin} disabled={!installed} onChange={(openAtLogin) => void setPrefs({ openAtLogin })} />
          </Row>
        )}
        {(bridge || remote) && (
          <Row label="Keep this PC awake" hint={onPc('Stays awake on mains power; on battery only for active turns or queued night work. The screen may turn off.')}>
            <Toggle label="Keep this PC awake" checked={prefs.keepPcAwake} onChange={(keepPcAwake) => void setPrefs({ keepPcAwake })} />
          </Row>
        )}
        {bridge && ( // 26.11.2026, Stanislaus: no "Enter sends" on the phone – it is a keyboard setting of the PC
          <Row label="Enter sends" hint={prefs.enterSends ? 'Shift+Enter for a new line' : 'Ctrl+Enter sends'}>
            <Toggle label="Enter sends" checked={prefs.enterSends} onChange={(enterSends) => void setPrefs({ enterSends })} />
          </Row>
        )}
      </Group>

      <CompaniesGroup />
    </>
  );
}
