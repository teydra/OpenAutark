// Owns: the steps a person actually sees when installing, per platform. One source for /access/,
// /download/ and the /download/<platform>/ pages.
// Never: links to other pages or layout; names come from config.mjs, so they follow a rename.
// Written from what macOS, Windows (signed, new certificate) and Android show for downloads; there is no Mac and no
// Android phone here to re-check the wording on (README.md, "Beim Release").
import { appUrl, release, site } from '../config.mjs';

const { files, app } = release;
const quarantine = `xattr -dr com.apple.quarantine "/Applications/${app.macBundle}"`;

export const installSteps = {
  windows: () => `
    <ol>
      <li><strong>Download</strong> <code>${files.windows}</code>. The installer is code-signed (publisher: Open Source Developer Meral Anna Hees). Because the certificate is new, your browser may still warn that the file is not commonly downloaded. Verify the file before deciding whether to continue.</li>
      <li><strong>Start it.</strong> SmartScreen may show a blue box, “Windows protected your PC”, once, while the new certificate builds a reputation. Check that the publisher is Open Source Developer Meral Anna Hees, then choose <em>More info</em> and <em>Run anyway</em>.</li>
      <li><strong>Install.</strong> Keep “only for me”: no admin rights are needed. Pick a folder or keep the suggested one. A desktop shortcut is created.</li>
    </ol>
    <p><strong>If Windows blocks installation:</strong> stop and contact us. Smart App Control usually lets signed files through, but that is no promise. Do not turn off Smart App Control or other Windows protection to install this build. Organisation-managed PCs may require your IT administrator.</p>`,
  mac: () => `
    <ol>
      <li><strong>Download</strong> the DMG and open it. Drag the app into <em>Applications</em>${release.renamed ? '' : `. It appears as <em>${app.name}</em>, the working name, until the rename release`}.</li>
      <li><strong>Open it.</strong> macOS refuses the first time and says Apple could not check it for malware. Close that box with <em>Done</em>, not <em>Move to Trash</em>.</li>
      <li><strong>macOS 15 and newer:</strong> open <em>System Settings → Privacy &amp; Security</em>, scroll down to <em>Security</em>, choose <em>Open Anyway</em> next to the app’s name and confirm with your password or Touch ID. <strong>macOS 14 and older:</strong> Control-click the app in Applications, choose <em>Open</em>, then <em>Open</em> again.</li>
      <li><strong>If macOS says the app “is damaged”,</strong> or still will not open it, the cause is the quarantine mark macOS puts on downloaded files. Check the file first (below), then remove the mark in Terminal:
        <br><code>${quarantine}</code> <button class="btn btn--sm btn--ghost" type="button" data-copy="${quarantine.replaceAll('"', '&quot;')}" style="margin-left:6px;vertical-align:middle">Copy</button></li>
    </ol>
    <p>That command tells macOS to stop treating this one app as an unchecked download. Nothing is repaired by it and nothing else on your Mac changes. ${site.name} has no Apple Developer ID yet: the app is signed ad hoc and not notarized, so macOS offers no way around these steps. macOS may ask again for access to your keychain after an update, because every build carries its own ad hoc signature.</p>`,
  linux: () => `
    <ol>
      <li><strong>Download</strong> <code>${files.linux}</code> and make it executable: <code>chmod +x ${files.linux}</code>.</li>
      <li><strong>Run it.</strong> It needs FUSE 2, a working Chromium sandbox and a running system keyring. Without a keyring, secrets cannot be stored; there is no plain-text fallback.</li>
    </ol>`,
  android: () => `
    <ol>
      <li><strong>Download</strong> <code>${files.android}</code> on the phone. Chrome may ask whether to keep the file; keep it.</li>
      <li><strong>Open it.</strong> The first time, Android asks to allow installs from your browser: choose <em>Settings</em>, turn on <em>Allow from this source</em>, go back and choose <em>Install</em>.</li>
      <li><strong>Connect it to your company.</strong> Open ${site.name} on the phone and type your PC’s <em>Remote ID</em> (on the PC: Settings → Devices), or scan the QR code shown there. Both screens show the same short code. Choose <em>Accept</em> on the PC.</li>
      <li><strong>Done.</strong> The phone now belongs to your company, not to one PC: the same chats, tasks and notifications as on every PC you linked. Read on one device, read everywhere.</li>
    </ol>
    <p><strong>Updates come inside the app:</strong> a line at the top says when a new version exists. <em>Update</em> downloads it with its progress, checks it against the published SHA-256 and hands it to Android; the first time Android asks you to allow installs from ${site.name}, then you confirm the update.</p>
    <p><strong>No phone use by agents in this version:</strong> the APK behind the big button leaves out the Accessibility service that phone control needs. Chats, tasks, notifications, the microphone and the camera work as before.</p>
    <p><strong>Full version with phone control:</strong> <code>autark-android.apk</code> lets the AI operate the phone. After installing it, turn on ${site.name} under Settings › Accessibility if you want the AI to operate the phone.</p>`,
  iphone: () => `
    <ol>
      <li><strong>Open <a href="${appUrl}/">${appUrl.replace(/^https?:\/\//, '')}/</a> in Safari</strong> on the iPhone. There is no App Store app and no Apple account is needed.</li>
      <li><strong>Tap <em>Share</em>, then <em>Add to Home Screen</em>.</strong> Open ${site.name} from the Home Screen: the pairing and notifications live there, Safari keeps separate storage.</li>
      <li><strong>Type your PC’s Remote ID.</strong> On the PC: Settings → Devices → Connect a phone. Scanning its QR code with the Camera shows the same ID to copy.</li>
      <li><strong>Compare the code</strong> both screens show and <strong>accept on the PC</strong>. From then on the iPhone shows your PC’s own screens, in any network, end to end encrypted through the meeting server.</li>
      <li><strong>Turn notifications on</strong> in Settings → Devices on the iPhone (iOS asks once).</li>
    </ol>
    <p><strong>What an iPhone cannot do:</strong> agents cannot use other iPhone apps for you. iOS offers no way for any third-party app to read the screen or tap. Chats, tasks, notifications and the microphone work.</p>`,
};
