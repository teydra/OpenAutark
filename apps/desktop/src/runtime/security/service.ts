// The company's security gate (owner 19.11.2026, Sicher-Runde): every Autark tool call (tools/registry.ts via
// tool-gate.ts), every engine's own tool request (engines/*) and an agent's own `wf` calls of the person's methods
// (security/rpc-guard.ts) ask here. Open → on at once; closed for good → my refusal; a closed switch → an approval request
// the person answers (once, always this setting, always this place, decline) – the call waits for it up to WAIT_MS and
// otherwise ends with a text that says the request stays and that the answer wakes me. Each request is also the person's
// to-do with a choice (tasks/approval-todo.ts), so it shows in My day and is pushed to their phone; answering it ends here.
// 'setting' and 'place' change settings.json's `security` section through SettingsService.update (the person's path).
// FX2 (19.11.): "once" goes to one call of the asking agent only (approvals.ts); a request without chat/task takes them
// from its run (an engine's own tool), so the late answer wakes the agent where it was working; folders handed to the
// engines are real paths (policy.ts realPath).
// 25.11.2026 (Andrea Griffiths' test: a declined command, and the agent still said it was done): every refusal the agent
// reads starts with BLOCKED and ends with notDone() – nothing ran, never report it as done –, and a declined or closed
// step stands as a quiet "Blocked: …" line in the chat it was asked from, whatever the engine tells its model.
// Owns: SecurityService, the requests' life (approvals.ts), the wake after a late answer, the refusal texts, the
// "Blocked" line and the apps a "once" opened for the computer helper a moment. Never: decides (policy.ts), maps tool calls (tool-gate.ts), lets an agent answer.

import { statSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Allow, ApprovalAnswer, SecurityMode, SecuritySettings, SecuritySwitch, WebScope } from '../../shared/model/security-settings.ts';
import { effective, SECURITY_LABELS, webDomainsOf } from '../../shared/model/security-settings.ts';
import type { ApprovalRequest } from '../../shared/api/methods-security-mode.ts';
import { securityOf } from '../../shared/model/system.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { KvRepo } from '../store/kv.ts';
import { currentCaller } from '../rpc/caller.ts';
import { Approvals, WAIT_MS, type StoredRequest } from './approvals.ts';
import { closedText, decide, opened, ownFolders, placeOf, realPath, securityFolder, tempFolders, appName, type Places } from './policy.ts';
import { closeApprovalTodo, openApprovalTodo } from '../tasks/approval-todo.ts';
import { actingAs } from '../settings/security-log.ts';

export { WAIT_MS } from './approvals.ts';

export interface GateRequest {
  agentId: string;
  capability: SecuritySwitch;
  /** One line, what the agent would do ("Read C:\…\a.pdf", "Run: npm install", "Edit C:\…\x.ts"). */
  summary: string;
  /** A file path (read/write) or an app (computer) the request is about; the service derives the offered place. */
  path?: string;
  app?: string;
  /** web: the site the step reaches, or what it is when it reaches none (policy.ts CheckInput). */
  site?: string;
  web?: 'search' | 'tab';
  /** Same tool + same arguments → same fingerprint ("once" lets one later identical call through). */
  fingerprint: string;
  chatId?: string;
  /** The agent's task, when the call belongs to one (the wake after a late answer goes there). */
  taskId?: string;
  /** The turn's run: where chatId/taskId are not given, the service takes them from the run (engines pass only this). */
  runId?: string;
  /** The agent's name where it is not in this company's org (a call from a linked PC or another company). */
  agentName?: string;
  /** The turn ends or is cancelled → stop waiting (the request stays). */
  signal?: AbortSignal;
}
export type GateResult = { ok: true } | { ok: false; text: string }; // text: first person, for the agent
export interface FileScope {
  mode: SecurityMode;
  /** 'all' or the absolute folders that are open (the company's own folders first, then the listed ones). */
  read: 'all' | string[];
  write: 'all' | string[];
  commands: Allow;
  web: WebScope;
  /** The sites open when web is 'chosen' (siteOf form; their subdomains count with them; absent: none). */
  sites?: string[];
  /** Folders no agent may change except through the app: <data>/security in Secure mode (empty in Trust AI mode). */
  closed: string[];
  /**
   * Folders whose writes still ask (the gate decides) although they lie inside an open write folder: Autark's setup –
   * <workspace>/skills, and with write 'all' the data folder (the agent's own home there is open at the gate). Empty
   * while `setup` is 'yes'.
   */
  guarded?: string[];
}
export interface SecurityService {
  /** effective(securityOf(settings)) */
  current(): SecuritySettings;
  /** Synchronous: 'open' (go), 'ask' (gate would ask), 'closed' (hard no). */
  check(req: Pick<GateRequest, 'agentId' | 'capability' | 'path' | 'app' | 'site' | 'web' | 'fingerprint'>): 'open' | 'ask' | 'closed';
  /** open → { ok: true } at once; closed → refusal; ask → request + wait ≤ WAIT_MS. */
  gate(req: GateRequest): Promise<GateResult>;
  fileScope(agentId: string): FileScope;
  requests(): ApprovalRequest[];
  answer(id: string, answer: ApprovalAnswer): void;
  /** Apps a "once" opened for the computer helper's guard a moment (computer/service.ts). */
  openApps?(): string[];
}

