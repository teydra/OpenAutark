// B-055 Q5, re-cut 16.11.2026 for the snapshot overlay (F11/F15): the feedback tour's pure timeline
// (src/ui/tour/timeline.ts) for both variants – the computer's window and a phone's screen: about 35 s in four
// chapters, time clamped and seekable (the same t always gives the same state, in any order), the shipped flow in its
// order (the computer's cell names its shortcut, a press freezes the screen with the dock at its foot, the pen paints
// over the e-mail and the phone number on the frozen screen, a hold on the dock's mic listens and the words come into
// the field, Send closes the overlay and the status line says "Feedback sent", the end card), the pointer on the
// element it presses at every press, a hand-like path that never jumps, and each layout's targets in their frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANDROID_TOUR, DESKTOP_BUBBLE_TOUR, CELL_TIP, RIPPLE_MS, SENT_LINE, TOURS, WORDS, type Tour } from '../../../src/ui/tour/timeline.ts';
import { DESKTOP, PEN, PHONE, center, inside, type Layout, type Rect, type Variant } from '../../../src/ui/tour/scene-layout.ts';
import type { Point } from '../../../src/shared/model/pointer-motion.ts';

/** Where the dock's top is while its field holds one line (it grows upward from there). */
const dockTop = (layout: Layout) => layout.send.y + layout.send.h - 38 - 8 - layout.dock.row - layout.dock.padTop - 1;
const FRAME = 1000 / 60;
const VARIANTS: Variant[] = ['desktop', 'phone'];
const frames = (tour: Tour, from = 0, to = tour.duration) => { const out: number[] = []; for (let t = from; t <= to; t += FRAME) out.push(t); return out; };

