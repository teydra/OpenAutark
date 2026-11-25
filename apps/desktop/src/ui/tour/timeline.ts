// B-055 Q5, re-cut 16.11.2026 for the snapshot overlay (feedback F11/F15): the feedback tour as a pure timeline – "a
// little start video made of code" – one per variant (scene-layout.ts: the computer's window, a phone's screen). A
// script of beats (move, press, hold, paint, wait, show/hide, caption, chapter) is compiled once into tracks: the
// pointer's path from the shared motion model (shared/model/pointer-motion.ts, style 'human' with fixed seeds, so the
// hand-like path is the same on every run and any moment can be sought), pressed spans, press rings, on/off switches
// (the cell's tooltip, the frozen screen, listening, transcribing, sent, the end card), the transcript's word-by-word
// reveal, the pen's stroke and the captions. stateAt(t) reads every track at one moment; the scene draws only that
// state, so playing, pausing and scrubbing are the same thing.
// Story – the shipped flow (ui/feedback): the pointer presses the feedback cell (the computer's tooltip names the
// shortcut first) and the window freezes – the snapshot at 1:1 with the dock at its foot; it paints straight over the
// e-mail and the phone number; it holds the dock's mic and talks (listening, then the words come into the field); Send
// – the overlay goes and the status line says "Feedback sent · No. …"; then the end card. The Android app's tour
// (ANDROID_TOUR, owner 19.11.2026) has one chapter more before the end card: the top row's round icon left of the title
// is grabbed and pulled down and out – the to-do bubble comes out under the finger and stays where it is dropped.
// Owns: the scripts, their compiled tracks and stateAt. Never: timers, DOM or the live app.

import { dwellMs, planMotion, pressMs, type MotionStep, type Point } from '../../shared/model/pointer-motion.ts';
import { DESKTOP, PHONE, center, targetAt, type Layout, type TargetId, type Variant } from './scene-layout.ts';

export type Switch = 'tip' | 'frozen' | 'listen' | 'busy' | 'sent' | 'end' | 'handle' | 'out';

/** A switch at one moment: on or off, and how long ago it last changed (entry animations). */
export interface Toggle { on: boolean; age: number }
export interface Chapter { at: number; title: string }
export interface Caption { at: number; text: string }

export interface TourState {
  t: number;
  /** The cursor's tip, or the fingertip's centre. */
  pointer: Point;
  pressed: boolean;
  /** A press's ring at the pointer, `age` ms after it (shown for RIPPLE_MS). */
  ripple: { x: number; y: number; age: number } | null;
  hot: TargetId | null;
  /** The cell's tooltip, the frozen screen with its dock, the mic listening, the words on their way, the status
   *  line's "Feedback sent", the end card. */
  tip: Toggle; frozen: Toggle; listen: Toggle; busy: Toggle; sent: Toggle; end: Toggle;
  /** The Android tour's bubble chapter: the round icon in the top row, the bubble out – and where the bubble is. */
  handle: Toggle; out: Toggle;
  bubble: Point | null;
  /** Transcript words shown: 2.4 = two words and the third fading in. */
  words: number;
  /** Points of the tour's paintPath painted so far, and the pen's tip while it paints (scene units, 1:1). */
  paint: number;
  paintTip: Point | null;
  caption: string;
  chapter: number;
}

/** One variant's tour: its layout, length, chapters and captions, the pen's stroke, and the moment by moment state. */
export interface Tour {
  layout: Layout;
  /** The whole tour in ms (about 35 s). */
  duration: number;
  chapters: readonly Chapter[];
  captions: readonly Caption[];
  /** The painted stroke (the scene draws its first `paint` points) and when it starts and ends (ms). */
  paintPath: readonly Point[];
  paintSpan: { start: number; end: number };
  /** When a switch first turns on (ms; tests and the window check seek there), -1 never. */
  firstOn(name: Switch): number;
  clamp(t: number): number;
  /** Everything the scene shows at `t` ms (clamped to the tour). The same t always gives the same state. */
  stateAt(t: number): TourState;
}

export const TRANSCRIPT = 'The calendar stays empty after I connect Google.';
export const WORDS = TRANSCRIPT.split(' ');
export const WORD_MS = 190;
export const RIPPLE_MS = 480;
/** The computer cell's tooltip (ui/feedback/FeedbackButton.tsx tooltip()). */
export const CELL_TIP = 'Feedback – Ctrl+Shift+F, hold to talk';
/** The status line after Send (ui/feedback/delivery.ts sentText, with an example number of 8 characters). */
export const SENT_LINE = 'Feedback sent · No. 4F7K2Q9M';

const PACE = 1.3; // a little slower than a quick hand: people follow it
const PAINT_PACE = 1.7;

interface Move { start: number; end: number; from: Point; steps: MotionStep[] }

