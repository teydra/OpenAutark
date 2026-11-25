// B-055 Q5, re-cut for the snapshot overlay (feedback 16.11.2026, F11/F15): the feedback tour's stage geometry, one
// layout per variant – the computer's window (960 × 600 scene units) and a phone's screen (360 × 760; F15: the same
// story before the Android app's pairing and once in the iPhone web app). The scene (Scene.tsx) is drawn at its layout's
// size and scaled to its box by the player, so every place the pointer aims at is a constant here – the timeline
// (timeline.ts) plans its paths to these rects and the scene draws its elements at them, so the pointer always lands on
// what it presses, whatever the window size. Each scene is an example app with the feedback cell where the real one
// sits (computer: right of the workspace cell, before the caption controls; phone: the last cell of a chat's top row).
// The frozen screen is the same example app at 1:1, as the live overlay shows its shot at its own pixels, so the pen
// paints in scene units; the dock lies over the bottom as the live one does (styles/feedback.css: three rows, the
// field's growth lifts only its top, so the mic and Send keep their places at its foot).
// Owns: sizes, rects, the private lines, the pen and the pointer's targets per variant. Never: timing (timeline.ts) or
// markup (Scene.tsx, AppMock.tsx); nothing here reads the live app.

import type { Point } from '../../shared/model/pointer-motion.ts';

export interface Rect { x: number; y: number; w: number; h: number }

/** The computer's window or a phone's screen. */
export type Variant = 'desktop' | 'phone';

/** The dock at the foot of the frozen screen (styles/feedback.css .feedback-dock): where it lies, its border on the
 *  sides and the bottom (the phone's has a top edge only), its paddings, the attachments row and the privacy line. */
export interface DockFrame { x: number; w: number; bottom: number; border: number; padX: number; padTop: number; padBottom: number; row: number; note: number }

export interface Layout {
  variant: Variant;
  w: number;
  h: number;
  /** The top row's height (the window's header row, the phone chat's row). */
  header: number;
  /** The feedback cell and the workspace cell left of it. */
  cell: Rect;
  workspace: Rect;
  /** The cell's tooltip under it (the computer only: a finger has no hover). */
  tip: Rect | null;
  /** "Mira is typing": it moves while the app runs and stands still on the frozen screen. */
  typing: Rect;
  /** The contact card and its private lines, the e-mail and the phone number (the frozen screen is 1:1). */
  card: Rect;
  email: Rect;
  phone: Rect;
  /** The pen's stroke corners: along the e-mail, back along the phone number (one stroke). */
  paint: readonly Point[];
  dock: DockFrame;
  /** The dock's main row at its foot: the close arrow, the mic inside the field, Send. */
  close: Rect;
  mic: Rect;
  send: Rect;
  /** The status line's note after Send. */
  status: Rect;
  /** Where the pointer rests on the poster, and its size (the cursor's height, the fingertip's width). */
  start: Point;
  pointer: number;
  /** The Android app's bubble chapter (owner 19.11.2026): the to-do bubble's round icon left of the top row's title,
   *  and where the pull drops the bubble; null where there is no bubble. */
  handle: Rect | null;
  drop: Point | null;
}

/** The computer's frame: the rail, the chat sidebar and where the main sheet starts; the caption controls' width. */
export const RAIL_W = 52;
export const SIDEBAR_W = 210;
export const SHEET_X = RAIL_W + SIDEBAR_W;
export const CAPTION_W = 138;
/** The pen's width in scene units (opaque, round ends). */
export const PEN = 24;

/** The dock's main row: the close arrow (36 × 38), the field (one line: 38 high, the mic 30 × 30 inside at 4 from its
 *  right and bottom, past its 1 px border), Send (96 × 38), 8 apart; the privacy line and the paddings under it. */
function dockRow(dock: DockFrame, sceneH: number): Pick<Layout, 'close' | 'mic' | 'send'> {
  const foot = sceneH - dock.bottom - dock.border - dock.padBottom - dock.note - 8;
  const right = dock.x + dock.w - dock.border - dock.padX;
  const send = { x: right - 96, y: foot - 38, w: 96, h: 38 };
  return {
    close: { x: dock.x + dock.border + dock.padX, y: foot - 38, w: 36, h: 38 },
    mic: { x: send.x - 8 - 1 - 4 - 30, y: foot - 1 - 4 - 30, w: 30, h: 30 },
    send,
  };
}

