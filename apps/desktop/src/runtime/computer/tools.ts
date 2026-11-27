// computer.* tools: what agents call to see and operate a PC (this one or a linked one – the
// registry forwards `remote` tools to ctx.deviceId). Thin adapters over ComputerService;
// computer.act (element steps) is computer/act-tool.ts.
// Owns: schemas, descriptions, action summaries for the run journal, which window and app each seen element
// belongs to (computer/seen.ts), output formatting (a UI tree carries `structured.app` when this PC knows the
// window's app, and computer.windows the list: the registry's app hints read them, knowledge/site-notes.ts).
// Never: hides that an action may have failed. Before a payment or a delete, look at the window again.
//
// Resource: the app (process name) the call works in: a ref's window, an explicit window id, or the window in
// front – as far as this PC's outputs showed them (computer.windows maps windows to apps; computer.ui_tree without
// a window and focus_window tell which one is in front). A step that can bring another window to the front
// (activating, closing, keys, coordinate clicks, drags, typing a newline) forgets the front window until the agent
// observes again. Unknown app, or a call for a linked PC → the PC itself.
//
// Precise pointer steps (23.10.2026, computer/anchors.ts): computer.drag from an element to another
// or by an exact offset, computer.scroll over an element – refs instead of guessed coordinates.
// The Workforce app itself (B-044) is operated like any app.
//
// B-055: each call names its caller (computer/lease.ts callerOf – an agent of a linked PC too), so
// the pointer lease, the agent's own refs and the window memory know who acts; the pointer tools take
// `motion` (computer/tool-notes.ts), and every result ends with who else points on this screen.
// B-080: computer.type reads back which element holds the focus after typing and what it holds (service.ts focused),
// masked like any typed secret – a fact, not a guard. computer.ui_tree of a Chrome or Edge window without a page document
// names that (tree.ts frameOnly), and a covered window's picture says a browser there may not draw its page (live 09.11.).
// F03 (16.11.2026): on Windows without the desktop broker, a screenshot says that the secure desktop (UAC, lock screen) is out
// of reach, why (the setup at the app's start: no Yes, or failed) and how one Yes at the Windows prompt changes it (broker.ts).
// Owner 24.11.2026 (a coordinate click landed left of the UAC prompt's Yes): on the secure desktop the screenshot and a
// coordinate click name the element way first (broker.ts UAC_BY_ELEMENT: OkButton / CancelButton, computer.act invoke).
// KI-Runde 17.11.2026: computer.wait and computer.batch (flow-tools.ts) beside these; a ui_tree search finds up to maxNodes
// matches (at most the helper's 100, default 20) and, when it stops early, says how to get the rest.

import type { ToolDef, ToolOutput } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import type { ComputerService, Screenshot, WindowInfo } from './service.ts';
import { deviceAction as device, labelWords, onThisPc, RefLabels, WindowApps } from './seen.ts';
import { actTool } from './act-tool.ts';
import { ANCHOR_SCHEMA, dragPoints, OFFSET_SCHEMA, resolveAnchor, type Anchor, type Offset } from './anchors.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { judgeTyped, typedText } from '../secrets/handles.ts';
import { callerOf } from './lease.ts';
import { lockedDesktop, secureDesktopLine, UAC_BY_ELEMENT } from './broker.ts';
import { MOTION_ARG, withNotes, withOthers } from './tool-notes.ts';
import { frameOnly, TREE_DEPTH } from './tree.ts';
import { batchTool, waitTool } from './flow-tools.ts';
import type { MotionStyle } from '../../shared/model/pointer-motion.ts';

export { idWords, onThisPc, RefLabels, WindowApps } from './seen.ts';

const COORDS = { type: 'string', enum: ['screen', 'screenshot'], description: 'screen (default) or screenshot: pixels of my last computer.screenshot.' };
const WINDOW = { type: 'integer', description: 'From computer.windows.' };
const BUTTON = { type: 'string', enum: ['left', 'right', 'middle'] };
const INT = { type: 'integer' };
/** The most matches one ui_tree search finds (service.ts find clamps to it). */
const SEARCH_MAX = 100;