for (const variant of VARIANTS) {
  const tour = TOURS[variant];
  const { layout } = tour;

  test(`${variant}: about half a minute in four chapters in order; captions short and in order`, () => {
    assert.ok(tour.duration >= 24_000 && tour.duration <= 45_000, `duration ${tour.duration} ms`);
    assert.deepEqual(tour.chapters.map((chapter) => chapter.title), ['Press to freeze', 'Paint', 'Talk or type', 'Send']);
    assert.equal(tour.chapters[0]!.at, 0);
    for (let i = 1; i < tour.chapters.length; i += 1) assert.ok(tour.chapters[i]!.at > tour.chapters[i - 1]!.at + 2000, `chapter ${i} starts after the one before`);
    assert.ok(tour.chapters.at(-1)!.at < tour.duration);
    for (let i = 1; i < tour.captions.length; i += 1) assert.ok(tour.captions[i]!.at >= tour.captions[i - 1]!.at);
    for (const caption of tour.captions) assert.ok(caption.text.length <= 60 && !/[äöüß]/i.test(caption.text), `short English caption: ${caption.text}`);
    assert.equal(tour.captions.at(-1)!.text, '', 'the end card speaks for itself');
  });

  test(`${variant}: time is clamped and monotonic; stateAt is deterministic and order-free (seekable)`, () => {
    assert.equal(tour.stateAt(-500).t, 0);
    assert.equal(tour.stateAt(Number.NaN).t, 0);
    assert.equal(tour.stateAt(tour.duration * 3).t, tour.duration);
    assert.equal(tour.clamp(1234.5), 1234.5);
    let last = -1;
    for (const t of frames(tour)) { const now = tour.stateAt(t).t; assert.ok(now >= last); last = now; }
    const times = [0, 1, 2605, 7158.3, 11_000, 15_100, 18_100, 21_000.7, 24_100, 27_500, tour.duration - 1, tour.duration];
    const forward = times.map((t) => tour.stateAt(t));
    const shuffled = [...times].reverse().map((t) => tour.stateAt(t)).reverse();
    assert.deepEqual(shuffled, forward, 'seeking backwards gives the same pictures');
    assert.deepEqual(tour.stateAt(21_000), tour.stateAt(21_000));
  });

  test(`${variant}: the poster – the pointer rests in the chat, nothing on, nothing painted`, () => {
    const s = tour.stateAt(0);
    assert.deepEqual(s.pointer, layout.start);
    for (const [name, value] of Object.entries(s)) if (value && typeof value === 'object' && 'on' in value) assert.equal(value.on, false, name);
    assert.equal(s.words, 0);
    assert.equal(s.paint, 0);
    assert.equal(s.pressed, false);
    assert.equal(s.chapter, 0);
  });

  test(`${variant}: the shipped flow in order – press, frozen with the dock, hold the mic, the words, Send, the status line`, () => {
    const order = ['frozen', 'listen', 'busy', 'sent', 'end'] as const;
    for (let i = 1; i < order.length; i += 1) assert.ok(tour.firstOn(order[i]!) > tour.firstOn(order[i - 1]!), `${order[i]} after ${order[i - 1]}`);
    // the press on the cell freezes the screen (the computer's tooltip names the shortcut first and goes at the press)
    const frozen = tour.firstOn('frozen');
    assert.equal(tour.stateAt(frozen - 1).hot, 'feedback', 'the pointer is on the cell when the screen freezes');
    if (layout.tip) {
      assert.ok(tour.firstOn('tip') > 0 && tour.firstOn('tip') < frozen, 'the tooltip before the press');
      assert.equal(tour.stateAt(tour.firstOn('tip') + 50).hot, 'feedback');
      const pressing = frames(tour, tour.firstOn('tip'), frozen).find((t) => tour.stateAt(t).pressed)!;
      assert.equal(tour.stateAt(pressing).tip.on, false, 'the press hides the tooltip');
    } else {
      assert.equal(tour.firstOn('tip'), -1, 'a finger has no hover');
    }
    for (const t of frames(tour, frozen + 1, tour.firstOn('sent') - 200)) assert.equal(tour.stateAt(t).frozen.on, true, `frozen until Send (${Math.round(t)})`);
    // the hold on the dock's mic listens; letting go brings the words, one by one
    const holding = tour.stateAt(tour.firstOn('listen') + 500);
    assert.equal(holding.pressed, true, 'held down');
    assert.equal(holding.hot, 'mic');
    assert.equal(holding.listen.on, true);
    const released = tour.stateAt(tour.firstOn('busy'));
    assert.equal(released.pressed, false);
    assert.equal(released.listen.on, false);
    assert.equal(released.words, 0, 'the words come after the transcription');
    let words = 0;
    for (const t of frames(tour, tour.firstOn('busy'), tour.firstOn('sent'))) { const now = tour.stateAt(t).words; assert.ok(now >= words); words = now; }
    assert.equal(words, WORDS.length, 'the whole transcript is in before Send');
    assert.ok(frames(tour, tour.firstOn('busy'), tour.firstOn('sent')).some((t) => { const w = tour.stateAt(t).words; return w > 2 && w < 6; }), 'word by word, not at once');
    // Send: the overlay goes, the status line says it
    const sent = tour.stateAt(tour.firstOn('sent'));
    assert.ok(inside(sent.pointer, layout.send), 'Send was pressed');
    assert.equal(sent.frozen.on, false, 'the overlay closed at once');
    assert.match(SENT_LINE, /^Feedback sent · No\. [0-9A-Z]{8}$/, 'the status line as ui/feedback/delivery.ts writes it');
  });
}

test('the computer cell\'s tooltip is the live one\'s', () => {
  assert.equal(CELL_TIP, 'Feedback – Ctrl+Shift+F, hold to talk');
});

/** Shortest distance from `point` to the polyline. */
function distance(point: Point, path: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!, b = path[i]!;
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const k = length ? Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
    best = Math.min(best, Math.hypot(point.x - a.x - k * dx, point.y - a.y - k * dy));
  }
  return best;
}

