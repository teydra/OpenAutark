// Sign-in after a restart (22.11.2026): Autark keeps working after Windows restarts without anyone typing the password.
// Owner's words (22.11.2026 23:39): "Unsere App soll so sein, dass sie selbst nach einem Neustart direkt du handeln kannst.
// Das soll für alle Nutzer so sein." – and (23:41) no Windows autologon: "Es soll sich doch nicht jeder PC einfach von
// jedem User einloggen." So the desktop broker (resources/broker/SignIn.cs) signs in at the sign-in screen itself, like an
// agent does on the lock screen, and only when the person stored their Windows password for it. Optional, never required.
//
// The flow: the person (or an agent on their word) names the catalog secret that holds the Windows password –
// computer.sign_in_after_restart {secret: "secret://<id>"}. The value is decrypted here at that moment, sealed for the pipe
// (broker.ts sealLine, op 'signin_store') and checked by Windows (LogonUser) in the broker, which keeps its own machine-bound
// copy (an LSA private datum, SYSTEM only) – the catalog itself is the person's (OS keychain) and unreadable before sign-in.
// When that catalog entry changes, the broker's copy follows; when it goes, the broker forgets it. `lockAfter`: right after
// such a sign-in, this app locks the screen once it runs (agents unlock through the broker when they need the screen).
// Trust/secure: in the public tree there are no security modes, so storing the password is the opt-in; a secure mode turns
// it off (see the README of the patch).
// Owns: the one-shot broker calls (signin_*), the stored choice (kv 'computer.signin'), following the catalog entry, the lock
// after an automatic sign-in and the tool. Never: logs, returns or keeps the password; sets Windows autologon.

import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '../contracts.ts';
import type { SecretService } from '../contracts/safety.ts';
import type { ToolDef } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import { WorkforceError, type ErrorCode } from '../../shared/errors.ts';
import { asciiJson } from './protocol.ts';
import type { BrokerAccess } from './broker.ts';

/** What the broker says about the sign-in after a restart (SignIn.cs SignInOps.Status). */
export interface SignInStatus {
  account: string;
  stored: boolean;
  suspended: boolean;
  reason: string;
  failures: number;
  lastResult: string;
  /** Epoch ms; 0 = never. */
  lastAttemptAt: number;
  lastSignInAt: number;
  lockAfter: boolean;
  /** The broker signed in and the app has not yet locked the screen as wished. */
  pendingLock: boolean;
}

/** The person's choice, kept in kv 'computer.signin' / 'config' (ids only). */
export interface SignInConfig {
  secretId: string;
  /** The login group the secret is a field of (its changes are told with the group's id). */
  groupId?: string;
  lockAfter: boolean;
}

export const SIGNIN_NS = 'computer.signin';
/** A sign-in older than this is not locked any more when the app starts late (the person may be at the PC by then). */
export const LOCK_WINDOW_MS = 5 * 60_000;
const SIGNIN_OPS = new Set(['signin_status', 'signin_store', 'signin_clear', 'signin_options', 'signin_handled']);
const ERROR_CODES: ReadonlySet<string> = new Set(['bad_request', 'not_found', 'conflict', 'forbidden', 'unavailable', 'timeout', 'internal']);

let nextId = 1;

/**
 * One request to the broker over its own pipe connection (handshake as for computer use, broker.ts brokerLease): the
 * password of 'signin_store' leaves this process only sealed. Resolves with the result, rejects with a WorkforceError
 * whose details.code is the broker's ('wrong_password', 'verify_failed' …).
 */
