// The phone hears a dictation piece itself (STIMME 21.11.2026, owner: "if possible with the cloud, do it in the cloud;
// otherwise it has to go over the PC like before"): in the Android app (its status says hear:true) the piece goes
// to the app over the native port ({t:'hear', id, data, mime, language}) and the app posts it to the person's ChatGPT
// plan dictation endpoint itself – the same endpoint, file and language hint the PC would send (apps/android
// phoneuse/PlanHearing.java, with the plan login the PC hands to this paired phone, RPC voice.planLogin). A page cannot
// call that endpoint: chatgpt.com answers a preflight from another origin 400 without Access-Control-Allow-Origin
// (measured 21.11.2026), so the iPhone web app and browsers keep the PC's way. Any failure, a slow answer or no app gives
// undefined and lib/dictation.ts uploads the piece for voice.transcribe as before; '' is a piece without words.
// Owns: the page side of that request. Never: a token (the app holds the login), or audio anywhere but the app's port.

import { nativeCan, onNative, sendNative } from '../pwa/native-port.ts';

/** How long the app may take for one piece (its own request ends at 45 s, a fresh login adds up to 20 s). */
export const DIRECT_WAIT_MS = 70_000;
/** The largest piece that goes this way (a 90 s WAV is 2.9 MB; the endpoint takes 25 MB). */
const DIRECT_MAX_BYTES = 8 * 1024 * 1024;
const FORMATS = /^audio\/(?:wav|ogg)$/;

/** What the page hears a piece with, without the PC; undefined: not here or it failed – the PC's way follows. */
export interface DirectHearing {
  /** This page can hear by itself now (the app's port says so). */
  ready(): boolean;
  hear(blob: Blob, language: string | undefined): Promise<string | undefined>;
}

/** The port the request goes over (tests: a fake). */
export interface DirectPort {
  can(feature: string): boolean;
  send(msg: { t: string } & Record<string, unknown>): boolean;
  on(type: string, fn: (msg: Record<string, unknown>) => void): () => void;
}

const appPort: DirectPort = { can: nativeCan, send: sendNative, on: onNative };
let ids = 0;

/** The Android app's hearing over `port`, waiting at most `waitMs` for its answer. */
export function directHearing(port: DirectPort = appPort, waitMs = DIRECT_WAIT_MS): DirectHearing {
  return {
    ready: () => port.can('hear'),
    hear: async (blob, language) => {
      const mime = blob.type.split(';')[0].trim().toLowerCase();
      if (!port.can('hear') || !FORMATS.test(mime) || !blob.size || blob.size > DIRECT_MAX_BYTES) return undefined;
      const data = await base64Of(blob);
      const id = `h${Date.now().toString(36)}${(++ids).toString(36)}`;
      return new Promise<string | undefined>((resolve) => {
        let done = false;
        const finish = (text: string | undefined) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          off();
          resolve(text);
        };
        const off = port.on('heard', (msg) => {
          if (msg.id !== id) return;
          finish(typeof msg.text === 'string' && msg.error === undefined ? msg.text.trim() : undefined);
        });
        const timer = setTimeout(() => finish(undefined), waitMs);
        if (!port.send({ t: 'hear', id, data, mime, ...(language ? { language } : {}) })) finish(undefined);
      });
    },
  };
}

/** The blob's bytes as base64 (in slices: no argument list grows with the take). */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
