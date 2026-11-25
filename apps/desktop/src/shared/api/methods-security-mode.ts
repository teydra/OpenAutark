// RPC contract part: the company's security mode (owner 19.11.2026) – topic texts and approval requests. The mode and
// its switches themselves are settings.json `security` (settings.get / settings.update; runtime/rpc/table.ts lets only
// the person's own sessions change that section). Handlers: runtime/rpc/handlers/security-mode.ts.
// Merged into Methods by module augmentation. Owns: these method shapes. Never: behaviour.

import type { ApprovalAnswer, ApprovalPlace, SecurityMode, SecuritySwitch, SecurityTopic } from '../model/security-settings.ts';

/** One topic text as Settings › Security shows it: the file's text, or the default with `{{name}}` filled in. */
export interface TopicText {
  topic: SecurityTopic;
  text: string;
  /** No file of its own: `text` is the default. */
  isDefault: boolean;
}

/** An agent needs something a switch keeps closed; the person answers it (once, always the setting, always the place, decline). */
export interface ApprovalRequest {
  id: string;
  agentId: string;
  agentName: string;
  at: number;
  /** The switch that holds it closed. */
  capability: SecuritySwitch;
  /** What the agent would do, one line: "Read C:\Users\…\taxes.pdf", "Run: npm install", "Open Excel". */
  summary: string;
  /** Offered for "always allow this place": a folder (the file's folder), an app (process name) or a site (web 'chosen'). */
  place?: ApprovalPlace;
  /** The chat the agent was working for, when there is one. */
  chatId?: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- security mode
    /** Every topic text of a mode (files or defaults). */
    'security.topics': { params: { mode: SecurityMode }; result: TopicText[] };
    /** Writes one topic file; `text: null` deletes it (back to the default). Person sessions only. */
    'security.saveTopic': { params: { mode: SecurityMode; topic: SecurityTopic; text: string | null }; result: TopicText };
    /** Changes one Trust AI agreement from a runtime-bound agent session, with that agent in the change log. */
    'security.saveTrustAgreement': { params: { topic: SecurityTopic; text: string | null }; result: TopicText };
    /** The approval requests still waiting for the person. */
    'security.requests': { params: void; result: ApprovalRequest[] };
    /** The person's answer; 'setting' opens the switch, 'place' adds the folder or app to its list. Person sessions only. */
    'security.answer': { params: { id: string; answer: ApprovalAnswer }; result: { ok: true } };
    /** Apps with a window on this PC right now (process names), for the computer-use list. */
    'security.apps': { params: void; result: string[] };
  }
}

export {};