interface Script {
  moves: Move[];
  presses: Array<[number, number]>;
  rings: Array<{ at: number; x: number; y: number }>;
  switches: Record<Switch, Array<[number, boolean]>>;
  captions: Caption[];
  chapters: Chapter[];
  reveal: number;
  paint: { start: number; end: number; steps: Array<{ t: number; point: Point }> };
  /** The bubble follows the finger from start to end (the pull), then stays at `at`. */
  pull: { start: number; end: number; at: Point | null };
  duration: number;
}

function compile(layout: Layout, bubble: boolean): Script {
  const phone = layout.variant === 'phone';
  const s: Script = {
    moves: [], presses: [], rings: [], captions: [], chapters: [], reveal: 0,
    switches: { tip: [], frozen: [], listen: [], busy: [], sent: [], end: [], handle: [], out: [] },
    paint: { start: 0, end: 0, steps: [] },
    pull: { start: 0, end: 0, at: null },
    duration: 0,
  };
  let now = 0;
  let at = layout.start;
  let down = 0;
  const wait = (ms: number) => { now += ms; };
  const set = (name: Switch, on: boolean, delay = 0) => { s.switches[name].push([now + delay, on]); };
  const caption = (text: string) => { s.captions.push({ at: now, text }); };
  const chapter = (title: string) => { s.chapters.push({ at: now, title }); };
  const move = (to: Point, seed: number, options: { pace?: number; drag?: boolean; size?: number } = {}) => {
    const steps = planMotion(at, to, { style: 'human', seed, pace: options.pace ?? PACE, targetSize: options.size ?? 28, correct: !options.drag });
    const end = now + (steps.at(-1)?.t ?? 0);
    s.moves.push({ start: now, end, from: at, steps });
    now = end;
    at = to;
    return steps;
  };
  const press = () => { down = now; };
  const release = () => { s.presses.push([down, now]); };
  const ring = () => { s.rings.push({ at: now, ...at }); };
  /** Arrive, dwell, press and release like a hand (the press is held long enough to see); `down` and `up` happen then. */
  const click = (seed: number, then: { down?: () => void; up?: () => void }) => {
    wait(dwellMs('human', seed) + 60);
    press();
    then.down?.();
    wait(Math.max(110, pressMs('human', seed)));
    release();
    ring();
    then.up?.();
  };

  chapter('Press to freeze');
  wait(500);
  caption(phone ? 'Feedback is the megaphone, top right.' : 'Feedback sits top right, in every view.');
  wait(700);
  move(center(layout.cell), 11, { size: layout.cell.w });
  if (layout.tip) { set('tip', true, 300); wait(1700); } else wait(400);
  click(12, {
    down: () => { if (layout.tip) set('tip', false); },
    up: () => {
      set('frozen', true, 60); // the snapshot is there: the overlay shows it
      caption(phone ? 'One tap freezes the screen – a snapshot.' : 'One click freezes the window – a snapshot.');
    },
  });
  wait(2600);

  chapter('Paint');
  caption('Paint right on it – over anything private.');
  const [first, ...rest] = layout.paint;
  move(first!, 43, { size: 20 });
  wait(300);
  press();
  s.paint.start = now;
  s.paint.steps.push({ t: now, point: at });
  rest.forEach((point, index) => {
    const start = now;
    for (const step of move(point, 51 + index, { pace: PAINT_PACE, drag: true })) s.paint.steps.push({ t: start + step.t, point: { x: step.x, y: step.y } });
  });
  wait(120);
  release();
  s.paint.end = now;
  wait(700);
  caption('Only the painted picture is sent.');
  wait(1800);

  chapter('Talk or type');
  caption('Type below – or hold the mic and talk.');
  move(center(layout.mic), 21, { size: layout.mic.w });
  wait(dwellMs('human', 22) + 200);
  press();
  ring(); // the ring shows where the hold starts
  set('listen', true, 90);
  wait(1300);
  caption('Listening… let go when you are done.');
  wait(2000);
  release();
  set('listen', false);
  set('busy', true); // the words on their way
  wait(600);
  set('busy', false);
  s.reveal = now;
  caption('Your words land in the field.');
  wait(WORDS.length * WORD_MS + 1400);

  chapter('Send');
  caption('Then send – that’s all.');
  move(center(layout.send), 71);
  click(72, {
    up: () => {
      set('frozen', false);
      set('sent', true, 120);
      caption('The status line says it is sent.');
    },
  });
  wait(3200);
  if (bubble && layout.handle && layout.drop) {
    chapter('Bubble');
    set('handle', true);
    caption('Your bubble waits top left, beside the title.');
    wait(1500);
    const icon = center(layout.handle);
    move(icon, 81, { size: layout.handle.w });
    wait(dwellMs('human', 82) + 120);
    press();
    move({ x: icon.x + 4, y: layout.header + 18 }, 83, { drag: true, size: 20 }); // a little away: the pull starts
    s.pull.start = now;
    set('out', true);
    caption(layout.variant === 'desktop' ? 'Drag it out with your mouse, or click to bring it back.' : 'Pull it out – it follows your finger.');
    move(layout.drop, 84, { drag: true, size: 40 });
    wait(160);
    release();
    s.pull.end = now;
    s.pull.at = at;
    caption('Drop it anywhere. It stays over every app.');
    wait(2800);
  }
  set('end', true);
  caption('');
  wait(2600);
  s.duration = Math.round(now);
  return s;
}

