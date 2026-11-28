// Settings › Devices › "Connection": the rows behind connecting – whether other PCs and my phone may find this PC and ask
// (devices.findable) and the meeting server devices in other networks find each other over (devices.relay, its state in
// the hint). B-078 (D5): no phone switch and no "reach over" choice – a phone gets in exactly while its accepted row
// exists (Remove ends it); pwa.bind for LAN/Tailscale browsers stays a settings.json key the AI sets (skill phone-access).
// The same keys of settings.json the AI changes. B-084: on my phone too – a 'settings' device on a secure transport
// writes the 'devices' section (rpc/handlers/system.ts).
// F29 stage 1 (16.11.2026): one row per phone app – its way to this PC now (direct or via the meeting server) and the
// bytes of each today (RelayState.phones), so the gain of the direct way shows; inside the iPhone web app one row says
// that it always goes via the meeting server (a page can't open a direct connection to a PC).
// 18.11.2026 (owner: the server is only the meeting point): the group's line says how devices connect and links the
// privacy notice; the meeting server row says when its fallback is held (daily limit / paused); "Your own meeting server"
// opens the setup dialog (own-server.tsx).
// 0.3.19 (23.11.2026, owner: the waker must be switchable): "Wake while closed" (devices.wakeHelper) – off, no helper waits
// while the app is closed, so neither Wake nor scheduled work starts it then.
// 28.11.2026 (Mac test): that line names the way the links run now (connect-text.ts connectionLine) – direct, through the
// meeting server, partly, or "either" while nothing is known.
// Owns: these rows. Never: lets a device in without the person's Accept, or shows a key.

import { relayAddress, type RelayState } from '../../shared/model/relay.ts';
import { time } from '../lib/format.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { inHostedApp } from '../pwa/native.ts';
import { openExternal } from '../lib/platform.ts';
import { connectionLine, IPHONE_LINK, phoneLinkHint, PRIVACY_URL, relayLine, WAKE_HELPER_HINT } from './connect-text.ts';
import { act, Group, Row, TextField, Toggle } from './controls.tsx';
import { OwnServerButton } from './own-server.tsx';

export function ConnectionGroup(props: { relay?: RelayState; findable?: boolean }) {
  const devices = settings.value?.devices;
  const saveRelay = (typed: string) => {
    const value = typed.trim();
    void act(async () => {
      const address = value ? relayAddress(value) : ''; // its one spelling: lower case, no default port, no end slash
      if (address === undefined) throw new Error('A meeting server address looks like wss://host');
      await updateSettings({ devices: { relay: address } });
    }, 'Address not saved');
  };
  return (
    <Group title="Connection" id="settings-connection" hint={<>{connectionLine(props.relay)} <a href={PRIVACY_URL} onClick={(event) => { event.preventDefault(); openExternal(PRIVACY_URL); }}>Privacy</a></>}>
      <Row label="Accept connection requests" reserve hint="Other PCs and your phone see this PC and ask; you accept each one">
        <Toggle label="Accept connection requests" checked={props.findable ?? devices?.findable ?? true} disabled={!devices} onChange={(findable) => void act(() => updateSettings({ devices: { findable } }), 'Could not save')} />
      </Row>
      <Row label="Wake while closed" reserve hint={WAKE_HELPER_HINT}>
        <Toggle label="Wake while closed" checked={devices?.wakeHelper ?? true} disabled={!devices} onChange={(wakeHelper) => void act(() => updateSettings({ devices: { wakeHelper } }), 'Could not save')} />
      </Row>
      <Row label="Meeting server" reserve hint={relayLine(props.relay, devices?.relay ?? '')}>
        <TextField label="Meeting server" type="url" placeholder="wss://…" maxLength={300} value={devices?.relay ?? ''} disabled={!devices} onCommit={saveRelay} />
      </Row>
      <Row label="Your own meeting server" reserve hint="Run it yourself, then nothing goes through ours">
        <OwnServerButton relay={props.relay} />
      </Row>
      {inHostedApp() && <Row label="This iPhone" reserve hint={IPHONE_LINK} />}
      {(props.relay?.phones ?? []).map((link) => <Row key={link.deviceId} label={link.name} reserve hint={phoneLinkHint(link, Date.now(), time)} />)}
    </Group>
  );
}
