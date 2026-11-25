// B-055 Q5: the feedback tour's player – a "video" made of code. A poster frame (the filled example
// scene) with a big Play button, so people see it is a video; then the timeline (timeline.ts) runs on
// requestAnimationFrame only while playing – nothing runs while paused, ended or hidden (a hidden window
// pauses it and resumes it when shown again). Controls in one fixed bar that never shifts: play/pause,
// back/forward 5 s, the time, a scrubber with chapter ticks (click or drag to seek; the scene follows
// live), keys Space/K, ←/→, Home/End; × top right, and at the end a card with "Continue" and "Watch again".
// The scene keeps its aspect and is scaled to fit its box (CSS transform), at every window size from 640×480
// to phone width. Feedback 16.11.2026 (F15): `variant` picks the computer's or the phone's tour (timeline.ts TOURS).
// Used by the replay dialog (TourDialog.tsx), opened from the palette, Settings › Feedback, the first run's choice card
// ("Watch how it works") and once by the iPhone web app after its pairing; it starts at its poster on every opening –
// B-090: playing at once when opened by "Set up a new company" (`autoplay`). And by the Android app's own page before
// its pairing (phone-page.tsx): playing at once, Skip in place of ×, and a `note` on the end card; `bubble` plays the
// Android app's tour (timeline.ts ANDROID_TOUR: the phone's with the bubble chapter, owner 19.11.2026).
// Owns: playback state, the controls and the scene's fit. Never: the story (timeline.ts), the drawing
// (Scene.tsx) or what Continue leads to (the caller's onDone).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { TourIcon } from './icons.tsx';
import { fitScale, formatTime, keyAction, nextTime, stepTime, timeAt } from './player-model.ts';
import { Scene } from './Scene.tsx';
import type { Variant } from './scene-layout.ts';
import { ANDROID_TOUR, DESKTOP_BUBBLE_TOUR, TOURS } from './timeline.ts';

export const TOUR_TITLE = 'How to send feedback';
export const END_TEXT = 'Only the Teydra team can read your feedback – it is encrypted on your PC.';

