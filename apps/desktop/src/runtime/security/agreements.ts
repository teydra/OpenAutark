// The stable prompt's section "## What <name> and I agreed" (owner 19.11.2026, context/prompt-stable.ts, before the
// person's own lines): the security mode in the agent's own voice. Trust AI mode: one line on the mode and where the
// agreements live (the agent changes one only when the person clearly wants it), a fact line for each of the three
// gravest switches set to ask, then each Trust topic text under its heading. Secure mode: one paragraph on what closed
// means (the app holds it and asks; work goes on with what is open; no way around), a fact line per switch in the order
// of SECURITY_SWITCHES with that topic's note below it, then the general and bot-check texts. The runtime holds the
// switches closed (runtime/security/policy.ts); these lines are the facts, the agent hears them before it meets the gate.
// Umzug 21.11.2026 (PCSEC): in both modes one more fact line where `otherPcs` is not yes (what calls from agents on
// the person's other PCs get on this PC). Deterministic: the same settings, texts and folder give the same bytes.
// Owns: these words. Never: reads files or settings itself (the caller passes them), decides a call.

import {
  otherPcsOf, SECURE_EXTRA_TOPICS, SECURITY_LABELS, SECURITY_SWITCHES, TRUST_SWITCHES, TRUST_TOPICS,
  type SecurityMode, type SecuritySettings, type SecuritySwitch, type SecurityTopic,
} from '../../shared/model/security-settings.ts';

export interface AgreementsInput {
  /** The stored section (securityOf), not effective(): Secure mode reads every switch, Trust AI mode only its three. */
  security: SecuritySettings;
  /** The person's name, or "the person". */
  name: string;
  /** The folder of a mode's topic files (<data>/security/<mode>). */
  folder: (mode: SecurityMode) => string;
  /** A topic's text as the team reads it ('' = none). */
  text: (mode: SecurityMode, topic: SecurityTopic) => string;
}

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const list = (items: readonly string[]): string => items.join(', ');

/** What a switch is about, in the agent's words. */
function what(key: SecuritySwitch, name: string): string {
  if (key === 'phone') return `Operating ${name}'s phone`;
  if (key === 'message') return 'Messages to people outside the company';
  if (key === 'web') return 'The web';
  return SECURITY_LABELS[key];
}

/** What "the app asks <name> before …" each time names. */
const EACH: Readonly<Record<SecuritySwitch, string>> = {
  read: 'each file elsewhere', write: 'each change elsewhere', commands: 'each command', web: 'each search, page or download',
  computer: 'each app I operate', phone: 'each use of it', message: 'each message', publish: 'each post',
  accounts: 'each sign-in, new account or use of a stored password',
  setup: 'each change to the settings, other agents\' instructions, shared skills, modes, prompts or the theme',
  team: 'each hire, change or archive of an agent', money: 'each payment', otherPcs: 'each one runs here',
};

/** The fact line of `otherPcs` when it is not yes ('' then). */
function otherPcsFact(security: SecuritySettings, name: string): string {
  const value = otherPcsOf(security);
  if (value === 'yes') return '';
  return `- Calls from agents on other PCs: ${value === 'ask' ? `the app asks ${name} before ${EACH.otherPcs}` : 'this PC refuses them'}.`;
}

/** The company's own folders as policy.ts ownFolders() has them (FX1 M4: what is open, truthfully). */
const OWN: Readonly<Record<'read' | 'write', string>> = {
  read: "the team's own folders: the workspace and its projects, the company's data folder (not its keys, secrets, sign-ins or database), the app's resources and the temp folders",
  write: "the team's own folders: the workspace and its projects (not its shared skills), my home and the memory in the company's data folder, and the temp folders",
};

/** A topic text's heading (the general text: how I decide in Trust AI mode, when I check in Secure mode). */
function heading(mode: SecurityMode, topic: SecurityTopic, name: string): string {
  if (topic === 'general') return mode === 'trust' ? '### How I decide' : `### When I check with ${name}`;
  if (topic === 'captcha') return `### ${SECURITY_LABELS.captcha}`;
  return `### ${what(topic, name)}`;
}

