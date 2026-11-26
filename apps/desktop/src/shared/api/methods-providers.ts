// RPC contract part: providers and routing – accounts (detect, add, log in/out, install, Codex
// resets, an endpoint test before adding), usage, the model catalog and policies, routing previews and the
// efforts a model offers. Handlers: runtime/rpc/handlers/providers.ts.
// Merged into Methods by module augmentation (split from methods.ts by area, 23.10.).
// Owns: these method and event shapes. Never: behaviour.

import type { UseNow } from '../model/models-uses.ts';
import type { Account, DetectionReport, Effort, ModelInfo, ModelPolicy, ProviderId, RouteDecision, UsageSummary } from '../model/providers.ts';

/** B-044: the answer of a Codex reset redemption (the app server's ConsumeAccountRateLimitResetCreditOutcome). */
export type ResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

/**
 * B-051: one tiny real turn on an account ("does it answer?") – ok with the time and the model that answered,
 * else why not in words a person understands (`reason` for the UI's choice of next step).
 */
export type AccountTry =
  | { ok: true; ms: number; model: string }
  | { ok: false; reason: 'missing' | 'signed_out' | 'plan' | 'limit' | 'error'; message: string };

/**
 * B-091: a sign-in started from a device away from the PC (the phone) – `code`: the one-time code the person
 * enters on the sign-in page (Codex); `paste`: the page shows a code the person hands back with accounts.loginCode (Claude).
 */
export interface AwaySignIn { code?: string; paste?: true }

/** Result of `catalog.status`: catalog size, available models and the last full refresh. */
export interface ModelCatalogStatus {
  models: number;
  available: number;
  /** Last full catalog refresh (model lists of every account). */
  refreshedAt?: number;
}

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- providers & routing
    'accounts.list': { params: void; result: Account[] };
    'accounts.detect': { params: { force?: boolean } | void; result: DetectionReport };
    'accounts.add': { params: { provider: ProviderId; label?: string; apiKey?: string; baseUrl?: string; envVar?: string; detected?: boolean }; result: Account & { signInUrl?: string } & AwaySignIn }; // apiKey: typed, or a handle secret://<id> of the catalog (the account then only names that entry); PR5: envVar = key variable name, detected = "Add again"; B-051: signInUrl = the page the CLI's sign-in printed (when it did within a few seconds)
    'accounts.update': { params: { id: string; label?: string; priority?: number; enabled?: boolean; credits?: boolean; extraUsage?: boolean; thisPcOnly?: boolean }; result: Account }; // B-083 credits: the key holds a plan's monthly API credits (used like a plan)
    /** 17.11.2026: "Use" – the offered plan login (DetectionReport.found) becomes an account here, switched on and checked; only the person (a window, the phone, a `wf` by hand), never an agent. */
    'accounts.useFound': { params: { key: string; thisPcOnly?: boolean }; result: Account }; // `thisPcOnly` (default false since 0.3.20 – Konrad #830): false: the account goes to all PCs of the company; true: it stays on this PC
    /** "Not here" – the offered login is dismissed in this company (it stays on the PC; "Add again" brings it back). Only the person. */
    'accounts.declineFound': { params: { key: string }; result: { ok: true } };
    /** 23.11.2026: "Let the AI set it up" – the personal manager's to-do for a Claude plan's monthly API credits (one open per plan). Only the person. */
    'accounts.setupCredits': { params: { id: string }; result: { taskId: string; assignee: string } };
    'accounts.login': { params: { id: string }; result: { started: boolean; url?: string } & AwaySignIn };
    /** B-091: the code the Claude sign-in page showed the person on their phone, handed to the running away sign-in; ok = the account works now. */
    'accounts.loginCode': { params: { id: string; code: string }; result: { ok: boolean } };
    'accounts.logout': { params: { id: string }; result: { ok: true } };
    'accounts.remove': { params: { id: string }; result: { ok: true } };
    'accounts.install': { params: { provider: 'claude' | 'codex' }; result: { ok: true } };
    /** B-051, owner: one tiny real tool-less turn on this account (first run's "Works – answered in 2 s"). */
    'accounts.try': { params: { id: string }; result: AccountTry };
    /** B-044 (MODELS-ACCOUNTS), owner: lists an API endpoint's model ids before it is saved; the key (typed, or a handle secret://<id>) is used for this call only. */
    'accounts.test': { params: { provider: ProviderId; baseUrl?: string; apiKey?: string }; result: { models: string[] } };
    /**
     * B-044 (MODELS-ACCOUNTS), owner, after the person confirmed: redeems one banked Codex rate-limit
     * reset (`creditId`, else the next available one). `outcome` is the Codex app server's answer
     * (account/rateLimitResetCredit/consume); 'alreadyRedeemed' = this attempt went through before.
     */
    'accounts.useReset': { params: { id: string; creditId?: string }; result: { outcome: ResetOutcome } };
    'usage.list': { params: { refresh?: boolean } | void; result: UsageSummary[] };
    'models.list': { params: { refresh?: boolean } | void; result: ModelInfo[] };
    /** Owner: what each model use resolves to right now (MODEL_USES order); Settings › Models shows it. */
    'models.uses': { params: void; result: UseNow[] };
    /** One use set to one of its choices (or another model id), as Settings' selects set it; answers models.uses again. */
    'models.setUse': { params: { use: string; value: string }; result: UseNow[] };
    'models.recent': { params: { agentId?: string } | void; result: string[] };
    /** The stored policy at one scope (no ids = global default for agents); null when none is set. */
    'models.getPolicy': { params: { agentId?: string; conversationId?: string } | void; result: ModelPolicy | null };
    /** `now` (agent scope): the new start model also runs the agent's next turn at once – it reads its whole conversation again on it; else it applies from its next context. */
  'models.setPolicy': { params: { agentId?: string; conversationId?: string; policy: ModelPolicy; now?: boolean }; result: { ok: true } };
    /** RT5: like a turn, the chat's last done run is the previous choice (a chat's model choice is information for the AI, never a route); `ignorePin` = as on the agent page's "nothing chosen" option: without a chat the agent's own pin does not answer. It answers for the PC this connection is to, with that PC's accounts and limits – every PC routes with its own, so a turn that runs on another PC can pick another model. */
    'routing.preview': { params: { agentId: string; conversationId?: string; text?: string; mode?: string; ignorePin?: boolean }; result: RouteDecision };
    'catalog.refresh': { params: void; result: { ok: true; models: number; fetchedAt?: number; refreshedAt?: number } };
    'catalog.status': { params: void; result: ModelCatalogStatus };

    // ----------------------------------------------------------------- effort helpers for the UI
    'efforts.forModel': { params: { modelId: string }; result: Effort[] };
  }
}
