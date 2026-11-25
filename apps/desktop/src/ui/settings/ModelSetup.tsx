// The model setup – the first run's AI card and Settings › Models show the same: the plans on this PC (Claude Code
// and Codex always, Kimi Code / Gemini CLI / Copilot CLI when found) with their state – a connected one as its account
// row (AccountRow.tsx, with its models); a plan login this PC found (or another company on it made) that is no account here
// as a "Found: … – use in this company?" row with Use / Not here (17.11.2026: used and shared only after Use) –, `children` (Settings: the other connections), the provider key variables set on
// this PC not in use yet (Use), one fixed row of four buttons –
// Claude plan, Codex plan (plan-actions.tsx: add an account and sign in, install if needed), API key and Local server (both open
// the one connection form inline under it, account-forms.tsx) – with the sign-in link cell and one status line for the
// plan flow, and the sheet of a sign-in started from the phone (SignInSheet.tsx). Settings shows the use rows under it
// (ModelUses.tsx).
// 24.11.2026: e-mail addresses show masked ("s…@gmail.com", ui/lib/email-mask.ts – one mask for every address on the screen,
// so two stay apart), the whole address in the row's title.
// Owns: this layout and its PC scan (accounts.detect, again after a plan flow). Never: a flow's steps (plan-setup.ts).

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { envKeyProvider, type DetectionReport, type FoundLogin } from '../../shared/model/providers.ts';
import { choose } from '../lib/dialog.tsx';
import { rpc } from '../lib/rpc.ts';
import { accounts, loadModels, settings } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { PlanButtons, planFlow, usePlanRescan } from '../onboarding/plan-actions.tsx';
import { PLAN_PROVIDERS } from '../onboarding/plan-setup.ts';
import { SignInLink } from '../onboarding/sign-in-link.tsx';
import { signInStarted } from './account-actions.ts';
import { ConnectionForm } from './account-forms.tsx';
import { AccountRow } from './AccountRow.tsx';
import { ActionButton, Row, useBusy } from './controls.tsx';
import { SignInSheet } from './SignInSheet.tsx';
import { cliRowView, groupAccounts, needsSignIn, PC_CLIS, PROVIDER_NAMES, stateLabel } from './providers.ts';
import { foundText } from './extra-usage.ts';
import { emailMasker } from '../lib/email-mask.ts';

type Cli = DetectionReport['clis'][number];

/** The plans with a button; the others are listed only when found. */
const WITH_BUTTON: ReadonlySet<string> = new Set<string>(PLAN_PROVIDERS);

/** A plan CLI without a connected account: its state, and the one action the buttons do not cover. */
function CliRow(props: { cli: Cli; scanned: boolean; onChanged: () => void }) {
  const [busy, run] = useBusy();
  const view = cliRowView(props.cli, accounts.value);
  const provider = props.cli.provider;
  const covered = WITH_BUTTON.has(provider) && (view.action === 'install' || view.action === 'sign-in');
  const action = props.scanned && !covered ? view.action : undefined;
  const add = (detected: boolean) => void run(async () => {
    const added = await rpc.call('accounts.add', { provider, ...(detected ? { detected: true } : {}) });
    if (needsSignIn(added)) signInStarted(added.id, added.provider, added);
    else pushToast({ title: `${view.name}: ${stateLabel(added)}` });
  });
  return (
    <Row class="cli-row" label={view.name} hint={props.scanned ? view.hint : 'Looking…'} reserve>
      <span class="account-slot">
        {(action === 'sign-in' || action === 'add') && <ActionButton label="Sign in" busy={busy} onClick={() => add(false)} />}
        {action === 'add-again' && <ActionButton label="Add again" busy={busy} onClick={() => add(true)} />}
        {action === 'check' && <ActionButton label="Check again" busy={busy} onClick={props.onChanged} />}
      </span>
    </Row>
  );
}

/**
 * A plan login on offer (accounts.detect → found): no account yet – nothing uses it and no PC of the company gets it –
 * until Use; Not here keeps it out of this company (it stays on the PC). A declined one of another company can still be used.
 */