/** A Secure-mode fact line of one switch. */
function secureFact(security: SecuritySettings, key: SecuritySwitch, name: string): string {
  const label = what(key, name);
  const asks = `the app asks ${name}`;
  if (key === 'money') return `${label}: closed – the app refuses stored cards and its spending tools, whatever a chat says; a payment the app can't see (a shop's saved card behind a Buy button) is still mine not to make.`;
  if (key === 'read' || key === 'write') {
    if (security[key] === 'all') return `${label}: open everywhere on this PC.`;
    const folders = key === 'read' ? security.readFolders : security.writeFolders;
    return `${label}: open in ${OWN[key]}${folders.length ? ` and in ${list(folders)}` : ''}; elsewhere ${asks} first.`;
  }
  if (key === 'computer') {
    const own = 'Autark\'s own window is never mine to operate.';
    if (security.computer === 'yes') return `${label}: open for every app; ${own}`;
    if (security.computer === 'chosen' && security.computerApps.length) return `${label}: open for ${list(security.computerApps)}; for any other app ${asks} first; ${own}`;
    return `${label}: ${asks} before ${EACH.computer}; ${own}`;
  }
  return security[key] === 'yes' ? `${label}: open.` : `${label}: ${asks} before ${EACH[key]}.`;
}

/**
 * 25.11.2026 (Andrea Griffiths' test: a declined command, and the agent still said it was done): a step the app held or
 * the person declined did not happen, whatever an engine's own wording says – never reported as done.
 */
export function blockedRule(name: string): string {
  return `A step the app blocked or ${name} declined did not happen: I never report it, or the work that needed it, as done – my answer says plainly what was blocked and what is still missing.`;
}

/** A text indented under its bullet. */
const under = (text: string): string => text.split('\n').map((line) => (line.trim() ? `  ${line}` : '')).join('\n');

/** The section's text ('' never: the mode line always stands). */
export function agreementsSection(input: AgreementsInput): string {
  const { security, name } = input;
  const lines = [`## What ${name} and I agreed`];
  if (security.mode === 'trust') {
    lines.push(`${cap(name)} runs this PC in Trust AI mode: I work wherever the task needs and decide myself; the agreements below say how ${name} wants it done. They are files in ${input.folder('trust')} – I change one when ${name} clearly wants it changed, in their own words, not because it would suit me. The PC's own permission requests – a Yes, a password, an administrator prompt – and the lock screen are mine to answer too, on any device: with the code or password from the secrets catalog I approve and unlock myself, ${name} doesn't have to.`);
    for (const key of TRUST_SWITCHES) {
      if (security[key] === 'ask') lines.push(`- ${what(key, name)}: the app asks ${name} before ${EACH[key]} and holds it until they answer.`);
    }
    if (TRUST_SWITCHES.some((key) => security[key] === 'ask')) lines.push(`- ${blockedRule(name)}`);
    const others = otherPcsFact(security, name);
    if (others) lines.push(others);
    for (const topic of TRUST_TOPICS) {
      const text = input.text('trust', topic).trim();
      if (text) lines.push('', heading('trust', topic, name), text);
    }
    return lines.join('\n');
  }
  lines.push(`${cap(name)} runs this PC in Secure mode. Some things are closed: the app holds them closed and asks ${name} when I need one – once, always for that setting, or always for that place. While a request waits I keep working on everything that is open; a closed part I don't work around – one clear request with what I need and why does more. ${blockedRule(name)} Before a step that reaches beyond my own work, I take a moment to make sure it is what ${name} wants. These agreements and the security settings are ${name}'s; the app keeps them closed to me.`);
  for (const key of SECURITY_SWITCHES) {
    lines.push(`- ${secureFact(security, key, name)}`);
    const note = input.text('secure', key).trim();
    if (note) lines.push(under(note));
  }
  const others = otherPcsFact(security, name);
  if (others) lines.push(others);
  for (const topic of SECURE_EXTRA_TOPICS) {
    const text = input.text('secure', topic).trim();
    if (text) lines.push('', heading('secure', topic, name), text);
  }
  return lines.join('\n');
}