export function brokerCall<T = unknown>(access: BrokerAccess, log: Logger, op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  if (!SIGNIN_OPS.has(op)) return Promise.reject(new WorkforceError('bad_request', `Unknown broker op ${op}.`));
  const lease = access.lease(log);
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    let buffer = '';
    let sent = false;
    let done = false;
    const finish = (error: Error | undefined, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void lease.release().catch(() => undefined);
      if (error) reject(error); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new WorkforceError('timeout', 'The desktop broker did not answer.')), timeoutMs);
    const stdout = lease.child.stdout as NodeJS.ReadableStream;
    stdout.setEncoding?.('utf8');
    stdout.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message: { ready?: boolean; id?: number; ok?: boolean; result?: T; error?: { code?: string; message?: string } };
        try { message = JSON.parse(line); } catch { finish(new WorkforceError('internal', 'The desktop broker sent an unreadable line.')); return; }
        if (!sent && message.ready) {
          sent = true;
          lease.child.stdin?.write(`${asciiJson({ id, op, args })}\n`);
          continue;
        }
        if (message.id !== id) continue;
        if (message.ok) { finish(undefined, message.result); return; }
        const code = message.error?.code ?? 'internal';
        const mapped: ErrorCode = ERROR_CODES.has(code) ? code as ErrorCode : code === 'wrong_password' ? 'forbidden' : 'internal';
        finish(new WorkforceError(mapped, message.error?.message ?? 'The desktop broker refused.', { details: { code } }));
        return;
      }
    });
    lease.exited.then(() => finish(new WorkforceError('unavailable', 'The desktop broker closed the connection.')), () => undefined);
  });
}

/** True when this app should lock the screen now: the broker signed in recently and the person wished a lock after it. */
export function shouldLock(status: SignInStatus, now: number, bootAt: number): boolean {
  const age = now - status.lastSignInAt;
  return status.stored && !status.suspended && status.lastResult === 'signed_in' &&
    status.lockAfter && status.pendingLock && status.lastSignInAt > 0 && status.lastSignInAt >= bootAt &&
    age >= 0 && age <= LOCK_WINDOW_MS;
}

