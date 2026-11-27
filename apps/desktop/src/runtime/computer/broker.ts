// The desktop broker connection (B-077, computer use on the lock screen): once `AutarkDesktopBroker` is installed
// (B-080: resources/broker/install.ps1, run by the app's setup or at a start where it is missing – main/broker-setup.ts),
// its SYSTEM worker in the console session serves the helper protocol on a named pipe and
// follows the input desktop, so the normal computer.* tools also reach the locked screen and UAC prompts.
// brokerLease() hands WindowsHelper (helper.ts) a lease whose "child" is the pipe: the handshake proves the
// installation key both ways, then lines pass through unchanged – except typed text ('type', 'act' value), which leaves
// this process only sealed with the session key (AES-256-CBC + HMAC-SHA256, op 'type_secret') and is opened by the worker
// right before SendInput. Each answer names the input desktop; `brokerState` keeps the route and the last desktop.
// F03 (16.11.2026): it also keeps how the broker's setup at this app's start ended (main/broker-setup.ts, the bus event
// 'broker.setup'), and secureDesktopLine says in my words when the secure desktop is out of reach and how one Yes changes that.
// Owns: reachability, the handshake, sealing, the route state and that line. Never: retries, resolves secrets (secrets/handles.ts)
// or logs anything typed.

import { createHmac, createCipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { Logger } from '../contracts.ts';
import type { Bus } from '../bus.ts';
import type { EventMap } from '../../shared/api/events.ts';
import type { ChildLike, Lease } from '../system/supervisor.ts';
import { asciiJson } from './protocol.ts';

export const BROKER_PIPE_NAME = 'AutarkDesktopBroker';
export const BROKER_PIPE = `\\\\.\\pipe\\${BROKER_PIPE_NAME}`;
export const BROKER_KEY = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'AutarkDesktopBroker', 'broker.key');

/**
 * Which way computer use runs on this PC, which desktop took input at the last answer ('Winlogon' = locked or UAC), and
 * F03: how the broker's setup at this app's start ended (undefined: none ran – a start without a window, a build that is not installed).
 */
export const brokerState: { via: 'broker' | 'powershell'; desktop?: string; setup?: EventMap['broker.setup'] } = { via: 'powershell' };

/** True when the broker's desktop is the Windows sign-in / secure desktop. */
export function lockedDesktop(): boolean {
  return brokerState.via === 'broker' && (brokerState.desktop ?? '').toLowerCase() === 'winlogon';
}

/**
 * Owner 24.11.2026 ("ziemlich daneben geklickt bei der Windows-Abfrage … weiter links vom Ja-Button"): a UAC prompt is
 * answered by its button element – Windows names them OkButton (Yes) and CancelButton (No) whatever its language; read
 * live on teydra-server 27.11.2026 through the broker, invoke elevated –, never by a point read off a picture. Said by
 * computer.screenshot and computer.click while the secure desktop takes input.
 */
export const UAC_BY_ELEMENT = 'A UAC prompt I answer by its button element, never by coordinates: computer.ui_tree with automationId "OkButton" (Yes) or "CancelButton" (No), then computer.act invoke on its ref – and I check the result.';

/** F03: main's word on the setup (sticky: replayed to a restarted runtime) lands in brokerState. */
export function followBrokerSetup(bus: Pick<Bus, 'on'>): () => void {
  return bus.on('broker.setup', (setup) => { brokerState.setup = setup; });
}

/**
 * F03: the fact line of the computer tools on Windows while the secure desktop (UAC prompts, the locked screen) is out of
 * my reach – the broker did not answer this helper start and the setup at the app's start did not install it. Undefined
 * otherwise (the broker serves, or no setup ran here to tell).
 */
export function secureDesktopLine(platform: NodeJS.Platform = process.platform): string | undefined {
  const setup = brokerState.setup;
  if (platform !== 'win32' || brokerState.via === 'broker' || !setup || setup.state === 'installed') return undefined;
  const why = setup.state === 'declined' ? 'Windows asked at this app\'s start and got no Yes' : `its setup at this app's start failed${setup.code !== undefined ? ` (exit ${setup.code})` : ''}`;
  return `The Windows secure desktop (UAC prompts, the locked screen) is out of my reach on this PC: the desktop broker is not installed – ${why}. `
    + `When I need it, I run powershell -ExecutionPolicy Bypass -File "${setup.script}": Windows then asks the person once (the prompt names Windows PowerShell; it installs the desktop broker), and their Yes lets these same tools reach it.`;
}

/** What drivers.ts needs to pick the broker (tests inject a fake). */
export interface BrokerAccess {
  reachable(): boolean;
  lease(log: Logger): Lease;
}

