// phone.* tools: operate an Android phone – B-078: the person's phone with the Autark app (phone use, no ADB: serial =
// its device id, phone/drivers.ts) or one connected to a PC over ADB (USB or wireless debugging) – and connect an ADB
// one: phone.pair with the 6-digit code from the phone's pairing dialog, phone.connect, phone.disconnect;
// phone.devices also lists phones nearby. Remote-capable – the phone hangs off whichever PC it is paired with. The skills
// phone-access (the app) and phone-adb (adb) say how each is set up. Every output of an action says to look again (no
// blind chains); phone.type through the app shows what the field reads afterwards instead (masked like any readback).
// Each step names the agent (`by`) for the app's bubble; phone.say (feedback 16.11.2026 F16) puts my
// line or question (✓ / ✕, or my own buttons – owner 19.11.2026) there, so the person sees what I do without opening
// the app and answers with one tap.
// KI-Runde 17.11.2026: each description opens with what the prompt's one-line list must carry – phone.say the ask,
// phone.key the app phone's keys with notifications (what just arrived, an SMS code), phone.ui_tree that it reads the screen.
// Owns: schemas, summaries, output formatting. Never: repeats a pairing code in a summary or an output.

import type { ToolContext, ToolDef } from '../tools/types.ts';
import { failure, json, text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import { imageOutput } from '../computer/tools.ts';
import { notConnected, pairThenConnect } from './connect.ts';
import { movingKey } from './adb-args.ts';
import { typedText } from '../secrets/handles.ts';
import { PHONE_BUTTON_MAX, PHONE_SAY_BUTTONS_MAX, PHONE_SAY_MAX } from '../../shared/api/methods-phone.ts';
import { FIELD_MAX } from './app-driver.ts';
import type { PhoneDriver, PhoneStepOptions, PhoneWireless } from './driver.ts';

type Phone = PhoneDriver & PhoneWireless;

const SERIAL = { type: 'string', maxLength: 120, description: 'Needed only with several phones (phone.devices).' };
const VERIFY = 'Not verified – I read phone.ui_tree before the next step.';
/** After a secret went to the phone: the phone has the value; whatever I read back (ui_tree, a screenshot's text) shows it as its handle. */
const MASKED = 'The phone got the stored value; phone.ui_tree shows it as its secret:// handle (masked), not as typed text.';
const ADDRESS = { type: 'string', minLength: 3, maxLength: 260, description: 'host:port shown on the phone.' };
const short = (value: unknown) => String(value ?? '').slice(0, 80);
/** A say is a question with ask or with buttons. */
const asks = (args: { ask?: boolean; buttons?: unknown }) => args.ask === true || Array.isArray(args.buttons);

const where = (ctx: ToolContext) => ctx.deviceId ?? 'this PC';
const phone = (summary: string, ctx: ToolContext, reversible: boolean) => ({ summary, resource: where(ctx), reversible, external: false });

export function phoneTools(adb: Phone): ToolDef[] {
  const step = (ctx: ToolContext): PhoneStepOptions => ({ signal: ctx.signal, job: ctx.runId, by: ctx.agent?.name });

  const devices = defineTool<Record<string, never>>({
    name: 'phone.devices',
    description: "Lists the Android phones I can use from this PC, with their state. The person's phone with the Autark app, phones over ADB, and phones nearby offering pairing.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => phone('List connected phones', ctx, true),
    async run() {
      if (!(await adb.available())) return text("No phone is connected: the Autark app on the person's phone is not connected to this PC right now, and adb is not installed here (skill phone-access for the app; skill phone-adb: winget install Google.PlatformTools).");
      const list = await adb.devices();
      const nearby = notConnected(await adb.discover().catch(() => []), list);
      const lines = list.map((d) => `- ${d.serial} · ${d.state} · ${d.transport === 'autark-app' ? 'Autark app' : 'ADB'}${d.model ? ` · ${d.model}` : ''}`);
      const near = nearby.map((n) => `- ${n.address} · ${n.service === 'pairing' ? 'pairing dialog open (phone.pair with the code shown there)' : 'paired phone ready to connect (phone.connect)'}`);
      if (!lines.length && !near.length) return text("No phone is connected. The person's phone joins with the Autark app (skill phone-access); another one with wireless debugging (skill phone-adb, then phone.pair).");
      const body = [lines.length ? lines.join('\n') : 'No phone is connected.', near.length ? `Nearby:\n${near.join('\n')}` : ''].filter(Boolean).join('\n');
      return { ...text(body), structured: { devices: list, nearby } };
    },
  });

  const pair = defineTool<{ address: string; code: string; connect?: string }>({
    name: 'phone.pair',
    description: 'Pairs an Android phone over wireless debugging with its pairing code, then connects.',
    inputSchema: {
      type: 'object',
      properties: { address: { ...ADDRESS, description: 'host:port from the pairing dialog.' }, code: { type: 'string', minLength: 6, maxLength: 20 }, connect: { ...ADDRESS, description: 'host:port under Wireless debugging; default found nearby.' } },
      required: ['address', 'code'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    // A pairing leaves a lasting trust on the phone that only the phone can undo.
    describe: (args, ctx) => phone(`Pair the Android phone at ${short(args.address)} with ${where(ctx)}`, ctx, false),
    async run(args, ctx) {
      ctx.status('pairing the phone');
      const result = await pairThenConnect(adb, args);
      if (result.connected) return text(`Paired with ${result.paired} and connected to ${result.connected}. phone.devices shows the phone as "device" once it is ready.`);
      return text(`Paired with ${result.paired}, not connected yet: ${result.connectError ?? 'no connect port known'} Then call phone.connect.`);
    },
  });

  const connect = defineTool<{ address: string }>({
    name: 'phone.connect',
    description: 'Connects to an already paired phone over wireless debugging. Its address under Wireless debugging changes after a restart.',
    inputSchema: { type: 'object', properties: { address: ADDRESS }, required: ['address'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Connect to the Android phone at ${short(args.address)} from ${where(ctx)}`, ctx, false), // any host:port
    async run(args, ctx) {
      ctx.status('connecting to the phone');
      const result = await adb.connect(args.address);
      const state = (await adb.devices().catch(() => [])).find((device) => device.serial === result.address)?.state;
      const hint = state === 'unauthorized' ? ' The phone waits for the person to unlock it and allow this PC.' : state && state !== 'device' ? ' Reconnect or pair again.' : '';
      return text(`${result.already ? 'Already connected to' : 'Connected to'} ${result.address}${state ? ` (state: ${state})` : ''}.${hint}`);
    },
  });

  const disconnect = defineTool<{ serial: string }>({
    name: 'phone.disconnect',
    description: 'Disconnects a phone on wireless debugging.',
    inputSchema: { type: 'object', properties: { serial: { ...SERIAL, minLength: 3, description: 'From phone.devices.' } }, required: ['serial'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Disconnect the Android phone ${short(args.serial)} from ${where(ctx)}`, ctx, true),
    async run(args) {
      const result = await adb.disconnect(args.serial);
      // adb's answer is not the truth for every serial (an mDNS-connected phone): the list is.
      const listed = (await adb.devices().catch(() => undefined))?.some((device) => device.serial.replace(/\.$/, '') === result.serial.replace(/\.$/, ''));
      if (listed) return text(`${result.serial} is still connected (adb did not disconnect it). The person can turn wireless debugging off on the phone.`);
      return text(result.was ? `Disconnected ${result.serial}. The person can turn wireless debugging off on the phone.` : `${result.serial} was not connected.`);
    },
  });

  const screenshot = defineTool<{ serial?: string }>({
    name: 'phone.screenshot',
    description: 'Takes a screenshot of the phone screen; the text gives the factor to phone pixels. Elements I find with phone.ui_tree.',
    inputSchema: { type: 'object', properties: { serial: SERIAL }, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => phone('Screenshot of the phone', ctx, true),
    async run(args, ctx) {
      ctx.status('looking at the phone');
      const shot = await adb.screenshot(args.serial, step(ctx));
      return imageOutput(shot, `Phone ${shot.serial} screen ${shot.screen.width}×${shot.screen.height}; image ${shot.width}×${shot.height} (1 image pixel = ${Math.round(shot.scale * 1000) / 1000} phone pixels). Tap with phone pixels.`);
    },
  });

  const uiTree = defineTool<{ serial?: string }>({
    name: 'phone.ui_tree',
    description: 'Reads the phone screen: every element with its text and the point to tap it.',
    inputSchema: { type: 'object', properties: { serial: SERIAL }, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => phone('Read the phone screen', ctx, true),
    async run(args, ctx) {
      ctx.status('reading the phone screen');
      const tree = await adb.uiTree(args.serial, step(ctx));
      const head = `Phone ${tree.serial}${tree.screen ? ` · ${tree.screen.width}×${tree.screen.height}` : ''} · ${tree.count} elements${tree.truncated ? ' (truncated)' : ''}. Format: class "text" (description) #id (actions) @x,y`;
      return text(`${head}\n${tree.text || '(nothing readable – the app may draw its own UI; phone.screenshot shows it)'}`);
    },
  });

  const tap = defineTool<{ x: number; y: number; serial?: string }>({
    name: 'phone.tap',
    description: "Taps at phone pixel coordinates, an element's @x,y from phone.ui_tree.",
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, serial: SERIAL }, required: ['x', 'y'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Tap the phone at ${args.x},${args.y}`, ctx, false),
    async run(args, ctx) {
      ctx.status('tapping on the phone');
      await adb.tap(args.serial, args.x, args.y, step(ctx));
      return text(`Tapped ${Math.round(args.x)},${Math.round(args.y)}. ${VERIFY}`);
    },
  });

  const swipe = defineTool<{ x1: number; y1: number; x2: number; y2: number; via?: Array<{ x: number; y: number }>; durationMs?: number; serial?: string }>({
    name: 'phone.swipe',
    description: 'Swipes on the phone from one point to another, e.g. upwards to scroll; with via one unlifted finger passes more points (a lock pattern).',
    inputSchema: {
      type: 'object',
      properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, via: { type: 'array', maxItems: 16, items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false }, description: 'Points between start and end, in order, straight from one to the next (Autark app 0.3.21+; an older app swipes straight from start to end).' }, durationMs: { type: 'integer', minimum: 50, maximum: 10_000, description: '300–500 ms scrolls a list.' }, serial: SERIAL },
      required: ['x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Swipe on the phone from ${args.x1},${args.y1} to ${args.x2},${args.y2}`, ctx, false), // swipe-to-delete, swipe-to-confirm
    async run(args, ctx) {
      await adb.swipe(args.serial, { x: args.x1, y: args.y1 }, { x: args.x2, y: args.y2 }, args.durationMs, step(ctx), args.via);
      return text(`Swiped. ${VERIFY}`);
    },
  });

  const type = defineTool<{ text: string; serial?: string }>({
    name: 'phone.type',
    description: 'Types text into the focused field on the phone. Over ADB only ASCII, through the Autark app any text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000, description: 'Newlines press Enter.' }, serial: SERIAL }, required: ['text'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Type ${args.text.length} characters on the phone`, ctx, false),
    async run(args, ctx) {
      ctx.status('typing on the phone');
      const typed = await typedText(ctx, args.text); // secret://<id> → the value, now (secrets/handles.ts)
      const field = await adb.type(args.serial, typed.text, step(ctx));
      const secret = typed.text === args.text ? '' : ` ${MASKED}`;
      // Chat sweep 16.11.2026 (words beside the typed text in a field): the field's text read back, masked like any readback.
      if (typeof field === 'string') return text(typed.mask(`Typed ${args.text.length} characters. The field now reads: "${field.slice(0, FIELD_MAX)}".${secret}`));
      return text(`Typed ${args.text.length} characters.${secret} ${VERIFY}`);
    },
  });

  const key = defineTool<{ key: string; serial?: string }>({
    name: 'phone.key',
    description: 'Presses a phone key such as back, home or notifications, which shows what just arrived. On the phone with the Autark app the keys are wakeup (turns a dark screen on, the lock stays; app 0.3.21+), back, home, recents, notifications (the shade with fresh messages and codes, which phone.ui_tree then reads), quick_settings and enter.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 40, description: 'Autark app: wakeup, back, home, recents, notifications, quick_settings, enter. Over ADB: back, home, recents, enter, delete, tab, escape, arrows, page_up/page_down or wakeup.' }, serial: SERIAL }, required: ['key'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Press ${short(args.key)} on the phone`, ctx, movingKey(args.key)),
    async run(args, ctx) {
      const code = await adb.key(args.serial, args.key, step(ctx));
      return text(`Pressed ${code}. ${VERIFY}`);
    },
  });

  const open = defineTool<{ url?: string; package?: string; app?: string; serial?: string }>({
    name: 'phone.open',
    description: 'Opens a link or an installed app on the phone – an app by the name under its icon (app) or by its package.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 4000, description: 'A private link as its secret:// handle works.' },
        app: { type: 'string', maxLength: 100, description: 'The name under the icon, e.g. WhatsApp (Autark app).' },
        package: { type: 'string', maxLength: 200, description: 'e.g. com.whatsapp.' },
        serial: SERIAL,
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Open ${short(args.url ?? args.package ?? args.app)} on the phone`, ctx, false), // a link can start an action in an app
    async run(args, ctx) {
      if (!args.url && !args.package && !args.app) return failure('Give url, app or package.');
      const link = args.url === undefined ? undefined : await typedText(ctx, args.url); // a stored private link opens by its handle
      const opened = await adb.open(args.serial, { url: link?.text, package: args.package, app: args.app }, step(ctx));
      const named = link !== undefined && link.text !== args.url;
      return json({ opened: named ? args.url : opened, ...(named ? { masked: MASKED } : {}), note: VERIFY });
    },
  });

  const say = defineTool<{ text: string; ask?: boolean; buttons?: string[]; serial?: string }>({
    name: 'phone.say',
    description: "Asks the person on their phone, or shows my line there, in the Autark app's bubble: keywords or one short sentence. Without ask or buttons the line shows what I do. ask: true gives my question ✓ and ✕; buttons gives it my own short answers (✕ always stays). I get the tapped button – yes for ✓, no for ✕ – or none after 60 s; ✓ gives me the phone for this task. Their own taps meanwhile leave my steps running, so a question is for what I need their answer to.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: PHONE_SAY_MAX, description: 'Keywords or one short sentence.' },
        ask: { type: 'boolean' },
        buttons: { type: 'array', maxItems: PHONE_SAY_BUTTONS_MAX, items: { type: 'string', minLength: 1, maxLength: PHONE_BUTTON_MAX }, description: 'My answers to tap, a word or a few each ("✓", "Later", "Send the invoice first").' },
        serial: SERIAL,
      },
      required: ['text'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    // A line in the bubble changes nothing on the phone; my next line or the job's end replaces it.
    describe: (args, ctx) => phone(asks(args) ? `Ask on the phone: "${short(args.text)}"` : `Show "${short(args.text)}" on the phone`, ctx, true),
    async run(args, ctx) {
      const question = asks(args);
      ctx.status(question ? 'asking on the phone' : 'writing on the phone');
      const buttons = Array.isArray(args.buttons) ? args.buttons : question ? ['✓'] : undefined;
      const said = await adb.say(args.serial, args.text, buttons, step(ctx));
      if (!question) return text("The bubble shows my line until my next one or the end of this task's phone use.");
      if (said.answer === 'yes') return text('The person answered ✓: the phone is mine for this task now. I look at the screen (phone.ui_tree) before my first step.');
      if (said.answer === 'no') return text('The person answered ✕ – not now: they keep the phone for the moment. What I needed from it I ask them for in our chat, and I go on with other work.');
      if (said.answer && said.answer !== 'none') return { ...text(`The person tapped "${said.answer}".`), structured: { answer: said.answer } };
      return text('No answer within 60 s – the person did not tap. My phone steps run as usual.');
    },
  });

  return [devices, pair, connect, disconnect, screenshot, uiTree, tap, swipe, type, key, open, say];
}