/** An atomic claim shared by the user's companies (each has a separate runtime and data folder). */
export async function claimSignInLock(at: number, directory = tmpdir()): Promise<(() => Promise<void>) | undefined> {
  const file = path.join(directory, `autark-signin-lock-${at}`);
  try {
    await (await open(file, 'wx')).close();
    return () => rm(file, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return undefined;
  }
}

/** The secret id of a handle or a bare id. */
export function secretIdOf(value: string): string | undefined {
  const match = /^(?:secret:\/\/)?([A-Za-z0-9_-]{1,128})$/.exec(value.trim());
  return match?.[1];
}

export interface KvLike {
  get<T>(ns: string, key: string): T | undefined;
  set(ns: string, key: string, value: unknown, at: number): void;
  delete(ns: string, key: string): boolean;
}

export interface RestartSignInDeps {
  /** The installed broker on this PC; undefined where there is none (not Windows, not installed). */
  broker(): BrokerAccess | undefined;
  secrets: Pick<SecretService, 'use' | 'list'> & Partial<Pick<SecretService, 'observe'>>;
  kv: KvLike;
  log: Logger;
  now(): number;
  /** Locks this Windows session (LockWorkStation). */
  lock?(): Promise<void>;
  waitForDesktop?(): Promise<void>;
  bootAt?(): number;
}

/** The app's half of the sign-in after a restart (see the header). */
export class RestartSignIn {
  private readonly deps: RestartSignInDeps;
  private stopObserving?: () => void;
  private syncing: Promise<unknown> = Promise.resolve();
  private started = false;

  constructor(deps: RestartSignInDeps) { this.deps = deps; }

  config(): SignInConfig | undefined { return this.deps.kv.get<SignInConfig>(SIGNIN_NS, 'config'); }

  private access(): BrokerAccess {
    const access = this.deps.broker();
    if (!access || !access.reachable()) throw new WorkforceError('unavailable', 'The desktop broker is not installed on this PC, so Autark cannot sign in after a restart here (Windows only; the broker comes with the app and asks Windows once for a Yes).');
    return access;
  }

  async status(): Promise<SignInStatus> {
    return brokerCall<SignInStatus>(this.access(), this.deps.log, 'signin_status');
  }

  /** Hands the catalog secret's current value to the broker (checked by Windows there) and remembers the choice. */
  async enable(input: { secretId: string; lockAfter?: boolean; agentId: string }): Promise<SignInStatus> {
    const info = this.deps.secrets.list().find((secret) => secret.id === input.secretId);
    if (!info) throw new WorkforceError('not_found', 'That secret is not in the catalog.');
    const access = this.access();
    const lockAfter = input.lockAfter ?? this.config()?.lockAfter ?? true; // default: lock right after the sign-in (owner 22.11.: no PC open to whoever switches it on)
    const password = await this.deps.secrets.use(input.secretId, input.agentId, 'windows-sign-in');
    const status = await brokerCall<SignInStatus>(access, this.deps.log, 'signin_store', { password, lockAfter });
    this.deps.kv.set(SIGNIN_NS, 'config', { secretId: input.secretId, ...(info.group ? { groupId: info.group.id } : {}), lockAfter } satisfies SignInConfig, this.deps.now());
    this.deps.log.info('sign-in after restart enabled', { secretId: input.secretId, lockAfter });
    return status;
  }

  async disable(): Promise<SignInStatus | undefined> {
    this.deps.kv.delete(SIGNIN_NS, 'config');
    const access = this.deps.broker();
    if (!access || !access.reachable()) return undefined;
    const status = await brokerCall<SignInStatus>(access, this.deps.log, 'signin_clear');
    this.deps.log.info('sign-in after restart disabled');
    return status;
  }

  async setLockAfter(lockAfter: boolean): Promise<SignInStatus> {
    const config = this.config();
    if (config) this.deps.kv.set(SIGNIN_NS, 'config', { ...config, lockAfter }, this.deps.now());
    return brokerCall<SignInStatus>(this.access(), this.deps.log, 'signin_options', { lockAfter });
  }

  /** At the app's start: follow the catalog entry, and lock once after an automatic sign-in when wished. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopObserving = this.deps.secrets.observe?.((id) => {
      const config = this.config();
      if (!config || (id !== config.secretId && id !== config.groupId)) return;
      this.syncing = this.syncing.then(() => this.follow(config)).catch((error) => this.deps.log.warn('sign-in after restart: catalog change not handed to the broker', { error: String((error as Error)?.message ?? error) }));
    });
    // Let the desktop start and the signer publish its successful result before checking the broker.
    const wait = this.deps.waitForDesktop ?? (() => delay(5000, undefined, { ref: false }));
    await wait();
    if (!this.started) return;
    const access = this.deps.broker();
    if (!access || !access.reachable()) return;
    try {
      const status = await brokerCall<SignInStatus>(access, this.deps.log, 'signin_status');
      if (status.suspended) this.deps.log.warn('sign-in after restart is suspended', { reason: status.reason });
      const now = this.deps.now();
      const bootAt = this.deps.bootAt?.() ?? now - uptime() * 1000;
      if (!shouldLock(status, now, bootAt)) return;
      const release = await claimSignInLock(status.lastSignInAt);
      if (!release) return;
      let requested = false, acknowledged = false;
      try {
        // Other companies may have read the old status before the claim was released; check again inside it.
        const current = await brokerCall<SignInStatus>(access, this.deps.log, 'signin_status');
        if (!this.started || current.lastSignInAt !== status.lastSignInAt || !shouldLock(current, this.deps.now(), bootAt)) return;
        await (this.deps.lock ?? lockWorkstation)();
        requested = true;
        this.deps.log.info('screen lock requested after the automatic sign-in');
        await brokerCall(access, this.deps.log, 'signin_handled');
        acknowledged = true;
      } finally {
        // If the lock request went out but the broker did not acknowledge it, retain the claim for this event only.
        if (!requested || acknowledged) await release();
      }
    } catch (error) {
      this.deps.log.warn('sign-in after restart: lock not confirmed', { error: String((error as Error)?.message ?? error) });
    }
  }

  stop(): void { this.started = false; this.stopObserving?.(); this.stopObserving = undefined; }

  /** The catalog entry changed: its new value goes to the broker; gone, the broker forgets. */
  private async follow(config: SignInConfig): Promise<void> {
    const still = this.deps.secrets.list().some((secret) => secret.id === config.secretId);
    if (!still) { await this.disable(); return; }
    await this.enable({ secretId: config.secretId, lockAfter: config.lockAfter, agentId: 'system' });
  }
}

/** LockWorkStation for this session. */
export function lockWorkstation(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`LockWorkStation helper exited with ${signal ?? code}`)));
  });
}

