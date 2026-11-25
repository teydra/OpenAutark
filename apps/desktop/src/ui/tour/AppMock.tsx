// B-055 Q5: the tour's example app – a filled stand-in for the real window or phone screen, drawn from the CSS tokens
// only (it follows light and dark) and from no live component, store or call, so rebuilding the live UI never breaks
// it and it never touches live data. The computer: rail, the chat sidebar with a few example chats, the header row
// with the feedback cell where the real one sits (right of the workspace cell, before the caption controls) and one
// example chat. The phone (feedback 16.11.2026, F15): the same chat full screen under its top row, whose last cell is
// the feedback cell. The chat's contact card shows private details (an e-mail and a phone number) and its calendar
// card the problem the person reports (the calendar stays empty). The Android tour's bubble chapter (owner 19.11.2026)
// shows the phone's list row instead: the to-do bubble's round icon left of the title "Chats" (AutarkDot, the bubble's
// own look: the dark round dot with the white Autark mark). The same drawing is the frozen screen (the snapshot
// at 1:1, Scene.tsx). Everything is placed in scene units (scene-layout.ts); the player scales the whole scene.
// Example content by design (B-055 §4: the tour scene is explicitly example content).
// Owns: this drawing and its cells. Never: state, timing or anything of the live app.

import { memo } from 'preact/compat';
import { TourIcon, type TourIconName } from './icons.tsx';
import { CAPTION_W, RAIL_W, SHEET_X, SIDEBAR_W, type Layout, type Rect } from './scene-layout.ts';

/** Absolute placement of a rect (scene units). */
export const place = (rect: Rect) => ({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });

/** The feedback cell's look: idle, under the pointer, pressed, or open (the overlay shows). */
export type CellLook = 'idle' | 'hot' | 'down' | 'open';

