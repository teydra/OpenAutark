// B-055: the feedback tour as a dialog over the app (replay from Settings › Feedback "Watch how it
// works", openTour() in open.ts; B-085 also the first run's choice card, ui/onboarding/ChoiceCard.tsx). A native modal dialog: Esc, the × and Continue close it (closeTour);
// a click on the backdrop too. The player starts at its poster on every opening (it mounts afresh).
// Feedback 16.11.2026 (F15): in the phone layout (`phone`, the shell's) it plays the phone's tour – the variant is the
// opening's and stays while it plays (a window made narrow meanwhile keeps the computer's – open.ts tourVariant: the
// narrow window's shell mounts this dialog afresh).
// Owns: mounting the player while `tourOpen` is true. Never: the timeline or the scene.

import { useLayoutEffect, useRef } from 'preact/hooks';
import { closeTour, tourAutoplay, tourOpen, tourVariant } from './open.ts';
import type { Variant } from './scene-layout.ts';
import { TOUR_TITLE, TourPlayer } from './TourPlayer.tsx';

export function TourDialog(props: { phone?: boolean; desktopBubble?: boolean }) {
  if (!tourOpen.value) return null;
  return <TourModal variant={tourVariant(Boolean(props.phone))} desktopBubble={props.desktopBubble} />;
}

function TourModal(props: { variant: Variant; desktopBubble?: boolean }) {
  const { variant } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const showDesktopBubble = useRef(variant === 'desktop' && props.desktopBubble === true);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog
      ref={ref} class={`dialog tour-dialog ${variant}`} aria-label={TOUR_TITLE}
      onCancel={(event) => { event.preventDefault(); closeTour(); }}
      onClick={(event) => { if (event.target === ref.current) closeTour(); }}
    >
      <TourPlayer onDone={closeTour} autoplay={tourAutoplay.peek()} variant={variant} desktopBubble={showDesktopBubble.current} />
    </dialog>
  );
}