export function TourPlayer(props: { onDone: () => void; autoplay?: boolean; variant?: Variant; skip?: boolean; note?: string; bubble?: boolean; desktopBubble?: boolean }) {
  const tour = props.bubble ? ANDROID_TOUR : props.desktopBubble ? DESKTOP_BUBBLE_TOUR : TOURS[props.variant ?? 'desktop'];
  const { duration, chapters, clamp, layout } = tour;
  const percent = (at: number) => `${((at / duration) * 100).toFixed(3)}%`;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(Boolean(props.autoplay));
  const [started, setStarted] = useState(Boolean(props.autoplay));
  const [scale, setScale] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const time = useRef(0);
  const live = useRef(false);
  const resume = useRef(false); // hidden while playing: play again once shown
  const scrub = useRef<{ resume: boolean } | null>(null);
  time.current = t;
  live.current = playing;
  const state = tour.stateAt(t);

  // Frames only while playing; a long gap (hidden, busy) advances at most one short step. The effect's cleanup
  // runs only after the next paint, so a frame already asked for checks `live` itself: paused means no more time.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (!live.current) return;
      const next = nextTime(time.current, now - last, duration);
      last = now;
      time.current = next;
      setT(next);
      if (next >= duration) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const stop = () => { live.current = false; setPlaying(false); };

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (live.current) { resume.current = true; stop(); }
      } else if (resume.current) {
        resume.current = false;
        setPlaying(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setScale(fitScale(element.clientWidth, element.clientHeight, layout.w, layout.h));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { (playButton.current ?? root.current)?.focus({ preventScroll: true }); }, []);
  // The end card reached by playing takes the focus (Enter continues).
  const endOn = state.end.on;
  useEffect(() => { if (endOn && live.current) continueButton.current?.focus({ preventScroll: true }); }, [endOn]);

  const seek = (next: number) => { const value = clamp(next); time.current = value; setT(value); setStarted(true); };
  const play = () => { if (time.current >= duration) seek(0); setStarted(true); setPlaying(true); };
  const toggle = () => { if (live.current) stop(); else play(); };
  const again = () => { seek(0); setPlaying(true); };
  const done = () => props.onDone();
  const seekAt = (x: number, element: HTMLElement) => { const rect = element.getBoundingClientRect(); seek(timeAt(x, rect.left, rect.width, duration)); };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const action = keyAction(event.key, Boolean(target?.closest('button')));
    if (!action || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (action === 'toggle') toggle();
    else seek(stepTime(action, time.current, duration));
  };

  const phase = !started ? 'poster' : state.end.on ? 'ended' : playing ? 'playing' : 'paused';
  const chapter = chapters[state.chapter]!;
  return (
    // tabIndex -1: a click on the scene focuses the player, so the keys keep working after it
    <div ref={root} class={`tour-player ${layout.variant}`} tabIndex={-1} data-phase={phase} data-time={Math.round(t)} onKeyDown={onKeyDown}
      style={{ '--tour-w': String(layout.w), '--tour-h': String(layout.h) }}>
      <div class="tour-top">
        <span class="tour-title">{TOUR_TITLE}</span>
        {props.skip
          ? <button type="button" class="button ghost small tour-skip" onClick={done}>Skip</button>
          : <button type="button" class="icon-button tour-close" aria-label="Close" onClick={done}><TourIcon name="x" size={18} /></button>}
      </div>
      <div class="tour-stage-room">
        <div class="tour-stage-box" ref={box} onClick={() => { if (!state.end.on) toggle(); }}>
          <div class="tour-stage" style={{ width: `${layout.w}px`, height: `${layout.h}px`, transform: `translate(-50%, -50%) scale(${scale})` }}>
            <Scene tour={tour} state={state} />
          </div>
          {!started && (
            <div class="tour-poster">
              <button type="button" class="tour-play" ref={playButton} aria-label="Play" onClick={(event) => { event.stopPropagation(); play(); root.current?.focus({ preventScroll: true }); }}>
                <TourIcon name="play" size={46} />
              </button>
            </div>
          )}
          {state.end.on && (
            <div class="tour-end" style={{ opacity: String(Math.min(1, state.end.age / 300)) }} onClick={(event) => event.stopPropagation()}>
              <p class="tour-end-text">{END_TEXT}</p>
              {props.note && <p class="tour-end-note">{props.note}</p>}
              <div class="tour-end-actions">
                <button type="button" class="button secondary" onClick={again}>Watch again</button>
                <button type="button" class="button primary" ref={continueButton} onClick={done}>Continue</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <p class="tour-caption" aria-live="polite">{state.caption}</p>
      <div class="tour-controls">
        <button type="button" class="icon-button tour-control" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
          <TourIcon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <button type="button" class="icon-button tour-control tour-jump" aria-label="Back 5 seconds" onClick={() => seek(stepTime('back', time.current, duration))}>
          <TourIcon name="back" size={22} /><span class="tour-jump-n" aria-hidden="true">5</span>
        </button>
        <button type="button" class="icon-button tour-control tour-jump" aria-label="Forward 5 seconds" onClick={() => seek(stepTime('forward', time.current, duration))}>
          <TourIcon name="forward" size={22} /><span class="tour-jump-n" aria-hidden="true">5</span>
        </button>
        <span class="tour-time">{formatTime(t)} / {formatTime(duration)}</span>
        <div
          class="tour-scrubber" role="slider" tabIndex={0} aria-label="Position"
          aria-valuemin={0} aria-valuemax={Math.round(duration / 1000)} aria-valuenow={Math.round(t / 1000)}
          aria-valuetext={`${formatTime(t)} of ${formatTime(duration)} – ${chapter.title}`}
          onPointerDown={(event) => {
            const element = event.currentTarget as HTMLElement;
            element.setPointerCapture?.(event.pointerId);
            scrub.current = { resume: live.current };
            stop();
            seekAt(event.clientX, element);
          }}
          onPointerMove={(event) => { if (scrub.current) seekAt(event.clientX, event.currentTarget as HTMLElement); }}
          onPointerUp={() => { const was = scrub.current; scrub.current = null; if (was?.resume && time.current < duration) setPlaying(true); }}
          onPointerCancel={() => { scrub.current = null; }}
        >
          <span class="tour-track"><span class="tour-fill" style={{ transform: `scaleX(${(t / duration).toFixed(4)})` }} /></span>
          {chapters.slice(1).map((entry) => <span key={entry.title} class="tour-tick" style={{ left: percent(entry.at) }} title={entry.title} />)}
          <span class="tour-knob" style={{ left: percent(t) }} />
        </div>
      </div>
    </div>
  );
}