function statusLines(status: SignInStatus, config: SignInConfig | undefined): string {
  const lines = [
    status.stored
      ? `Sign-in after a restart is on for ${status.account}${config ? ` (password from secret://${config.secretId})` : ''}: after Windows restarts, the desktop broker signs in at the sign-in screen itself, so Autark starts without anyone.`
      : `Sign-in after a restart is off for ${status.account || 'this PC'}: after a restart Autark waits until someone signs in to Windows.`,
  ];
  if (status.stored) lines.push(status.lockAfter ? 'Right after such a sign-in Autark locks the screen; agents unlock it through the broker when they need it.' : 'The screen stays unlocked after such a sign-in.');
  if (status.suspended) lines.push(`Suspended: ${status.reason} Storing the current Windows password again turns it back on.`);
  if (status.lastResult) lines.push(`Last attempt: ${status.lastResult}${status.lastAttemptAt ? ` at ${new Date(status.lastAttemptAt).toISOString()}` : ''}.`);
  return lines.join('\n');
}

/** computer.sign_in_after_restart: turn it on with the Windows password from the catalog, change the lock wish, turn it off, or read it. */
export function signInTool(signIn: RestartSignIn): ToolDef {
  return defineTool<{ secret?: string; off?: boolean; lockAfter?: boolean }>({
    name: 'computer.sign_in_after_restart',
    description: 'Lets this Windows PC sign in by itself after a restart, so Autark and its agents keep working without anyone typing the password: the desktop broker types the stored Windows password at the sign-in screen (never Windows autologon). Optional for the person. Without arguments it tells whether it is on.',
    inputSchema: {
      type: 'object',
      properties: {
        secret: { type: 'string', maxLength: 140, description: 'The catalog secret holding the Windows password of this PC\'s user, e.g. secret://<id>. Windows checks it before it is kept; the broker keeps its own copy, bound to this PC.' },
        off: { type: 'boolean', description: 'true: turn it off; the broker forgets the password.' },
        lockAfter: { type: 'boolean', description: 'Lock the screen right after such a sign-in, once Autark runs (default true).' },
      },
      additionalProperties: false,
    },
    category: 'write_system', requires: 'device',
    describe: (args) => ({
      summary: args.off ? 'Turn off the sign-in after a restart' : args.secret ? 'Turn on the sign-in after a restart with a stored Windows password' : args.lockAfter !== undefined ? `${args.lockAfter ? 'Lock' : 'Do not lock'} the screen after the sign-in after a restart` : 'Read the sign-in after a restart',
      reversible: true, external: false,
    }),
    async run(args, ctx) {
      if (args.off) {
        const status = await signIn.disable();
        return text(status ? statusLines(status, undefined) : 'Sign-in after a restart is off (the desktop broker is not installed here).');
      }
      if (args.secret) {
        const secretId = secretIdOf(args.secret);
        if (!secretId) return text('Name the secret as secret://<id>.');
        try {
          return text(statusLines(await signIn.enable({ secretId, lockAfter: args.lockAfter, agentId: ctx.agent.id }), signIn.config()));
        } catch (error) {
          if (error instanceof WorkforceError && error.details?.code === 'wrong_password') return text('Windows does not accept that password for this PC\'s user – nothing was stored. The secret may hold an old password or another account\'s.');
          throw error;
        }
      }
      if (args.lockAfter !== undefined) return text(statusLines(await signIn.setLockAfter(args.lockAfter), signIn.config()));
      return text(statusLines(await signIn.status(), signIn.config()));
    },
  });
}