const CHATS: ReadonlyArray<{ title: string; time: string; av: number }> = [
  { title: 'Sales calls', time: '10:42', av: 1 },
  { title: 'Website launch', time: '09:15', av: 3 },
  { title: 'October invoices', time: 'Mon', av: 2 },
  { title: 'Hiring: designer', time: 'Mon', av: 4 },
  { title: 'Weekly report', time: 'Fri', av: 5 },
  { title: 'Supplier quotes', time: 'Thu', av: 0 },
];
const RAIL: ReadonlyArray<{ icon: TourIconName; y: number; on?: boolean }> = [
  { icon: 'tasks', y: 60 }, { icon: 'chat', y: 100, on: true }, { icon: 'users', y: 140 }, // the real rail: Tasks · Chats · Team
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

export function Cell(props: { rect: Rect; icon: TourIconName; look?: CellLook; class?: string }) {
  return (
    <span class={`tour-cell look-${props.look ?? 'idle'}${props.class ? ` ${props.class}` : ''}`} style={place(props.rect)}>
      <TourIcon name={props.icon} size={props.rect.w > 36 ? 20 : 18} />
    </span>
  );
}

function DesktopFrame(props: { layout: Layout; cell: CellLook; handle?: 'idle' | 'out' }) {
  const { layout } = props;
  return (
    <>
      {props.handle && layout.handle ? <>
        <AutarkDot rect={layout.handle} faint={props.handle === 'out'} />
        <Cell rect={{ x: SHEET_X - 78, y: 8, w: 32, h: 32 }} icon="sidebar" />
      </> : <Cell rect={{ x: 10, y: 8, w: 32, h: 32 }} icon="sidebar" />}
      {RAIL.map((item) => <Cell key={item.icon} rect={{ x: 10, y: item.y, w: 32, h: 32 }} icon={item.icon} look={item.on ? 'open' : 'idle'} />)}
      <Cell rect={{ x: 10, y: layout.h - 48, w: 32, h: 32 }} icon="gear" />
      <span class="tour-side-title" style={{ left: `${RAIL_W + (props.handle ? 56 : 12)}px`, top: '12px' }}>Chats</span>
      <Cell rect={{ x: RAIL_W + SIDEBAR_W - 42, y: 8, w: 32, h: 32 }} icon="plus" />
      {CHATS.map((chat, index) => (
        <span key={chat.title} class={`tour-chat-row${index === 0 ? ' current' : ''}`} style={place({ x: RAIL_W + 8, y: 56 + index * 40, w: SIDEBAR_W - 16, h: 36 })}>
          <span class={`tour-av av-${chat.av}`}>{chat.title[0]}</span>
          <span class="tour-chat-title">{chat.title}</span>
          <span class="tour-chat-time">{chat.time}</span>
        </span>
      ))}
      <span class="tour-av av-1 tour-head-av" style={{ left: `${SHEET_X + 16}px`, top: '13px' }}>M</span>
      <span class="tour-head-title" style={{ left: `${SHEET_X + 46}px`, top: '14px' }}>Sales calls</span>
      <Cell rect={layout.cell} icon="megaphone" look={props.cell} class="tour-feedback-cell" />
      <Cell rect={layout.workspace} icon="browsers" />
      <span class="tour-caption-controls" style={place({ x: layout.w - CAPTION_W, y: 0, w: CAPTION_W, h: 32 })}>
        <TourIcon name="minus" size={12} /><TourIcon name="square" size={11} /><TourIcon name="x" size={13} />
      </span>
    </>
  );
}

/** The to-do bubble's look – the round icon in the top row and the bubble itself: a dark round dot, the white mark. */
export function AutarkDot(props: { rect: Rect; faint?: boolean }) {
  return (
    <span style={{ ...place(props.rect), position: 'absolute', borderRadius: '50%', background: 'rgba(32, 36, 34, 0.68)', display: 'grid', placeItems: 'center', opacity: props.faint ? 0.35 : 1 }}>
      <svg width={props.rect.w / 2} height={props.rect.w / 2} viewBox="0 0 512 512" aria-hidden="true">
        <path fill="#fff" d="M216,43 L296,43 L480,468 L396,468 L256,138 L116,468 L32,468 Z" />
        <path fill="#fff" d="M208,351 a48,48 0 1,0 96,0 a48,48 0 1,0 -96,0 Z" />
      </svg>
    </span>
  );
}

/** The phone chat's top row: back, the chat, then its cells – the workspace and, last, feedback; with `handle` the list
 *  row instead: the bubble's round icon (faint while the bubble is out) and "Chats". */
function PhoneFrame(props: { layout: Layout; cell: CellLook; handle?: 'idle' | 'out' }) {
  const { layout } = props;
  return (
    <>
      {props.handle && layout.handle ? (
        <>
          <AutarkDot rect={layout.handle} faint={props.handle === 'out'} />
          <span class="tour-head-title" style={{ left: '52px', top: '18px' }}>Chats</span>
        </>
      ) : (
        <>
          <Cell rect={{ x: 4, y: 8, w: 40, h: 40 }} icon="caret-left" />
          <span class="tour-av av-1 tour-head-av" style={{ left: '48px', top: '17px' }}>M</span>
          <span class="tour-head-title" style={{ left: '78px', top: '18px' }}>Sales calls</span>
        </>
      )}
      <Cell rect={layout.workspace} icon="browsers" />
      <Cell rect={layout.cell} icon="megaphone" look={props.cell} class="tour-feedback-cell" />
    </>
  );
}

/** The contact card with its private lines (where the layout puts them). */
function Card(props: { layout: Layout }) {
  const { card, email, phone } = props.layout;
  return (
    <span class="tour-card" style={place(card)}>
      <span class="tour-card-line strong" style={{ top: `${email.y - card.y - 20}px` }}>Anna Meyer</span>
      <span class="tour-card-line tour-private" data-private="email" style={{ top: `${email.y - card.y - 1}px` }}>anna.meyer@example.com</span>
      <span class="tour-card-line tour-private" data-private="phone" style={{ top: `${phone.y - card.y - 1}px` }}>+43 660 1234567</span>
    </span>
  );
}

function Calendar(props: { rect: Rect }) {
  return (
    <span class="tour-calendar" style={place(props.rect)}>
      <span class="tour-calendar-head"><span class="tour-dot" />Google Calendar <span class="tour-muted">Connected</span></span>
      <span class="tour-calendar-days">
        {DAYS.map((day) => <span key={day} class="tour-calendar-day"><span class="tour-muted">{day}</span></span>)}
      </span>
      <span class="tour-calendar-empty">No events this week</span>
    </span>
  );
}

function Composer(props: { rect: Rect }) {
  return (
    <span class="tour-composer" style={place(props.rect)}>
      <span class="tour-muted tour-composer-text">Message Mira</span>
      <TourIcon name="plus" size={18} class="tour-composer-plus" />
      <TourIcon name="microphone" size={18} class="tour-composer-mic" />
      <span class="tour-composer-send"><TourIcon name="arrow-up" size={16} /></span>
    </span>
  );
}

function DesktopChat(props: { layout: Layout }) {
  return (
    <>
      <span class="tour-bubble" style={{ right: `${props.layout.w - 891}px`, top: '72px' }}>Can you book a call with Anna next week?</span>
      <span class="tour-av av-1 tour-msg-av" style={{ left: '331px', top: '128px' }}>M</span>
      <span class="tour-msg-name" style={{ left: '363px', top: '128px' }}>Mira <span class="tour-msg-time">10:42</span></span>
      <span class="tour-msg-text" style={{ left: '363px', top: '154px' }}>Booked for Tuesday at 10:00. Here is her contact:</span>
      <Card layout={props.layout} />
      <span class="tour-msg-text" style={{ left: '363px', top: '274px' }}>It is in your Google Calendar too.</span>
      <Calendar rect={{ x: 363, y: 306, w: 440, h: 118 }} />
      <Composer rect={{ x: 331, y: 512, w: 560, h: 68 }} />
    </>
  );
}

/** The same chat on a phone: the lines wrap at its width, the composer at the foot (the dock covers it when frozen). */
function PhoneChat(props: { layout: Layout }) {
  return (
    <>
      <span class="tour-bubble tour-wrap" style={{ right: '12px', top: '68px', width: '232px' }}>Can you book a call with Anna next week?</span>
      <span class="tour-av av-1 tour-msg-av" style={{ left: '12px', top: '144px' }}>M</span>
      <span class="tour-msg-name" style={{ left: '44px', top: '144px' }}>Mira <span class="tour-msg-time">10:42</span></span>
      <span class="tour-msg-text tour-wrap" style={{ left: '44px', top: '170px', width: '300px' }}>Booked for Tuesday at 10:00. Here is her contact:</span>
      <Card layout={props.layout} />
      <span class="tour-msg-text" style={{ left: '44px', top: '310px' }}>It is in your Google Calendar too.</span>
      <Calendar rect={{ x: 44, y: 342, w: 304, h: 118 }} />
      <Composer rect={{ x: 12, y: 680, w: 336, h: 64 }} />
    </>
  );
}

/** The example app in its variant, `cell` the feedback cell's look (the frozen screen draws it idle). */
export const AppMock = memo(function AppMock(props: { layout: Layout; cell: CellLook; handle?: 'idle' | 'out' }) {
  const { layout } = props;
  return (
    <div class={`tour-app ${layout.variant}`}>
      {layout.variant === 'phone' ? (
        <>
          <PhoneFrame layout={layout} cell={props.cell} handle={props.handle} />
          <PhoneChat layout={layout} />
        </>
      ) : (
        <>
          <span class="tour-sheet" style={place({ x: SHEET_X, y: layout.header, w: layout.w - SHEET_X, h: layout.h - layout.header })} />
          <DesktopFrame layout={layout} cell={props.cell} handle={props.handle} />
          <DesktopChat layout={layout} />
        </>
      )}
    </div>
  );
});