export function imageOutput(shot: Pick<Screenshot, 'data' | 'mime'>, caption: string, structured?: unknown): ToolOutput {
  return {
    content: [
      { type: 'image', mime: shot.mime, dataBase64: Buffer.from(shot.data).toString('base64') },
      { type: 'text', text: caption },
    ],
    structured,
  };
}

export function windowLine(window: WindowInfo): string {
  const flags = [
    window.foreground ? '[foreground]' : '', window.minimized ? '[minimized]' : '', window.app ? '[Autark – this app]' : '',
  ].filter(Boolean).join(' ');
  const rect = window.rect ? ` · ${window.rect[0]},${window.rect[1]} ${window.rect[2]}x${window.rect[3]}` : '';
  return `- window ${window.hwnd} "${window.title}" · ${window.process || 'unknown'} (pid ${window.pid})${rect}${flags ? ` ${flags}` : ''}`;
}

export function computerTools(computer: ComputerService): ToolDef[] {
  const refLabels = new RefLabels();
  const apps = new WindowApps();
  const inFront = () => apps.app(apps.front);
  const forgetFront = () => { apps.front = undefined; };
  const screenshot = defineTool<{ display?: number; window?: number; region?: { x: number; y: number; width: number; height: number }; ocr?: boolean; maxEdge?: number }>({
    name: 'computer.screenshot',
    description: 'Takes a screenshot of a screen, a window or a region. The text says how its pixels map to the screen; for drawn content it is the way, for structure computer.ui_tree.',
    inputSchema: {
      type: 'object',
      properties: {
        display: { type: 'integer', minimum: 0, maximum: 16, description: '0 = primary.' },
        window: WINDOW,
        region: { type: 'object', properties: { x: INT, y: INT, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false, description: 'Screen pixels.' },
        ocr: { type: 'boolean', description: 'Adds the recognised text lines (Windows).' },
        maxEdge: { type: 'integer', minimum: 320, maximum: 2400, description: 'Longest image edge.' },
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(args.window !== undefined ? 'Screenshot of a window' : 'Screenshot of the screen', ctx, true, args.window !== undefined ? apps.app(args.window) : undefined),
    async run(args, ctx) {
      ctx.status('looking at the screen');
      const shot = await computer.screenshot({ ...args, agentId: ctx.agent.id, signal: ctx.signal });
      const lines = [
        `Screenshot ${shot.width}×${shot.height} (${shot.source}). Image pixel (0,0) = screen (${shot.origin.x},${shot.origin.y}); 1 image pixel = ${round(shot.scale)} screen pixels.`,
        'To click something seen here, pass its image pixel with coords:"screenshot", or use the screen coordinates from computer.ui_tree.',
      ];
      // B-080: a window draws itself into its picture, also where a click by coordinates would hit another window; a covered
      // browser draws no page (live 09.11.: the person's Chrome behind their app read as blank).
      if (shot.covered) lines.push('This window is behind another one or off the screen: the picture is the window itself, and a click by coordinates lands on what is in front there – I bring it forward first with computer.act focus_window. A browser behind another window may not draw its page.');
      if (!computer.usesSecureWindowsHelper() && lockedDesktop()) lines.push(`This is the Windows secure desktop (locked screen or UAC prompt). ${UAC_BY_ELEMENT} I reach it through the desktop broker with these same tools; on the sign-in screen "Sign-in options" leads to the password, which I type as its secret:// handle.`);
      const outOfReach = computer.usesSecureWindowsHelper() ? undefined : secureDesktopLine(); // F03: no broker after the setup at the app's start – why, and the one Yes that changes it
      if (outOfReach) lines.push(outOfReach);
      if (shot.ocr?.length) {
        lines.push('Recognised text (screen coordinates x,y width×height):');
        for (const line of shot.ocr.slice(0, 300)) lines.push(`- "${line.text}" @${line.rect[0]},${line.rect[1]} ${line.rect[2]}×${line.rect[3]}`);
      } else if (args.ocr) {
        lines.push('No text recognised.');
      }
      return imageOutput(shot, lines.join('\n'), { width: shot.width, height: shot.height, origin: shot.origin, scale: shot.scale, ocr: shot.ocr });
    },
  });

  const windows = defineTool<Record<string, never>>({
    name: 'computer.windows',
    description: 'Lists the open windows with id, title, app, position and which is in front. Here I start, then read a window with computer.ui_tree.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => device('List open windows', ctx),
    async run(_args, ctx) {
      const list = await computer.windows(ctx.signal);
      if (onThisPc(ctx)) apps.learn(list);
      if (!list.length) return text('No visible windows.');
      return { ...text(list.map(windowLine).join('\n')), structured: list };
    },
  });

  const uiTree = defineTool<{ window?: number; depth?: number; maxNodes?: number; name?: string; automationId?: string; role?: string }>({
    name: 'computer.ui_tree',
    description: "Reads a window's UI elements with a ref each for computer.act, or searches them. Each with role, name, value, state, actions and centre point.",
    inputSchema: {
      type: 'object',
      properties: {
        window: { ...WINDOW, description: 'Default the one in front.' },
        depth: { type: 'integer', minimum: 1, maximum: 40 },
        maxNodes: { type: 'integer', minimum: 20, maximum: 2000, description: 'Elements to read; a search finds up to 100 (default 20).' },
        name: { type: 'string', maxLength: 200, description: 'Search: name contains.' },
        automationId: { type: 'string', maxLength: 200, description: 'Search: the exact automation id.' },
        role: { type: 'string', maxLength: 40, description: 'Search: control type, e.g. button.' },
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(args.name || args.automationId || args.role ? 'Search a window\'s UI elements' : 'Read a window\'s UI elements', ctx, true, apps.app(args.window ?? apps.front)),
    async run(args, ctx) {
      ctx.status('reading the window');
      if (args.name || args.automationId || args.role) {
        const found = await computer.find({ window: args.window, name: args.name, automationId: args.automationId, role: args.role, max: args.maxNodes, signal: ctx.signal, caller: callerOf(ctx) });
        refLabels.learn(found.text, args.window ?? apps.front);
        // The maxNodes clause only while a higher one would find more: at SEARCH_MAX there is nothing left to raise.
        const stopped = found.truncated ? ` (search stopped at ${found.count} – ${found.count < SEARCH_MAX ? `maxNodes up to ${SEARCH_MAX} finds more, a narrower name or role fewer` : 'a narrower name or role finds fewer'})` : '';
        return text(found.count ? `${found.count} match${found.count === 1 ? '' : 'es'}${stopped}:\n${found.text}` : 'No matching element. Read the whole tree or check the window.');
      }
      const tree = await computer.uiTree({ window: args.window, depth: args.depth, maxNodes: args.maxNodes, signal: ctx.signal, caller: callerOf(ctx) });
      refLabels.learn(tree.text, tree.window.hwnd);
      if (args.window === undefined && onThisPc(ctx)) apps.front = tree.window.hwnd;
      const head = `Window ${tree.window.hwnd} "${tree.window.title}" · ${tree.count} elements${tree.truncated ? ' (truncated – raise maxNodes or search by name/role)' : ''}. Format: role "name" [ref] #automationId = value [state] (actions) @centre-x,centre-y`;
      // B-080: a browser window's whole tree (not cut by maxNodes, read at least as deep as a read without a depth) without a page document says so.
      const frame = tree.truncated || (args.depth !== undefined && args.depth < TREE_DEPTH) ? undefined : frameOnly(tree.window.title, tree.text);
      return withNotes({ ...text(`${head}${frame ? `\n${frame}` : ''}\n${tree.text}`), structured: { window: tree.window.hwnd, app: apps.app(tree.window.hwnd) } }, tree.shared);
    },
  });

  const act = actTool(computer, refLabels, apps);

  const click = defineTool<{ x: number; y: number; button?: 'left' | 'right' | 'middle' | 'none'; count?: number; coords?: 'screen' | 'screenshot'; motion?: MotionStyle }>({
    name: 'computer.click',
    description: 'Clicks at a screen point; button none only moves the pointer. An element with a ref I act on with computer.act.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle', 'none'] }, count: { type: 'integer', minimum: 1, maximum: 3, description: '2 = double-click.' }, coords: COORDS, motion: MOTION_ARG },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(`${args.button === 'none' ? 'Move the pointer to' : 'Click at'} ${args.x},${args.y}`, ctx, args.button === 'none', inFront()),
    async run(args, ctx) {
      if (args.button !== 'none') forgetFront();
      const step = { coords: args.coords, agentId: ctx.agent.id, signal: ctx.signal, caller: callerOf(ctx), motion: args.motion };
      if (args.button === 'none') {
        const point = await computer.move({ x: args.x, y: args.y, ...step });
        return withNotes(text(`Pointer at screen ${point.x},${point.y}.`), point.shared);
      }
      ctx.status('clicking');
      const point = await computer.click({ x: args.x, y: args.y, button: args.button, count: args.count, ...step });
      // Owner 24.11.2026: a click by coordinates on the secure desktop missed the UAC prompt's Yes – the element way follows it.
      const secure = !computer.usesSecureWindowsHelper() && lockedDesktop() ? `\nThis click went to the Windows secure desktop. ${UAC_BY_ELEMENT}` : '';
      return withNotes(text(`Clicked ${args.button ?? 'left'}${args.count && args.count > 1 ? ` ×${args.count}` : ''} at screen ${point.x},${point.y}. Not verified – observe the result.${secure}`), point.shared);
    },
  });

  const type = defineTool<{ text: string; ref?: string }>({
    name: 'computer.type',
    description: 'Types text with the keyboard into the focused element and shows what it holds afterwards. A live app can move the focus while I type; a whole field value goes in at once with computer.act set_value.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 5000, description: 'Newlines press Enter.' }, ref: { type: 'string', maxLength: 20, description: 'An element to focus first.' } }, required: ['text'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => {
      const label = args.ref && onThisPc(ctx) ? refLabels.get(args.ref) : undefined;
      const action = device(`Type ${args.text.length} characters${args.ref ? ` into ${args.ref}` : ''}`, ctx, false, apps.app(args.ref ? refLabels.window(args.ref) : apps.front));
      return judgeTyped(ctx, action, args.text);
    },
    async run(args, ctx) {
      if (args.text.includes('\n')) forgetFront();
      const caller = callerOf(ctx);
      if (args.ref) await computer.act({ ref: args.ref, action: 'focus', signal: ctx.signal, caller });
      ctx.status('typing');
      const typed = await typedText(ctx, args.text); // secret://<id> → the value, now (secrets/handles.ts)
      const count = await computer.type({ text: typed.text, signal: ctx.signal, caller });
      // B-080 (live 06.11.: WhatsApp moved the focus mid-word into an open chat): where the text landed, read back.
      let now: { text: string; hwnd: number } | undefined;
      try { now = await computer.focused(caller, ctx.signal); } catch { now = undefined; }
      if (!now) return text(`Typed ${count} characters. I check the field before the next step.`);
      refLabels.learn(now.text, now.hwnd);
      const lines = [`Typed ${count} characters.`, `Now: ${now.text.replace(/^\s*-\s+/, '')}`];
      if (args.ref && !now.text.includes(`[ref=${args.ref}]`)) lines.push(`The focus is no longer on ${args.ref}.`);
      return text(typed.mask(lines.join('\n'))); // a typed secret shows as its handle (secrets/handles.ts)
    },
  });

  const key = defineTool<{ keys: string; repeat?: number }>({
    name: 'computer.key',
    description: 'Presses a key or shortcut in the window in front, e.g. "ctrl+s".',
    inputSchema: { type: 'object', properties: { keys: { type: 'string', minLength: 1, maxLength: 40 }, repeat: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['keys'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(`Press ${args.keys}${args.repeat && args.repeat > 1 ? ` ×${args.repeat}` : ''}`, ctx, false, inFront()),
    async run(args, ctx) {
      forgetFront();
      await computer.key({ combo: args.keys, repeat: args.repeat, signal: ctx.signal, caller: callerOf(ctx) });
      return text(`Pressed ${args.keys}${args.repeat && args.repeat > 1 ? ` ×${args.repeat}` : ''}.`);
    },
  });

  const scroll = defineTool<{ dy?: number; dx?: number; x?: number; y?: number; coords?: 'screen' | 'screenshot'; at?: Anchor; motion?: MotionStyle }>({
    name: 'computer.scroll',
    description: 'Scrolls with the mouse wheel over an element, at a point, or where the pointer is. For lists that support it, computer.act scroll is more precise.',
    inputSchema: {
      type: 'object',
      properties: {
        dy: { type: 'integer', minimum: -50, maximum: 50, description: 'Notches; positive is down.' }, dx: { type: 'integer', minimum: -50, maximum: 50, description: 'Notches; positive is right.' },
        x: { type: 'number' }, y: { type: 'number' }, coords: COORDS, at: ANCHOR_SCHEMA, motion: MOTION_ARG,
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(`Scroll ${args.dy ?? 0}/${args.dx ?? 0}${args.at ? ` over ${refLabels.get(args.at.ref) ?? args.at.ref}` : ''}`, ctx, true, inFront()),
    async run(args, ctx) {
      const { at, ...rest } = args;
      const caller = callerOf(ctx);
      const point = at ? resolveAnchor(at, (ref) => computer.elementRect(ref, caller)) : undefined;
      const done = await computer.scroll({ ...rest, ...(point ? { x: point.x, y: point.y, coords: 'screen' as const } : {}), agentId: ctx.agent.id, signal: ctx.signal, caller });
      return withNotes(text('Scrolled. Observe again to see what is visible now.'), done?.shared);
    },
  });

  type DragArgs = { x1?: number; y1?: number; x2?: number; y2?: number; from?: Anchor; to?: Anchor; by?: Offset; durationMs?: number; button?: 'left' | 'right' | 'middle'; coords?: 'screen' | 'screenshot'; motion?: MotionStyle };
  const dragWhat = (args: DragArgs) => (args.from
    ? `Drag ${refLabels.get(args.from.ref) ?? args.from.ref} ${args.to ? `onto ${refLabels.get(args.to.ref) ?? args.to.ref}` : `by ${args.by?.dx ?? 0},${args.by?.dy ?? 0} px`}`
    : `Drag from ${args.x1},${args.y1} to ${args.x2},${args.y2}`);
  const drag = defineTool<DragArgs>({
    name: 'computer.drag',
    description: 'Drags smoothly between elements, by an offset, or between points. It suits timelines, sliders and selections; durationMs sets the speed.',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        from: ANCHOR_SCHEMA, to: ANCHOR_SCHEMA, by: OFFSET_SCHEMA,
        durationMs: { type: 'integer', minimum: 50, maximum: 10_000 }, button: BUTTON, coords: COORDS, motion: MOTION_ARG,
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(dragWhat(args), ctx, false, inFront()),
    async run(args, ctx) {
      const { from, to, by, ...rest } = args;
      const caller = callerOf(ctx);
      let points: { x1: number; y1: number; x2: number; y2: number; coords?: 'screen' | 'screenshot' };
      if (from) {
        if (!to === !by) throw new WorkforceError('bad_request', 'With from, give either to (an element) or by (dx, dy).');
        const resolved = dragPoints(from, (to ?? by)!, (ref) => computer.elementRect(ref, caller));
        points = { x1: resolved.from.x, y1: resolved.from.y, x2: resolved.to.x, y2: resolved.to.y, coords: 'screen' };
      } else {
        if (![rest.x1, rest.y1, rest.x2, rest.y2].every((value) => typeof value === 'number')) throw new WorkforceError('bad_request', 'Give from with to or by, or the coordinates x1, y1, x2, y2.');
        points = { x1: rest.x1!, y1: rest.y1!, x2: rest.x2!, y2: rest.y2!, coords: rest.coords };
      }
      forgetFront();
      ctx.status('dragging');
      const result = await computer.drag({ ...points, durationMs: rest.durationMs, button: rest.button, agentId: ctx.agent.id, signal: ctx.signal, caller, motion: rest.motion });
      return withNotes(text(`Dragged from screen ${result.from.x},${result.from.y} to ${result.to.x},${result.to.y}. Verify the result.`), result.shared);
    },
  });

  const wait = waitTool(computer, refLabels, apps);
  const batch = batchTool([act, click, type, key, scroll, drag, wait]);
  return withOthers([screenshot, windows, uiTree, act, click, type, key, scroll, drag, wait, batch], (caller) => computer.othersLine?.(caller) ?? '');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