function FoundRow(props: { found: FoundLogin; cli: Cli | undefined; mask: (email: string) => string; onChanged: () => void }) {
  const { found } = props;
  const [busy, run] = useBusy();
  const text = foundText(found, props.cli, props.mask);
  const name = PROVIDER_NAMES[found.provider] ?? found.provider;
  // 17.11.2026 (Konrad #109): "Use" asks where the login goes; only "On all PCs of this company" syncs it.
  // 0.3.20 (Konrad #830, 24.11.2026): they are the person's own PCs \u2013 "On all PCs of this company" is the preselected answer.
  const use = async () => {
    const where = await choose({
      title: `Use ${name} in this company?`,
      body: found.where === 'this-pc' ? 'It is signed in on this PC. Where should it be used?' : 'Another company on this PC made this sign\u2011in. Where should it be used?',
      choices: [
        { value: 'company', label: 'On all PCs of this company', hint: 'The account and its sign\u2011in go to every PC of this company' },
        { value: 'pc', label: 'Only on this PC', hint: 'The company\'s other PCs get neither the account nor the sign\u2011in' },
      ],
      value: 'company', confirmLabel: 'Use',
    });
    if (where === null) return;
    await run(async () => {
      const added = await rpc.call('accounts.useFound', { key: found.key, thisPcOnly: where === 'pc' });
      accounts.value = await rpc.call('accounts.list');
      props.onChanged();
      pushToast({ title: `${name}: ${stateLabel(added)}`, body: where === 'pc' ? 'Used on this PC only.' : 'Used on all PCs of this company.' });
    });
  };
  const decline = () => void run(async () => {
    await rpc.call('accounts.declineFound', { key: found.key });
    props.onChanged();
    pushToast({ title: `${name} not used here`, body: 'Still signed in on this PC.' });
  });
  return (
    <Row class={`found-row${found.declined ? ' declined' : ''}`} label={<span title={found.email}>{text.label}</span>} hint={text.hint}>
      <span class="found-actions">
        <ActionButton variant={found.declined ? 'secondary' : 'primary'} label="Use" busy={busy} onClick={() => void use()} />
        {!found.declined && <ActionButton label="Not here" disabled={busy} onClick={decline} />}
      </span>
    </Row>
  );
}

/** A provider key variable set on this PC (PR5): Use reads it while the app runs; its value never travels or is stored. */
function EnvKeyRow(props: { name: string }) {
  const { name } = props;
  const [busy, run] = useBusy();
  const provider = envKeyProvider(name);
  if (!provider || provider === 'ollama' || accounts.value.some((account) => account.auth === 'env' && account.envVar === name)) return null;
  const typed = accounts.value.some((account) => account.provider === provider && account.auth !== 'env');
  const use = () => void run(async () => {
    await rpc.call('accounts.add', { provider, envVar: name });
    pushToast({ title: `${PROVIDER_NAMES[provider] ?? provider} connected`, body: `Autark reads the key from ${name} while it runs and never stores it.` });
  });
  return (
    <Row label={PROVIDER_NAMES[provider] ?? provider} hint={`Key in ${name}${typed ? ' · already connected with another key' : ''}`} reserve>
      <span class="account-slot"><ActionButton label="Use" busy={busy} onClick={use} /></span>
    </Row>
  );
}

export function ModelSetup(props: { children?: ComponentChildren }) {
  const [report, setReport] = useState<DetectionReport | null>(null);
  const [scanned, setScanned] = useState(false);
  const [form, setForm] = useState<'api' | 'local' | null>(null);
  const scan = async (force = false) => {
    try {
      setReport(await rpc.call('accounts.detect', force ? { force: true } : undefined));
      accounts.value = await rpc.call('accounts.list'); // the local servers the scan adopted (a plan login is only offered: `found`)
      void loadModels(force);
    } catch { /* the rows still show; the buttons say what is missing */ } finally { setScanned(true); }
  };
  // A dismissal or deliberate re-enable on another PC also refreshes an already-open Models view.
  const declined = JSON.stringify(settings.value?.preferences.declinedLogins ?? []);
  useEffect(() => { void scan(); }, [declined]);
  usePlanRescan(() => void scan(true));
  const toggle = (next: 'api' | 'local') => setForm(form === next ? null : next);
  const view = planFlow.value.view;
  const server = report?.localServers.find((found) => !accounts.value.some((account) => account.baseUrl === found.baseUrl));
  const mask = emailMasker([...accounts.value.map((account) => account.email), ...(report?.found ?? []).map((found) => found.email)]);
  return (
    <>
      {PC_CLIS.flatMap((provider) => {
        const list = groupAccounts(accounts.value.filter((account) => account.provider === provider && account.auth === 'cli'))[0]?.accounts ?? [];
        const cli = report?.clis.find((entry) => entry.provider === provider);
        const offers = (report?.found ?? []).filter((found) => found.provider === provider)
          .map((found) => <FoundRow key={found.key} found={found} cli={cli} mask={mask} onChanged={() => void scan()} />);
        if (list.length) return [...list.map((account) => <AccountRow key={account.id} account={account} siblings={list} mask={mask} />), ...offers];
        if (offers.length) return offers; // the offer says what the plan row would: signed in on this PC, not used here yet
        return WITH_BUTTON.has(provider) || cli?.path ? [<CliRow key={provider} cli={cli ?? { provider }} scanned={scanned} onChanged={() => void scan(true)} />] : [];
      })}
      {props.children}
      {report?.envKeys.map((name) => <EnvKeyRow key={name} name={name} />)}
      <div class="model-setup-buttons">
        <PlanButtons report={() => report} />
        <Button variant="secondary" class="small" aria-pressed={form === 'api'} onClick={() => toggle('api')}>API key</Button>
        <Button variant="secondary" class="small" aria-pressed={form === 'local'} onClick={() => toggle('local')}>Local server</Button>
        <SignInLink url={view?.url} />
      </div>
      <p class={`model-setup-status${view?.tone ? ` ${view.tone}` : ''}`} role="status" title={view?.text}>{view?.text ?? ''}</p>
      {form && <ConnectionForm key={form} kind={form} onDone={() => setForm(null)} {...(form === 'local' && server ? { found: server } : {})} />}
      <SignInSheet />
    </>
  );
}