/** An app answered "once" stays open to the helper's guard this long (the step it was for runs at once). */
export const ONCE_APP_MS = 2 * 60_000;

type Services = Pick<RuntimeServices, 'settings' | 'paths' | 'clock' | 'log'> & Partial<RuntimeServices>;

export class Security implements SecurityService {
  private readonly services: () => Services;
  private readonly waitMs: number;
  private store?: Approvals;
  private readonly onceApps = new Map<string, number>();

  constructor(deps: { services: () => Services; waitMs?: number }) {
    this.services = deps.services;
    this.waitMs = deps.waitMs ?? WAIT_MS;
  }

  current(): SecuritySettings {
    return effective(securityOf(this.services().settings.get()));
  }

  check(req: Pick<GateRequest, 'agentId' | 'capability' | 'path' | 'app' | 'site' | 'web' | 'fingerprint'>): 'open' | 'ask' | 'closed' {
    return decide(this.current(), this.places(), req).verdict;
  }

  async gate(req: GateRequest): Promise<GateResult> {
    const decision = decide(this.current(), this.places(), req);
    if (decision.verdict === 'open') return { ok: true };
    const name = this.personName();
    if (decision.verdict === 'closed') {
      const where = this.whereFrom(req);
      this.blockedLine(where.chatId, req.agentId, req.summary, `${SECURITY_LABELS[decision.capability]} is closed on ${this.pcName()}`, req.agentName);
      return { ok: false, text: `${BLOCKED} ${closedText(decision.why ?? 'security', name, this.pcName())} ${notDone(name)}` };
    }
    const store = this.approvals();
    if (store.take(req.agentId, req.fingerprint)) return { ok: true };
    const request = store.find(req.agentId, req.fingerprint) ?? this.open(req, decision.capability);
    const answer = await store.wait(request.id, this.waitMs, req.signal);
    if (answer === 'decline') return { ok: false, text: declinedText(request.summary, name) };
    if (answer === 'waiting') return { ok: false, text: waitingText(request, name, this.pcName()) };
    if (answer === 'spent') return { ok: false, text: `${name} allowed "${request.summary}" once, and that one time went to the same step running alongside this one; this call did not run.` };
    return { ok: true };
  }

  fileScope(agentId: string): FileScope {
    const settings = this.current();
    const places = this.places();
    const own = ownFolders(places, agentId);
    const secure = settings.mode === 'secure';
    const real = (folders: readonly string[]): string[] => [...new Set(folders.map((folder) => realPath(folder, places.workspace)))]; // the spelling the engines' own checks see
    return {
      mode: settings.mode,
      read: settings.read === 'all' ? 'all' : real([...own.read, ...settings.readFolders]),
      write: settings.write === 'all' ? 'all' : real([...own.write, ...settings.writeFolders]),
      commands: settings.commands,
      web: settings.web,
      sites: webDomainsOf(settings),
      closed: secure ? real([securityFolder(places)]) : [],
      guarded: settings.setup === 'yes' ? [] : real([path.join(places.workspace, 'skills'), ...(settings.write === 'all' ? [places.data] : [])]),
    };
  }

  requests(): ApprovalRequest[] {
    return this.approvals().list().map(({ fingerprint: _f, taskId: _t, todoId: _d, ...shown }) => shown);
  }