for (const variant of VARIANTS) {
  const tour = TOURS[variant];
  const { layout } = tour;

  test(`${variant}: the pen paints on the frozen screen along the pointer – and covers the e-mail and the phone number`, () => {
    const span = tour.paintSpan;
    assert.equal(tour.stateAt(span.start - 1).paint, 0, 'nothing before the press');
    let count = 0;
    for (const t of frames(tour, span.start + 1, span.end - 1)) {
      const s = tour.stateAt(t);
      assert.ok(s.pressed && s.frozen.on && s.paintTip, `pressed on the frozen screen at ${t}`);
      assert.deepEqual(s.paintTip, s.pointer, 'the pen is at the pointer (the frozen screen is 1:1)');
      assert.ok(s.paint >= count);
      count = s.paint;
    }
    assert.equal(tour.stateAt(span.end).paint, tour.paintPath.length, 'the whole stroke once released');
    assert.equal(tour.stateAt(span.end).paintTip, null);
    assert.equal(tour.stateAt(tour.firstOn('sent') - 200).paint, tour.paintPath.length, 'the marks stay until Send');
    for (const rect of [layout.email, layout.phone]) {
      assert.ok(rect.y + rect.h < dockTop(layout) && rect.y > layout.header, 'the private lines lie between the top row and the dock');
      for (let x = rect.x; x <= rect.x + rect.w; x += 2) {
        for (let y = rect.y + 2; y <= rect.y + rect.h - 2; y += 1) {
          assert.ok(distance({ x, y }, tour.paintPath) <= PEN / 2, `(${x}, ${y}) is under the black stroke`);
        }
      }
    }
  });

  test(`${variant}: every press lands on its element; the end card`, () => {
    let presses = 0;
    for (const t of frames(tour)) {
      const s = tour.stateAt(t);
      if (s.ripple && s.ripple.age < FRAME) {
        presses += 1;
        assert.ok(s.ripple.age < RIPPLE_MS);
        // just before the press ends, while what it opens or closes has not changed yet
        assert.ok(tour.stateAt(t - s.ripple.age - 1).hot !== null, `the press at ${Math.round(t - s.ripple.age)} lands on an element`);
      }
    }
    assert.equal(presses, 3, 'the cell, the mic, Send');
    const end = tour.stateAt(tour.duration);
    assert.equal(end.end.on, true);
    assert.equal(end.frozen.on, false);
    assert.equal(end.sent.on, true, 'the status line still says it under the end card');
    assert.equal(end.words, WORDS.length);
    assert.equal(end.caption, '');
    assert.equal(end.chapter, tour.chapters.length - 1);
    assert.equal(tour.stateAt(tour.firstOn('end') - 1).end.on, false);
  });

  test(`${variant}: the pointer moves like a hand – inside the scene, never a jump between two frames, a visible glide to the cell`, () => {
    let previous = tour.stateAt(0).pointer;
    let longest = 0;
    for (const t of frames(tour)) {
      const { pointer } = tour.stateAt(t);
      assert.ok(pointer.x >= 0 && pointer.x <= layout.w && pointer.y >= 0 && pointer.y <= layout.h, `inside the scene at ${t}`);
      longest = Math.max(longest, Math.hypot(pointer.x - previous.x, pointer.y - previous.y));
      previous = pointer;
    }
    assert.ok(longest < 40, `at most ${longest.toFixed(1)} units per frame`);
    const reach = frames(tour, 0, tour.firstOn('frozen')).find((t) => inside(tour.stateAt(t).pointer, layout.cell))!;
    assert.ok(reach > 1500, `the first glide takes its time (on the cell at ${Math.round(reach)} ms)`);
  });
}

/** Whether `a` and `b` overlap. */
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const within = (rect: Rect, layout: Layout) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= layout.w && rect.y + rect.h <= layout.h;