/** Index of the last entry whose `at` (or first tuple item) is ≤ t, or -1. */
function lastAtOrBefore<T>(list: readonly T[], t: number, time: (item: T) => number): number {
  let low = 0, high = list.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (time(list[mid]!) <= t) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

function pointerAt(s: Script, layout: Layout, t: number): Point {
  const index = lastAtOrBefore(s.moves, t, (move) => move.start);
  if (index < 0) return layout.start;
  const move = s.moves[index]!;
  const last = move.steps.at(-1)!;
  if (t >= move.end) return { x: last.x, y: last.y };
  const local = t - move.start;
  const next = move.steps.findIndex((step) => step.t >= local);
  const b = move.steps[next]!;
  const a = next > 0 ? move.steps[next - 1]! : { ...move.from, t: 0 };
  const k = b.t === a.t ? 1 : (local - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function toggleAt(s: Script, name: Switch, t: number): Toggle {
  const list = s.switches[name];
  const index = lastAtOrBefore(list, t, (entry) => entry[0]);
  return index < 0 ? { on: false, age: t } : { on: list[index]![1], age: t - list[index]![0] };
}

function readState(s: Script, layout: Layout, t: number): TourState {
  const pointer = pointerAt(s, layout, t);
  const pressed = s.presses.some(([from, to]) => t >= from && t < to);
  const ringIndex = lastAtOrBefore(s.rings, t, (ring) => ring.at);
  const ring = ringIndex < 0 ? undefined : s.rings[ringIndex];
  const ripple = ring && t - ring.at < RIPPLE_MS ? { x: ring.x, y: ring.y, age: t - ring.at } : null;
  const frozen = toggleAt(s, 'frozen', t);
  const painting = t >= s.paint.start && t < s.paint.end;
  const paint = t < s.paint.start ? 0 : lastAtOrBefore(s.paint.steps, t, (step) => step.t) + 1;
  const captionIndex = lastAtOrBefore(s.captions, t, (entry) => entry.at);
  return {
    t,
    pointer,
    pressed,
    ripple,
    hot: targetAt(layout, pointer, frozen.on),
    tip: toggleAt(s, 'tip', t), frozen, listen: toggleAt(s, 'listen', t), busy: toggleAt(s, 'busy', t),
    sent: toggleAt(s, 'sent', t), end: toggleAt(s, 'end', t),
    handle: toggleAt(s, 'handle', t), out: toggleAt(s, 'out', t),
    bubble: s.pull.at && t >= s.pull.start ? (t < s.pull.end ? pointer : s.pull.at) : null,
    words: Math.min(WORDS.length, Math.max(0, (t - s.reveal) / WORD_MS)),
    paint,
    paintTip: painting ? pointer : null,
    caption: captionIndex < 0 ? '' : s.captions[captionIndex]!.text,
    chapter: Math.max(0, lastAtOrBefore(s.chapters, t, (entry) => entry.at)),
  };
}


function tourOf(layout: Layout, bubble = false): Tour {
  const s = compile(layout, bubble);
  const clamp = (t: number): number => Math.min(s.duration, Math.max(0, Number.isFinite(t) ? t : 0));
  return {
    layout,
    duration: s.duration,
    chapters: s.chapters,
    captions: s.captions,
    paintPath: s.paint.steps.map((step) => step.point),
    paintSpan: { start: s.paint.start, end: s.paint.end },
    firstOn: (name) => s.switches[name].find(([, on]) => on)?.[0] ?? -1,
    clamp,
    stateAt: (time) => readState(s, layout, clamp(time)),
  };
}

/** The computer's tour and the phone's: the same story, each in its own frame. */
export const TOURS: Readonly<Record<Variant, Tour>> = { desktop: tourOf(DESKTOP), phone: tourOf(PHONE) };

/** The Android app's tour (phone-page.tsx): the phone's, with the bubble chapter before the end card. */
export const ANDROID_TOUR: Tour = tourOf(PHONE, true);
export const DESKTOP_BUBBLE_TOUR: Tour = tourOf(DESKTOP, true);
