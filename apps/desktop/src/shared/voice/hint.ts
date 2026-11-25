// 25.11.2026 (owner: "Colearning Salzburg" stood in dictated messages he never said – the name of a found plan login):
// what a recognizer is given as a hint – the learned words, the chat's last agent message, the text heard before –
// never carries an account's address or name. A recognizer writes a hint it finds no speech for (the pause before Stop),
// and an agent's chat line about found logins ("salzburgcolearning@… is a Claude Code login") or a learned word taken
// from it would hand it one. Only names of people, agents and the company's own vocabulary are meant to go there.
// Owns: taking addresses and the given account terms out of a hint text, and the account terms of a list of accounts.
// Never: reads accounts itself or decides who is allowed in a hint beyond that.

const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** A shorter local part or label would take ordinary words out of a hint. */
const MIN_TERM = 4;

/** What names an account on a screen: its address, the address's name part and its label. */
export function accountTerms(accounts: ReadonlyArray<{ label?: string; email?: string }>): string[] {
  const out = new Set<string>();
  for (const account of accounts) {
    const email = account.email?.trim().toLowerCase();
    if (email) {
      out.add(email);
      const local = email.split('@')[0] ?? '';
      if (local.length >= MIN_TERM) out.add(local);
    }
    const label = account.label?.trim().toLowerCase();
    if (label && label.length >= MIN_TERM) out.add(label);
  }
  return [...out];
}

const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text without e-mail addresses and without the given account terms (any case), spaces closed up. */
export function withoutAccounts(text: string, terms: readonly string[] = []): string {
  let out = text.replace(ADDRESS, ' ');
  for (const term of terms) if (term.length >= MIN_TERM) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

/** True when a learned word is an address or an account term: it stays out of a hint. */
export function isAccountWord(word: string, terms: readonly string[] = []): boolean {
  if (word.includes('@')) return true;
  const lower = word.trim().toLowerCase();
  return terms.some((term) => term === lower);
}
