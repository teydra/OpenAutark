// The pure charge rule of an account – the one rule: the runtime books (models/pricing.ts), routes (routing/score.ts isPaid,
// accounts/candidates.ts) and labels (routing/model-facts.ts) by it, and the UI labels pay-per-use models with it: an API key
// or environment key pays per use, a CLI signed in with an API key (status plan 'api') too – unless it holds a plan's
// monthly API credits (B-083 `credits`: prepaid and lost at the end of the billing month, so it counts as a plan); local
// runtimes and keyless servers are free; every other sign-in is a plan – Codex, Claude Code and the ACP CLIs (Gemini CLI,
// Copilot, Kimi Code) alike. Plus the UI's "first usable account" of a model (SG cost-guide labels) and which accounts
// can hold plan credits at all, and (17.11.2026) which plan can go on past its limit on the provider's extra usage.
// Owns: this rule. Never: I/O, prices, or which account a turn really gets (routing).

import type { Account } from './providers.ts';

export type AccountCharge = 'paid' | 'plan' | 'free';

/** Local runtimes (runtime engines/http/common.ts LOCAL_PROVIDERS). */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);
const PAID_AUTH: ReadonlySet<string> = new Set(['api_key', 'env']);
/** B-083: providers whose plans include monthly API credits (Claude Max/Ultra, ChatGPT Pro/Business); a Codex login with a key
 *  spends none. 24.11.2026 (feedback D032C4C3): `compatible` joins – a subscription with an OpenAI-compatible key (Qwen Token
 *  Plan: a monthly fee, prepaid credits that expire with the month, the service pauses at its quota) is a plan, and only the
 *  person's own switch says so; without it such a key stays pay-per-use. Claude Code with a Console key joins once its engine reports "Credit balance is too low" as a limit (today a
 *  plain failure, so a used-up login would never cool and stay the routed work plan). */
const CREDIT_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'compatible']);

export function accountCharge(account: Pick<Account, 'auth' | 'provider' | 'plan' | 'credits'> | undefined): AccountCharge {
  if (!account) return 'plan';
  if (account.auth === 'local' || LOCAL_PROVIDER_IDS.has(account.provider)) return 'free';
  if (PAID_AUTH.has(account.auth)) return account.credits ? 'plan' : 'paid';
  if (account.auth === 'cli') return account.plan?.trim().toLowerCase() === 'api' && !account.credits ? 'paid' : 'plan';
  return 'free';
}

/** B-083: a pay-per-use account that can hold a plan's API credits – an Anthropic, OpenAI or OpenAI-compatible key (API or environment key). */
export function creditsPossible(account: Pick<Account, 'auth' | 'provider' | 'plan'>): boolean {
  return CREDIT_PROVIDERS.has(account.provider) && accountCharge({ auth: account.auth, provider: account.provider, plan: account.plan }) === 'paid';
}

/** Plan logins whose provider bills extra usage once the plan's window is used up – and whose CLI goes on serving the turn when
 *  the person switched it on at the provider: Claude Code (claude.ai Settings › Usage › "usage credits"), Codex (ChatGPT "credits",
 *  Codex Settings › Usage › Credits). Gemini CLI, Copilot CLI and Kimi Code report nothing this app could rely on. */
const EXTRA_USAGE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex']);

/**
 * 17.11.2026 (Konrad task_bgykyzcx): whether the account can go on past its plan's limit on the provider's extra usage –
 * `why` says what is missing where it cannot (the switch shows it). Never a promise that the provider has it switched on:
 * a turn it refuses comes back as a limit, and the plan waits for its reset as before.
 */
export function extraUsageOf(account: Pick<Account, 'auth' | 'provider' | 'plan'>): { ok: true } | { ok: false; why: string } {
  const charge = accountCharge({ auth: account.auth, provider: account.provider, plan: account.plan });
  if (account.auth === 'cli' && charge === 'paid') return { ok: false, why: 'Signed in with an API key: billed per use already, no plan limit to go past.' };
  if (account.auth !== 'cli') return { ok: false, why: charge === 'free' ? 'This is free and has no limit to go past.' : 'An API key has no plan limit to go past: every use is billed already.' };
  if (!EXTRA_USAGE_PROVIDERS.has(account.provider)) return { ok: false, why: 'No paid extra usage for this plan – it waits for its reset.' };
  return { ok: true };
}
