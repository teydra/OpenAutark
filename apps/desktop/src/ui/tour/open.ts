// B-055: opening the feedback tour from anywhere (the command palette's "Watch how it works"; B-085: the
// first run's choice card opens it too). The player (ui/tour/TourPlayer.tsx) is mounted by the shell while
// `tourOpen` is true. B-090 (owner 13.11.2026: "wenn man eine neue Company auswählt, dass man dann das Video sieht"):
// "Set up a new company" opens it already playing (`tourAutoplay`; the click is the user gesture). Feedback 16.11.2026
// (F15) played it on the iPhone web app's first start too; owner 26.11.2026: the phone explains nothing of the feedback bubble on its own, so no phone opens it by itself (28.11.2026).
// F15: the variant is the opening's (tourVariant) and stays until the tour closes – a window made narrow or wide while it
// plays switches the shell's layout and mounts its overlays afresh (shell/Shell.tsx), never the tour's variant.
// Owns: the open/close signal and the opening's variant. Never: the player or its timeline.

import { signal } from '@preact/signals';
import type { Variant } from './scene-layout.ts';

/** True while the tour is shown as a dialog over the app (not the first-run step). */
export const tourOpen = signal(false);

/** True when this opening starts playing at once instead of at its poster. */
export const tourAutoplay = signal(false);

let openedAs: Variant | undefined;

export function openTour(options: { autoplay?: boolean } = {}): void { tourAutoplay.value = Boolean(options.autoplay); tourOpen.value = true; }
export function closeTour(): void { tourOpen.value = false; tourAutoplay.value = false; openedAs = undefined; }

/** The variant this opening plays: the layout's when it first shows (`phone`: the shell's phone layout), kept till it closes. */
export function tourVariant(phone: boolean): Variant {
  openedAs ??= phone ? 'phone' : 'desktop';
  return openedAs;
}