test('each layout: the cell in its top row, the dock\'s targets at its foot side by side, the status line under the top row', () => {
  for (const layout of [DESKTOP, PHONE]) {
    const name = layout.variant;
    for (const rect of [layout.cell, layout.workspace, layout.close, layout.mic, layout.send, layout.status, layout.card, layout.typing]) assert.ok(within(rect, layout), `${name}: inside the frame`);
    assert.ok(layout.cell.y + layout.cell.h <= layout.header && layout.workspace.x + layout.workspace.w <= layout.cell.x, `${name}: the cell is the top row's last cell`);
    assert.ok(layout.close.x + layout.close.w < layout.mic.x && layout.mic.x + layout.mic.w < layout.send.x, `${name}: close | field with the mic | Send`);
    assert.equal(layout.mic.y + layout.mic.h + 5, layout.send.y + layout.send.h, `${name}: the mic sits at the field's foot, Send beside it`);
    assert.ok(dockTop(layout) < layout.send.y && dockTop(layout) > layout.typing.y, `${name}: the dock covers the composer, not the chat above it`);
    assert.ok(layout.status.y >= layout.header && !overlap(layout.status, layout.cell), `${name}: the status line under the top row`);
    assert.ok(layout.paint.every((point) => point.y > layout.header && point.y < dockTop(layout)), `${name}: the stroke stays on the visible screen`);
  }
  assert.ok(DESKTOP.tip && DESKTOP.tip.x + DESKTOP.tip.w <= center(DESKTOP.cell).x && DESKTOP.tip.y >= DESKTOP.cell.y + DESKTOP.cell.h, 'the computer\'s tooltip under the cell, left of the cursor\'s tip');
  assert.equal(PHONE.tip, null);
  assert.ok(PHONE.dock.x === 0 && PHONE.dock.w === PHONE.w && PHONE.dock.bottom === 0, 'the phone\'s dock is the bottom edge');
  assert.ok(PHONE.mic.w >= 30 && PHONE.send.h >= 38, 'finger-sized targets as the live dock\'s');
});

test('the Android tour: the phone\'s story, then the bubble chapter – the top row\'s round icon pulled out becomes the bubble', () => {
  const tour = ANDROID_TOUR;
  const { layout } = tour;
  assert.deepEqual(tour.chapters.map((chapter) => chapter.title), ['Press to freeze', 'Paint', 'Talk or type', 'Send', 'Bubble']);
  assert.ok(tour.duration > TOURS.phone.duration && tour.duration <= 45_000, `duration ${tour.duration} ms`);
  for (const caption of tour.captions) assert.ok(caption.text.length <= 60 && !/[äöüß]/i.test(caption.text), `short English caption: ${caption.text}`);
  assert.equal(TOURS.phone.firstOn('handle'), -1, 'the iPhone web app\'s tour has no bubble');
  assert.equal(TOURS.desktop.firstOn('out'), -1);
  const handle = tour.firstOn('handle');
  const out = tour.firstOn('out');
  assert.ok(handle > tour.firstOn('sent') && out > handle && out < tour.firstOn('end'), 'after Send, before the end card');
  assert.equal(tour.stateAt(out - 1).bubble, null, 'no bubble before the pull');
  const grab = frames(tour, handle, out).find((t) => tour.stateAt(t).pressed)!;
  assert.ok(inside(tour.stateAt(grab).pointer, layout.handle!), 'the finger grabs the round icon');
  assert.ok(tour.stateAt(out - 1).pressed, 'and pulls it a little away before the bubble comes');
  let previous = tour.stateAt(out).bubble!;
  for (const t of frames(tour, out, tour.duration)) {
    const s = tour.stateAt(t);
    assert.ok(s.bubble, `the bubble stays out (${Math.round(t)})`);
    if (s.pressed) assert.deepEqual(s.bubble, s.pointer, 'it follows the finger while pulled');
    assert.ok(Math.hypot(s.bubble.x - previous.x, s.bubble.y - previous.y) < 40, 'it never jumps');
    previous = s.bubble;
  }
  const end = tour.stateAt(tour.duration);
  assert.deepEqual(end.bubble, layout.drop, 'it stays where it was dropped');
  assert.equal(end.handle.on && end.out.on, true, 'the icon stays in the row, faint');
  assert.ok(layout.drop!.y > layout.header && layout.drop!.y < layout.h, 'dropped on the screen');
});

test('the desktop bubble tour moves the handle to the drop point and keeps it there', () => {
  const tour = DESKTOP_BUBBLE_TOUR;
  assert.ok(tour.chapters.some(chapter => chapter.title === 'Bubble'));
  assert.ok(tour.firstOn('out') > tour.firstOn('handle'));
  const end = tour.stateAt(tour.duration);
  assert.deepEqual(end.bubble, tour.layout.drop);
  assert.ok(tour.captions.some(caption => caption.text.includes('mouse')));
});
