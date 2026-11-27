// Profile bubble (bottom of the rail) and its menu: name/company, the companies on this PC (B-072, desktop window only:
// one picked opens its window and this one goes to the tray, its agents keep working) and Settings. B-078: a "+" beside
// the company name opens the add menu in the same place – New company / Connect with an ID (Eine-ID 22.11.2026: no role
// to pick, the ID typed decides) – each starts a new company whose first run opens that way (companies.open start). 16.11.2026: the "+" also
// imports an export as a new company (settings/CompaniesGroup.tsx), and two companies of the same name show their
// folder ("first", "company-2") under the name. 21.11.2026 (owner): under each company a small line names the person's
// role there – "CEO" in their own, how the firm names them in another ("Designer · Kim"). In the phone layout, where
// the rail with its quota badges is hidden, the menu shows the same badges (QuotaRail). B-084 (decision 7): inside the
// Android app (once its port is here) the menu is the phone sheet – the photo, the name and one status line
// "<company> · 2 of 3 PCs online" (only words: every online PC is linked, there is no picker), the companies this phone is paired with (their pictures, the
// current one ticked; a pick lets the app switch), "Add a company" (the app's scanner screens) and Settings. "Forget
// this phone" lives in Settings › Devices now. 20.11.2026 (owner: "ein Drei-Punkte-Menü ... neben der Firma ... dass man da
// austreten kann ... wie Account-Einstellung"): each company row has its ⋯ (MenuItem.more, its slot always there); it
// opens that company's menu in the same place, like the "+": the open one's account pages, Export…, Leave or Delete
// (settings/company-actions.ts; the questions and calls of Settings › General › Companies). The list carries each
// company's facts (role, linked PCs), so Leave and Delete read as there.
// Owns: the bubble and menu. Never: edits the profile itself (the AI or Settings does), opens or switches a company
// itself (main does, through companies.open; on the phone the app, pwa/phone-companies.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { CompanyEntry, CompanyStart } from '../../shared/model/companies.ts';
import { companyLabel, roleLine } from '../../shared/model/companies.ts';
import { HumanAvatar, IconButton, Menu, paletteIndex } from '../lib/ui.tsx';
import type { MenuItem, MenuSection } from '../lib/ui.tsx';
import { avatarInitials } from '../../shared/text/avatar-looks.ts';
import { isMobile, settings } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { comboLabel } from '../lib/hotkeys.ts';
import { bridge, platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { openFeedback } from '../feedback/popover-state.ts';
import { DeleteDialog, exportCompany, importCompany, leaveCompany } from '../settings/CompaniesGroup.tsx';
import { companyLine, companyMenu } from '../settings/company-actions.ts';
import type { CompanyAction } from '../settings/company-actions.ts';
import { isAndroidApp } from '../pwa/native.ts';
import { addCompany, phoneCompanies, phoneStatus, statusLine, switchCompany } from '../pwa/phone-companies.ts';
import type { PhoneCompany } from '../pwa/phone-companies.ts';
import { QuotaRail } from './QuotaRail.tsx';

/** The command palette's Feedback: the header cell's menu (after its screenshot). */
export { openFeedback };

const ITEMS: MenuItem[] = [
  { label: 'Settings', hint: comboLabel('mod+,'), onSelect: () => go.settings() },
];

/** The companies on this PC, kept between openings: the menu opens at its full height, nothing grows under the pointer. */
const companies = signal<CompanyEntry[]>([]);

function loadCompanies(): void {
  if (platform !== 'desktop') return; // a phone or browser belongs to the company it is paired with
  rpc.call('companies.list', { facts: true }).then((result) => { companies.value = result.companies; }, () => { /* the last list stays */ });
}

function openCompany(params: { id: string | null } | { create: true; start: CompanyStart }): void {
  rpc.call('companies.open', params).catch((error: unknown) => toastError(error, 'Could not open the company'));
}

/** The company menu's "+" (B-078): each one starts a new company folder; its first run opens that way (`--start=`). */
const ADD_ITEMS: MenuItem[] = [
  { label: 'New company', description: 'Your own, with its own first run', onSelect: () => openCompany({ create: true, start: 'new' }) },
  { label: 'Connect with an ID', description: 'A company’s ID joins it, your own ID adds this PC as yours', onSelect: () => openCompany({ create: true, start: 'join' }) },
  { label: 'Import a company', description: 'An export from Autark, as a new company here', onSelect: () => { void importCompany(); } }, // 16.11.2026
];

/** The small line under a company: the person's role there ("CEO", "Designer · Kim"), and its folder where another shares its name. */
const describe = (company: CompanyEntry, shared: boolean): string => [roleLine(company), shared ? company.folder : ''].filter(Boolean).join(' · ');

/** The companies (the current one ticked; one whose name another shares names its folder too), each with its ⋯; none where there is no list (a test profile, the PWA). */
function companySections(list: CompanyEntry[], more: (company: CompanyEntry) => void): MenuSection[] {
  if (!list.length) return [];
  const shared = (label: string) => list.filter((other) => other.label === label).length > 1;
  return [{ items: list.map((company) => {
    const line = describe(company, shared(company.label));
    return {
      label: company.label,
      ...(line ? { description: line } : {}),
      checked: company.current,
      onSelect: () => { if (!company.current) openCompany({ id: company.id }); },
      more: { label: `More for ${company.label}`, onSelect: () => more(company) },
    };
  }) }];
}

/** What a row of a company's ⋯ menu does: an account page of Settings, or the company's Export… / Leave / Delete. */
function companyAction(entry: CompanyEntry, action: CompanyAction, remove: (entry: CompanyEntry) => void): void {
  if (action === 'profile') go.settings('general');
  else if (action === 'devices') go.settings('devices');
  else if (action === 'models') go.settings('models');
  else if (action === 'export') void exportCompany(entry);
  else if (action === 'leave') void leaveCompany(entry).then((gone) => { if (gone) loadCompanies(); });
  else remove(entry); // Delete: its two questions
}

/** A phone company's 24 px picture: its card photo, else its initials on a colour from its id. */
function CompanyPic(props: { company: PhoneCompany }) {
  const { avatar, id, name } = props.company;
  return (
    <span class="avatar company-pic" data-color={paletteIndex(id)} aria-hidden="true">
      {avatar ? <img src={avatar} alt="" /> : <span>{avatarInitials(name)}</span>}
    </span>
  );
}

const ADD_COMPANY: MenuItem = { label: 'Add a company', icon: 'plus', description: 'Scan or type another company\'s code', onSelect: () => { addCompany(); } };

/** The phone sheet's sections: the paired companies with "Add a company" under them, then Settings. */
function phoneSections(list: PhoneCompany[]): MenuSection[] {
  const rows: MenuItem[] = list.map((company) => ({
    label: company.name,
    lead: <CompanyPic company={company} />,
    checked: company.current,
    onSelect: () => { if (!company.current) switchCompany(company.id); },
  }));
  return [{ items: [...rows, ADD_COMPANY] }, { items: ITEMS }];
}

export function ProfileButton(props: { size?: number; placement?: 'right-end' | 'bottom-end' }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<CompanyEntry | null>(null); // the company whose ⋯ menu is open
  const [deleting, setDeleting] = useState<CompanyEntry | null>(null);
  const profile = settings.value?.profile;
  const name = profile?.name || 'Profile';
  const canAdd = companies.value.length > 0;
  const phone = isAndroidApp(); // the page is the app's own (owner 27.11.2026): it always has the companies
  const current = phoneCompanies.value.find((company) => company.current);
  useEffect(loadCompanies, []);
  const head = phone ? (
    <div class="profile-head-row phone-head">
      <HumanAvatar size={40} />
      <div class="profile-head-text">
        <span class="profile-name">{name}</span>
        <span class="profile-status">{statusLine(current?.name ?? companyLabel(profile, null), phoneStatus.value)}</span>
      </div>
    </div>
  ) : (
    <div class="profile-head-row">
      <button type="button" class="profile-head" onClick={() => { setOpen(false); go.settings(); }}>
        <span class="profile-name">{name}</span>
        {profile?.company && <span class="profile-company">{profile.company}</span>}
      </button>
      {canAdd && <IconButton icon="plus" label="Add a company" class="profile-add" onClick={() => { setOpen(false); setAdding(true); }} />}
    </div>
  );
  return (
    <>
      <button ref={ref} type="button" class="profile-button" aria-label="Profile menu" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) loadCompanies(); setOpen(!open); }}>
        <HumanAvatar size={props.size ?? 36} />
      </button>
      <Menu
        anchor={ref.current}
        open={open}
        onClose={() => setOpen(false)}
        placement={props.placement ?? 'right-end'}
        width={256}
        class="profile-menu"
        label="Profile"
        header={
          <>
            {head}
            {isMobile.value && <div class="profile-quota"><QuotaRail /></div>}
          </>
        }
        sections={phone ? phoneSections(phoneCompanies.value) : [...companySections(companies.value, setActing), { items: ITEMS }]}
      />
      <Menu anchor={ref.current} open={!!acting} onClose={() => setActing(null)} placement={props.placement ?? 'right-end'} width={256} class="profile-menu" label={acting?.label}
        header={acting && <div class="company-head"><span class="profile-name">{acting.label}</span><span class="profile-company">{companyLine(acting)}</span></div>}
        sections={acting ? [{ items: companyMenu(acting, { only: companies.value.length < 2, canExport: !!bridge?.files.pickFolder }).map((row) => ({ ...row, onSelect: () => companyAction(acting, row.action, setDeleting) })) }] : []} />
      <DeleteDialog entry={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); loadCompanies(); }} />
      <Menu anchor={ref.current} open={adding} onClose={() => setAdding(false)} placement={props.placement ?? 'right-end'} width={280} class="profile-menu" label="Add a company" sections={[{ items: ADD_ITEMS }]} />
    </>
  );
}
