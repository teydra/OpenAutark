// The first run's last card, About you: the person's name and the company (settings.profile, also in
// Settings › General) and the company's security mode (owner 19.11.2026: "Beim Onboarding nur den Modus wählen") – two
// radio rows above Start, "Trust AI" (default) or "Secure", one or two sentences each (settings/security-model.ts
// MODE_ROWS; a choice changes only the rows' colour, nothing moves). Start writes settings.json `security` as that
// mode's defaults (firstRunSecurity: Secure starts with much closed; Set up again keeps a company's own switches when
// the mode stays) and ends the first run: onboarding.start has the runtime post the app's start text in the Manager's
// chat as the person's own line, and the Manager answers it; then the short spotlight tour (ui/tour/Spotlight.tsx) runs
// once over that chat. The mode can be changed later in Settings › Security.
// No dictation button here: the app's dictation hooks belong to their own fields (chat, the Tasks page's line, feedback).
// 17.11.2026 (owner 06.11.: sharing stays on by default; it must be seen and easy to turn off): under the mode rows one
// ticked box, "Public library" – unticked, Start writes settings.library.publish false (Settings › Security has the switch).
// The typed name, company, the mode choice and the tick survive a remount (desktop ↔ phone shell) and Back until Start.
// 25.11.2026: below it a second ticked box, "Anonymous usage count" (settings.usage.count, runtime/usage; README › What Autark
// counts) with what is sent – unticked, Start writes usage.count false (Settings › Security has the switch).
// Owns: this card. Never: creates agents, changes a setting other than the profile, security, library.publish and usage.count, or
// draws the tour.

import { useState } from 'preact/hooks';
import type { SecurityMode } from '../../shared/model/security-settings.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { firstRunSecurity, MODE_ROWS } from '../settings/security-model.ts';
import { USAGE_TEXT, USAGE_TITLE, usageOn, usagePatch } from '../settings/usage-count.ts';
import { startSpotlight } from '../tour/Spotlight.tsx';
import { libraryPatch, previousStep, profilePatch } from './first-run-model.ts';
import { finishFirstRun, goStep } from './first-run.ts';
import { Card, StatusLine } from './parts.tsx';

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;

/** What the person typed and chose outlives a remount (the window switching between desktop and phone shell) until Start. */
const draft: { name?: string; company?: string; mode?: SecurityMode; share?: boolean; usage?: boolean } = {};

/** The tick's text (the README's "The public library" says the same in full). */
export const SHARE_TITLE = 'Public library';
export const SHARE_TEXT = 'Your agents may share skills and notes worth sharing with everyone (public, CC0). Each text is checked for secrets, paths, e-mail addresses and internal names first, and what fails a check stays here.';

export function AboutCard() {
  const profile = settings.value?.profile;
  const [name, setNameState] = useState(draft.name ?? profile?.name ?? '');
  const [company, setCompanyState] = useState(draft.company ?? profile?.company ?? '');
  const [mode, setModeState] = useState<SecurityMode>(draft.mode ?? settings.value?.security?.mode ?? 'trust');
  const setName = (next: string) => { draft.name = next; setNameState(next); };
  const setCompany = (next: string) => { draft.company = next; setCompanyState(next); };
  const setMode = (next: SecurityMode) => { draft.mode = next; setModeState(next); };
  const [share, setShareState] = useState(draft.share ?? settings.value?.library?.publish !== false);
  const setShare = (next: boolean) => { draft.share = next; setShareState(next); };
  const [usage, setUsageState] = useState(draft.usage ?? usageOn(settings.value)); // 25.11.2026: the anonymous usage count, on unless unticked
  const setUsage = (next: boolean) => { draft.usage = next; setUsageState(next); };
  const [busy, setBusy] = useState<'start' | 'back' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const start = async () => {
    setBusy('start');
    setError(undefined);
    try {
      const patch = profilePatch(settings.value?.profile, name, company);
      const library = libraryPatch(settings.value?.library, share);
      const security = firstRunSecurity(settings.value?.security, mode);
      const count = usagePatch(settings.value?.usage, usage);
      if (patch || library || security || count) await updateSettings({ ...(patch ? { profile: patch } : {}), ...(library ? { library } : {}), ...(security ? { security } : {}), ...(count ? { usage: count } : {}) });
      await finishFirstRun();
      delete draft.name; delete draft.company; delete draft.mode; delete draft.share; delete draft.usage; // saved: a later "Set up again" starts from the settings
      startSpotlight(); // B-085: the short tour over the Manager's chat the first run just opened
    } catch (failure) { toastError(failure, 'Could not start'); setError('Could not start – try again.'); } finally { setBusy(null); }
  };
  const back = async () => {
    setBusy('back');
    try {
      const patch = profilePatch(settings.value?.profile, name, company); // typed text is kept when going back; the mode is saved with Start
      await goStep(previousStep('about'), patch ? { profile: patch } : {});
    } catch (failure) { toastError(failure, 'Could not go back'); } finally { setBusy(null); }
  };
  return (
    <Card id="first-run-about" title="About you" actions={<>
      <Button variant="secondary" busy={busy === 'back'} disabled={busy !== null} onClick={() => void back()}>Back</Button>
      <Button variant="primary" busy={busy === 'start'} disabled={busy !== null} onClick={() => void start()}>Start</Button>
    </>}>
      <div class="first-run-fields">
        <label class="first-run-field">
          <span class="field-label">Your name</span>
          <input class="input" autocomplete="name" maxLength={120} value={name} onInput={(event) => setName(value(event))} />
        </label>
        <label class="first-run-field">
          <span class="field-label">Company</span>
          <input class="input" autocomplete="organization" maxLength={200} placeholder="Optional" value={company} onInput={(event) => setCompany(value(event))} />
        </label>
      </div>
      <fieldset class="first-run-access">
        <legend class="field-label">Security</legend>
        {MODE_ROWS.map((row) => (
          <label key={row.id} class={`first-run-access-row${mode === row.id ? ' chosen' : ''}`}>
            <input type="radio" name="first-run-mode" value={row.id} checked={mode === row.id} onChange={() => setMode(row.id)} />
            <span class="first-run-access-text"><span class="first-run-access-title">{row.title}</span> – {row.text}</span>
          </label>
        ))}
      </fieldset>
      <label class={`first-run-access-row first-run-share${share ? ' chosen' : ''}`}>
        <input type="checkbox" checked={share} onChange={(event) => setShare(event.currentTarget.checked)} />
        <span class="first-run-access-text"><span class="first-run-access-title">{SHARE_TITLE}</span> – {SHARE_TEXT}</span>
      </label>
      <label class={`first-run-access-row first-run-share${usage ? ' chosen' : ''}`}>
        <input type="checkbox" checked={usage} onChange={(event) => setUsage(event.currentTarget.checked)} />
        <span class="first-run-access-text"><span class="first-run-access-title">{USAGE_TITLE}</span> – {USAGE_TEXT}</span>
      </label>
      <StatusLine text={error} tone="error" />
    </Card>
  );
}