  answer(id: string, answer: ApprovalAnswer): void {
    const caller = currentCaller()?.scope;
    if (caller && ((caller.kind === 'owner' && caller.agentId) || caller.kind === 'agent')) throw new WorkforceError('forbidden', 'A security request is answered by the person themselves.');
    const store = this.approvals();
    const request = store.get(id);
    if (!request) throw new WorkforceError('not_found', 'This request is no longer waiting.', { details: { id } });
    if (answer === 'place' && !request.place) throw new WorkforceError('bad_request', 'This request names no place.');
    const s = this.services();
    if (answer === 'setting' || answer === 'place') {
      const patch = { security: opened(securityOf(s.settings.get()), request.capability, answer === 'place' ? request.place : undefined) } as Parameters<typeof s.settings.update>[0];
      actingAs({ kind: 'person', name: this.personName() }, patch, () => s.settings.update(patch)); // the change log names the person
    }
    const settled = store.settle(id, answer);
    if (!settled) return;
    if (answer === 'once' && !settled.waited) store.grant(request.agentId, request.fingerprint);
    if (answer !== 'decline' && request.capability === 'computer' && request.place?.kind === 'app') this.onceApps.set(request.place.value, s.clock.now());
    if (request.todoId) closeApprovalTodo(s, request.todoId, answer, answerLabel(request, answer));
    if (answer === 'decline') this.blockedLine(request.chatId, request.agentId, request.summary, `${this.personName()} declined it`, request.agentName);
    if (!settled.waited) this.wake(request, answer);
  }

  openApps(): string[] {
    const now = this.services().clock.now();
    for (const [app, at] of this.onceApps) if (now - at > ONCE_APP_MS) this.onceApps.delete(app);
    return [...this.onceApps.keys()];
  }

  // ---------------------------------------------------------------- internals

  private open(req: GateRequest, capability: SecuritySwitch): StoredRequest {
    const s = this.services();
    const isFolder = req.path ? folderExists(path.resolve(s.paths.workspace, req.path)) : false;
    const place = placeOf(capability, { path: req.path, app: req.app, site: req.site, isFolder }, s.paths.workspace);
    const where = this.whereFrom(req);
    const request: StoredRequest = {
      id: newId('apr', s.clock.now()), agentId: req.agentId, agentName: s.org?.get(req.agentId)?.name ?? req.agentName?.slice(0, 80) ?? req.agentId, at: s.clock.now(),
      capability, summary: req.summary.replace(/\s+/g, ' ').trim().slice(0, 300) || SECURITY_LABELS[capability],
      ...(place ? { place } : {}), ...(where.chatId ? { chatId: where.chatId } : {}), fingerprint: req.fingerprint, ...(where.taskId ? { taskId: where.taskId } : {}),
    };
    const store = this.approvals();
    for (const old of store.add(request)) if (old.todoId) closeApprovalTodo(s, old.todoId, 'decline', 'No longer waiting');
    try {
      const todoId = openApprovalTodo(s, request);
      if (todoId) store.setTodo(request.id, todoId);
    } catch (error) {
      s.log.warn('security request to-do not made', { id: request.id, error: String(error) });
    }
    s.log.info('security request', { id: request.id, agentId: request.agentId, capability });
    return request;
  }

  /** The chat and task the step belongs to: given with the request, else its run's (an engine's own tool passes only the run). */
  private whereFrom(req: GateRequest): { chatId?: string; taskId?: string } {
    if (req.chatId || req.taskId || !req.runId) return { chatId: req.chatId, taskId: req.taskId };
    try {
      const run = this.services().runs?.get(req.runId);
      return run && run.agentId === req.agentId ? { chatId: run.conversationId, taskId: run.taskId } : {};
    } catch { return {}; }
  }

  /** A late answer: the agent hears it where it asked and does the same step again. */
  private wake(request: StoredRequest, answer: ApprovalAnswer): void {
    const s = this.services();
    const name = this.personName();
    const note = answer === 'decline'
      ? declinedText(request.summary, name)
      :`${name} answered my request "${request.summary}": ${answerLabel(request, answer)}. The same step goes through now${answer === 'once' ? ' – once' : ''}.`;
    try {
      s.wakes?.wake({
        agentId: request.agentId, reason: 'answer', note, coalesceKey: `security:${request.id}`,
        ...(request.chatId ? { conversationId: request.chatId } : {}), ...(request.taskId ? { taskId: request.taskId } : {}),
        ...(request.chatId || request.taskId ? {} : { origin: { source: 'security', label: 'Security request' } }),
      });
    } catch (error) {
      s.log.warn('security answer wake not queued', { id: request.id, error: String(error) });
    }
  }