const DESKTOP_CELL: Rect = { x: 960 - CAPTION_W - 12 - 32, y: 8, w: 32, h: 32 };
const DESKTOP_DOCK: DockFrame = { x: 100, w: 760, bottom: 12, border: 1, padX: 12, padTop: 10, padBottom: 8, row: 32, note: 16 };

/** The computer's window: rail, sidebar, a chat; the cell before the caption controls; the dock 760 wide, 12 above the foot. */
export const DESKTOP: Layout = {
  variant: 'desktop', w: 960, h: 600, header: 48,
  cell: DESKTOP_CELL,
  workspace: { x: DESKTOP_CELL.x - 4 - 32, y: 8, w: 32, h: 32 },
  tip: { x: DESKTOP_CELL.x + 16 - 6 - 260, y: 46, w: 260, h: 26 },
  typing: { x: 363, y: 436, w: 52, h: 26 },
  card: { x: 363, y: 186, w: 260, h: 73 },
  email: { x: 377, y: 213, w: 150, h: 19 },
  phone: { x: 377, y: 232, w: 104, h: 19 },
  paint: [{ x: 371, y: 222 }, { x: 452, y: 223 }, { x: 532, y: 222 }, { x: 488, y: 241 }, { x: 430, y: 242 }, { x: 371, y: 241 }],
  dock: DESKTOP_DOCK,
  ...dockRow(DESKTOP_DOCK, 600),
  status: { x: 960 - 12 - 236, y: 48 + 8, w: 236, h: 32 },
  start: { x: 612, y: 440 },
  pointer: 52,
  handle: { x: RAIL_W + 12, y: 7, w: 34, h: 34 },
  drop: { x: RAIL_W + SIDEBAR_W + 60, y: 130 },
};

const PHONE_DOCK: DockFrame = { x: 0, w: 360, bottom: 0, border: 0, padX: 12, padTop: 10, padBottom: 20, row: 40, note: 32 };

/** A phone's screen: a chat under its top row (back, the chat, the workspace and feedback cells); the dock is the
 *  bottom edge, full width, above the gesture bar (styles/feedback.css under 720 px). */
export const PHONE: Layout = {
  variant: 'phone', w: 360, h: 760, header: 56,
  cell: { x: 312, y: 8, w: 40, h: 40 },
  workspace: { x: 268, y: 8, w: 40, h: 40 },
  tip: null,
  typing: { x: 44, y: 484, w: 52, h: 26 },
  card: { x: 44, y: 226, w: 260, h: 73 },
  email: { x: 58, y: 253, w: 150, h: 19 },
  phone: { x: 58, y: 272, w: 104, h: 19 },
  paint: [{ x: 52, y: 262 }, { x: 133, y: 263 }, { x: 213, y: 262 }, { x: 169, y: 281 }, { x: 111, y: 282 }, { x: 52, y: 281 }],
  dock: PHONE_DOCK,
  ...dockRow(PHONE_DOCK, 760),
  status: { x: 12, y: 56 + 8, w: 336, h: 32 },
  start: { x: 236, y: 560 },
  pointer: 44,
  handle: { x: 8, y: 12, w: 32, h: 32 },
  drop: { x: 300, y: 420 },
};

export const center = (rect: Rect): Point => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
export const inside = (point: Point, rect: Rect, slack = 0): boolean =>
  point.x >= rect.x - slack && point.x <= rect.x + rect.w + slack && point.y >= rect.y - slack && point.y <= rect.y + rect.h + slack;

export type TargetId = 'feedback' | 'workspace' | 'close' | 'mic' | 'send';

/** What the pointer is over (its hover look in the scene): the cell – also over the frozen screen, where the overlay
 *  draws it at its spot –, the workspace cell while the app runs, the dock's parts while it is frozen. */
export function targetAt(layout: Layout, point: Point, frozen: boolean): TargetId | null {
  if (inside(point, layout.cell)) return 'feedback';
  if (!frozen) return inside(point, layout.workspace) ? 'workspace' : null;
  for (const id of ['close', 'mic', 'send'] as const) if (inside(point, layout[id])) return id;
  return null;
}
