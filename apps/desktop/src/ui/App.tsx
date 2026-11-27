// Root component: the shell, plus the few states the browser/phone build needs instead of it – a failed pairing, an
// unpaired browser (DEV5B: "Ask this PC for access", pwa/AccessRequest.tsx), a page opened from a person's invite
// (F-52: #join=, pwa/JoinRequest.tsx), a phone the PC removed (4403: AccessRequest removed) and the runtime's repair mode.
// Sicher-Runde 19.11.2026 (D1, D4, D5, D7 – "am Handy nur My Day, keine Knöpfe"): a PC that is out of reach, does not
// know this phone yet (4404) or no longer accepts it (4401) never replaces the shell – the frame keeps its destination tabs
// and the last data (pwa/offline-cache.ts), and it is said in one calm line – Pair again where it needs the person; the
// page reconnects by itself (shell/connection-line.ts); Forget this phone stays in Settings › Devices. Inside the Android app a refusal
// first goes to the app, which tries the company's next PC (pwa/native.ts reportRefusals).
// Owns: those screens and the top-level error boundary. Never: data loading itself (main.tsx starts it) or any write to
// the PC while offline (feedback written then waits in the page's outbox).

import { useEffect } from 'preact/hooks';
import { Boundary } from './blocks/Boundary.tsx';
import { platform } from './lib/platform.ts';
import { rpc } from './lib/rpc.ts';
import { loaded } from './lib/store.ts';
import { ContextMenuHost } from './lib/context-menu.tsx';
import { AccessRequest } from './pwa/AccessRequest.tsx';
import { JoinRequest } from './pwa/JoinRequest.tsx';
import { joining } from './pwa/join.ts';
import { reportRefusals } from './pwa/native.ts';
import { hasDeviceToken, pairingError } from './pwa/install.ts';
import { Shell } from './shell/Shell.tsx';
import { RepairScreen } from './repair/RepairScreen.tsx';
import { repairState } from './repair/repair-state.ts';

function hashToken(): boolean {
  return /(?:^#|&)token=/.test(location.hash);
}

function BootNote(props: { text: string; detail?: string }) {
  return (
    <div class="boot boot-note" role="alert">
      <p>{props.text}</p>
      {props.detail && <p class="muted">{props.detail}</p>}
    </div>
  );
}

/**
 * A browser page without any token was refused or found no PC once: it shows the access request from then on (the
 * client retries with backoff and flips between 'connecting' and 'closed'; a sticky flag keeps the screen from flickering).
 */
let tokenlessAway = false;

function Root() {
  // 23.10.: the runtime runs in repair mode (broken upgrade, crash loop) – the repair screen replaces the app.
  const repair = repairState.value;
  if (repair?.active) return <RepairScreen state={repair} />;
  if (platform === 'desktop') return <Shell />;
  if (joining.value) return <JoinRequest />; // F-52: a person joining an organisation from an invite
  if (pairingError.value && !loaded.value) return <BootNote text="Pairing failed." detail={pairingError.value} />;
  const refused = rpc.refused.value;
  if (refused === 4403) return <AccessRequest removed />; // removed on the PC: nothing in the shell would work any more
  if (!loaded.value && !hasDeviceToken() && !hashToken()) {
    if (refused !== null || rpc.status.value === 'closed') tokenlessAway = true;
    if (tokenlessAway) return <AccessRequest />;
  }
  return <Shell />;
}

export function App() {
  useEffect(() => reportRefusals(rpc), []); // the Android app tries the company's next PC on a refusal (F15)
  return (
    <Boundary fallback={(reset) => (
      <div class="boot boot-note" role="alert">
        <p>Something went wrong.</p>
        <button type="button" class="button secondary" onClick={reset}>Reload view</button>
      </div>
    )}>
      <Root />
      <ContextMenuHost />
    </Boundary>
  );
}