  /**
   * A refused step as a quiet line in the chat it was asked from (Andrea Griffiths' test 25.11.2026: a declined command
   * must be seen as blocked, not hidden behind the agent's "done"): "Blocked: <agent> – <step> did not run (<why>)."
   * Nothing without a chat or a chat service; never throws.
   */
  private blockedLine(chatId: string | undefined, agentId: string, summary: string, why: string, agentName?: string): void {
    if (!chatId) return;
    const s = this.services();
    try {
      const who = s.org?.get(agentId)?.name ?? agentName?.slice(0, 80) ?? agentId;
      const step = summary.replace(/\s+/g, ' ').trim().slice(0, 200);
      s.chats?.status(chatId, { type: 'note', text: `Blocked: ${who} – "${step}" did not run (${why}).`, details: { blocked: true, agentId } });
    } catch (error) {
      s.log.warn('blocked line not posted', { chatId, error: String(error) });
    }
  }

  private approvals(): Approvals {
    if (this.store) return this.store;
    const s = this.services();
    let kv: KvRepo | undefined;
    try { kv = s.db ? new KvRepo(s.db) : undefined; } catch { kv = undefined; }
    this.store = new Approvals({ kv, now: () => s.clock.now() });
    return this.store;
  }

  private places(): Places {
    const s = this.services();
    const executable = s.host?.app?.executable;
    return {
      data: s.paths.data, workspace: s.paths.workspace, resources: s.paths.resources, temp: tempFolders(s.paths.temp),
      ...(executable ? { ownApp: appName(path.basename(executable)) } : {}),
    };
  }

  /** This PC by its name (Umzug 21.11.2026: a forwarded call's refusal travels to another PC, where "this PC" would be wrong). */
  private pcName(): string {
    try { return this.services().devices?.self().name || 'this PC'; } catch { return 'this PC'; }
  }

  private personName(): string {
    try { return this.services().settings.get().profile.name?.trim() || 'the person'; } catch { return 'the person'; }
  }
}

/** The answer as the person's to-do and my wake name it. */
export function answerLabel(request: Pick<ApprovalRequest, 'capability' | 'place'>, answer: ApprovalAnswer): string {
  switch (answer) {
    case 'once': return 'Allow once';
    case 'setting': return `Always: ${SECURITY_LABELS[request.capability]}`;
    case 'place': return `Always: ${request.place?.value ?? SECURITY_LABELS[request.capability]}`;
    case 'decline': return 'Decline';
  }
}

/**
 * The first words of every refusal the model reads (Andrea Griffiths' test 25.11.2026: after a declined command the agent
 * still reported "done"): nothing of the step ran, whatever the engine's own wording around it says.
 */
export const BLOCKED = 'BLOCKED – not executed.';

/** What every refusal ends with: a step that did not run is never reported as done. */
export function notDone(name: string): string {
  return `Nothing of this step happened. I must not report it, or the work that needed it, as done: my answer tells ${name} plainly that it was blocked and what is still missing because of it.`;
}

/** The person declined the step (at once or after the call gave up waiting). */
export function declinedText(summary: string, name: string): string {
  return `${BLOCKED} ${name} declined "${summary}". ${notDone(name)} Then I go on with what is still open, without working around it.`;
}

/** The call gave up waiting; the request stays and the answer wakes me. */
function waitingText(request: StoredRequest, name: string, pc: string): string {
  return `${BLOCKED} ${SECURITY_LABELS[request.capability]} is closed on ${pc}, so the app asked ${name} for "${request.summary}". ${name} has not answered yet: the request stays in ${name}'s to-dos; when they answer, I'm woken and the same step goes through. Until then this step did not run and I never report it as done – if I answer before that, I say it waits for ${name}'s answer – and I work on what is open.`;
}

function folderExists(target: string): boolean {
  try { return statSync(target).isDirectory(); } catch { return false; }
}

/** The service on the runtime's services (compose/services.ts). */
export function createSecurity(services: () => Services): Security {
  return new Security({ services });
}