/** The installed broker: its key file readable and its pipe listed (listing \\.\pipe\ opens no instance). */
export function localBroker(pipe = BROKER_PIPE, keyFile = BROKER_KEY): BrokerAccess {
  return {
    reachable: () => {
      try { return fs.existsSync(keyFile) && fs.readdirSync('\\\\.\\pipe\\').includes(path.win32.basename(pipe)); } catch { return false; }
    },
    lease: (log) => brokerLease({ pipe, key: Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64'), log }),
  };
}

const mac = (key: Buffer, label: string, ...parts: Buffer[]) => createHmac('sha256', key).update(Buffer.concat([Buffer.from(label, 'utf8'), ...parts])).digest();

/** `text` sealed for request `id`/`op` with `session` (the worker's Sealer.Open is the other half). */
export function seal(session: Buffer, id: number, op: string, text: string): { iv: string; data: string; mac: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', mac(session, 'enc'), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), data: data.toString('base64'), mac: mac(mac(session, 'mac'), `${id}\n${op}\n`, iv, data).toString('base64') };
}

/** One request line with its typed text sealed ('type' → 'type_secret'; 'act' value; 'signin_store' password); other lines unchanged. */
export function sealLine(line: string, session: Buffer): string {
  const request = JSON.parse(line) as { id: number; op: string; args?: Record<string, unknown> };
  const args = { ...(request.args ?? {}) };
  if (request.op === 'type' && typeof args.text === 'string') {
    const text = args.text;
    delete args.text;
    return `${asciiJson({ id: request.id, op: 'type_secret', args: { ...args, sealed: seal(session, request.id, 'type_secret', text) } })}\n`;
  }
  if (request.op === 'act' && typeof args.value === 'string') {
    const value = args.value;
    delete args.value;
    return `${asciiJson({ id: request.id, op: 'act', args: { ...args, sealed: seal(session, request.id, 'act', value) } })}\n`;
  }
  if (request.op === 'signin_store' && typeof args.password === 'string') { // 22.11.2026: the Windows password (computer/signin.ts)
    const password = args.password;
    delete args.password;
    return `${asciiJson({ id: request.id, op: 'signin_store', args: { ...args, sealed: seal(session, request.id, 'signin_store', password) } })}\n`;
  }
  return line.endsWith('\n') ? line : `${line}\n`;
}

const DESKTOP = /"desktop":"([^"\\]{0,64})"\}\s*$/;

let leases = 0;

/** A lease on one pipe connection: WindowsHelper talks to it like to the PowerShell child. */
export function brokerLease(input: { pipe: string; key: Buffer; log: Logger; connect?: (pipe: string) => net.Socket }): Lease {
  const connectionId = ++leases;
  const socket = (input.connect ?? ((pipe) => net.connect(pipe)))(input.pipe);
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const clientNonce = randomBytes(16);
  let serverNonce: Buffer | undefined;
  let session: Buffer | undefined;
  let buffer = '';
  let observedDesktop: string | undefined;
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });

  const fail = (reason: string) => { input.log.warn('desktop broker refused', { reason }); socket.destroy(); };
  const onLine = (line: string) => {
    if (!serverNonce) {
      const hello = JSON.parse(line) as { broker?: number; nonce?: string };
      serverNonce = Buffer.from(hello.nonce ?? '', 'base64');
      if (hello.broker !== 1 || serverNonce.length !== 16) return fail('no broker greeting');
      socket.write(`${JSON.stringify({ hello: mac(input.key, 'hello', serverNonce, clientNonce).toString('base64'), nonce: clientNonce.toString('base64') })}\n`);
      return;
    }
    if (!session) {
      const ready = JSON.parse(line) as { proof?: string };
      const proof = Buffer.from(ready.proof ?? '', 'base64');
      const expected = mac(input.key, 'proof', serverNonce, clientNonce);
      if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) return fail('the broker did not prove the installation key');
      session = mac(input.key, 'session', serverNonce, clientNonce);
      brokerState.via = 'broker';
      input.log.info('desktop broker authenticated', { connectionId, via: 'broker' });
    }
    const desktop = DESKTOP.exec(line.slice(-100));
    if (desktop) {
      brokerState.desktop = desktop[1];
      // Only names from the transport envelope, never a result, UI text or typed value.
      // Log the first actual response (not just ready) and later desktop changes.
      const response = JSON.parse(line) as { id?: number };
      if (Number.isSafeInteger(response.id) && observedDesktop !== desktop[1]) {
        observedDesktop = desktop[1];
        const name = /^(Default|Winlogon|Screen-saver)$/i.test(desktop[1]) ? desktop[1] : 'other';
        input.log.info('desktop broker observed', { connectionId, requestId: response.id, desktop: name });
      }
    }
    stdout.write(`${line}\n`);
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    try {
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
      }
    } catch { fail('unreadable line'); }
  });
  socket.on('error', (error) => input.log.debug('desktop broker pipe error', { message: error.message }));
  socket.on('close', () => {
    input.log.info('desktop broker disconnected', { connectionId, authenticated: Boolean(session) });
    child.exitCode = session ? 0 : 1;
    stdout.end();
    events.emit('exit', child.exitCode, null);
    events.emit('close', child.exitCode, null);
    resolveExit(child.exitCode);
  });

  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      if (!session) { done(new Error('The desktop broker is not ready.')); return; }
      try {
        const lines = chunk.toString().split('\n').filter((line) => line.trim());
        socket.write(lines.map((line) => sealLine(line, session!)).join(''), () => done());
      } catch (error) { done(error as Error); }
    },
  });

  const child = {
    pid: undefined, stdin, stdout, stderr: null, exitCode: null as number | null,
    kill: () => { socket.destroy(); return true; },
    on: (event: string, listener: (...args: unknown[]) => void) => { events.on(event, listener); return child; },
    once: (event: string, listener: (...args: unknown[]) => void) => { events.once(event, listener); return child; },
  };
  const release = async () => { socket.destroy(); await exited; };
  const now = Date.now();
  return {
    id: connectionId, owner: 'computer:desktop-broker', kind: 'light', startedAt: now, lastActiveAt: now,
    child: child as unknown as ChildLike, touch: () => undefined, release, releaseAfter: release, exited,
  };
}
