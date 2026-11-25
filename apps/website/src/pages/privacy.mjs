import { page } from '../layout.mjs';
// Restores Nora's existing feedback notice as a build-discovered page; no sending or collection.
// 18.11.2026: section #meeting-server – what the meeting server (services/remote-relay) and the direct connections
// between a person's devices process; the app's Settings › Devices › Connection links here.
export default function privacy(rel) {
 return page({slug: 'privacy', rel, title: 'Privacy', description: 'How Autark connects your devices, handles voluntary encrypted app feedback, counts downloads and use anonymously, and what this website collects.', body: () => `

<section class="phero"><div class="wrap">
  <nav class="phero__crumbs" aria-label="Breadcrumb"><a href="/">Autark</a><span>/</span><span>Privacy</span></nav>
  <h1 data-reveal>Privacy, <em>plainly.</em></h1>
  <p class="lead" data-reveal style="--d:1">Autark runs on your computer. This page says what our meeting server sees when your devices connect, what leaves your computer when you choose to send feedback from the app, the anonymous counts of downloads and use, and what this website itself collects.</p>
</div></section>

<section class="section">
  <div class="wrap">
    <div class="layout-doc">
      <nav class="toc" aria-label="On this page">
        <b>On this page</b>
        <a href="#controller">Who is responsible</a>
        <a href="#meeting-server">Connecting your devices</a>
        <a href="#feedback">App feedback</a>
        <a href="#counts">Anonymous counts</a>
        <a href="#website">This website</a>
        <a href="#rights">Your rights</a>
      </nav>
      <div class="prose">
        <h2 id="controller">Who is responsible</h2>
        <p>Teydra Lab, operated by Meral Anna Hees, Ludwig-Richter-Straße 4a/Top3, 5026 Salzburg, Austria. Contact for privacy requests: <a href="mailto:official@teydralab.com">official@teydralab.com</a>. The legal notice is at <a href="https://teydralab.com/impressum/" rel="noopener">teydralab.com/impressum</a>.</p>

        <h2 id="meeting-server">Connecting your devices</h2>
        <p>Your PCs and phones talk to each other directly over the internet, encrypted end to end with keys that never leave your devices. Our meeting server only helps them find each other: a device tells it where it can be reached, and the server passes that on to the devices you linked with it. Then they connect directly.</p>
        <p><strong>What the meeting server processes.</strong> While a device is connected: its IP address, the port it can be reached on, its public device key and Remote ID, the fingerprints of the devices it is linked with, and when it connects. When two devices cannot reach each other directly, the server passes their encrypted traffic on as a fallback and counts its bytes for a daily limit; it cannot read or change that traffic. Connection requests by Remote ID pass through it sealed; only the person on the other device can accept them.</p>
        <p><strong>Why.</strong> To connect the devices you chose to link (Article 6(1)(b) GDPR) and to keep the service safe from misuse (Article 6(1)(f) GDPR).</p>
        <p><strong>Storage.</strong> The server keeps all of this in memory only, while the device is connected; nothing is written to disk and it logs nothing about devices. Daily byte counts start at zero each day. The server is hosted by Render behind Cloudflare; both process connection data such as IP address and request time to run and protect the service, under their own terms.</p>
        <p><strong>Direct connections.</strong> Devices that connect directly see each other's IP address. To find its public address for a direct connection, a device asks a STUN server, by default Cloudflare's (stun.cloudflare.com), which sees the device's IP address and the time.</p>
        <p><strong>Your own server.</strong> You do not have to use ours. The meeting server is open source (<a href="https://github.com/teydra/OpenAutark/tree/main/services/remote-relay" rel="noopener">services/remote-relay</a>) and ships with the app. Run it yourself and enter its address in Settings › Devices › Connection on your devices; the app shows how. Then none of the above reaches us.</p>

        <h2 id="feedback">App feedback</h2>
        <p>Feedback is voluntary. Save keeps a report on your computer only; nothing is sent. Send uploads it.</p>
        <p><strong>What is sent.</strong> Your feedback text, the screenshot you choose to include, the report ID and date, app version, operating system and the current app view, and where you wrote it: the kind of app and device (for example the Android app's version, Android version and phone model), screen size, language and the browser's user agent. When the Recording box is on, the voice recording of your dictation travels with the report, sealed for the team like the text. When "Crash report attached" is on, the Android app's crash report (program names, device and system version) travels with it too. Reports filed by an agent are marked as such. When you send a report, recent warning and error messages are automatically included if available, after automatic redaction (up to 15 entries and 2,000 characters). Your chat history is not attached. Please remove personal information you do not want to share, including information about other people, and paint over private parts of a screenshot.</p>
        <p><strong>Why.</strong> To understand problems, fix bugs and improve the app. The legal basis is our legitimate interest in maintaining and improving the app (Article 6(1)(f) GDPR). Feedback is not used for automated decisions about you.</p>
        <p><strong>Encryption and transport.</strong> Text, screenshot and recording are encrypted with the team's public key on the device you write on – your computer, or your phone or browser, which sends the report directly (a phone or browser that cannot encrypt it passes it to your computer, which encrypts and sends it) – before upload. A report sent from your computer is also saved there. While there is no connection it waits in the app's storage on that device and is deleted there once it is sent. The mailbox is a Google Cloud Firestore database in Frankfurt (europe-west3) that accepts new encrypted letters only; nobody can read, change or delete them through the app. Only the team's computer holds the private key that opens them. Google also processes connection data, such as your IP address and request time, to provide and secure the service.</p>
        <p><strong>Processor.</strong> Google provides Firestore under its <a href="https://cloud.google.com/terms/data-processing-addendum" rel="noopener">Cloud Data Processing Addendum</a>. An EU database location does not exclude international processing of service or support data; Google's terms describe subprocessors and safeguards for transfers.</p>
        <p><strong>Storage.</strong> The encrypted report stays in the mailbox until the team deletes it there, at most 30 days. Each of the team's computers that retrieves it keeps a copy while needed to handle the feedback; a report the team marked done or not relevant is deleted from its computer 7 days later; for the others there is no fixed automatic deletion period. Copies on your own computer follow your local data and backup management. Reports are not published.</p>

        <h2 id="counts">Anonymous counts</h2>
        <p>We count two things, and neither number knows who you are.</p>
        <ul>
          <li><strong>Download clicks.</strong> When you click a download button on this website, your browser adds 1 to a counter for that day and that platform (for example “Windows, 25 Nov 2026”). It tells us how many people download Autark for which system.</li>
          <li><strong>Use of the app.</strong> From a coming version of Autark, an installation that is in use sends at most one signal per hour. It adds 1 to a counter for that hour and its platform (Windows, macOS, Linux, Android or iPhone), and with its first signal of a day also 1 to that day’s counter of active devices. It tells us on which days and at which hours Autark is used.</li>
        </ul>
        <p><strong>What is not counted or stored.</strong> No device or installation ID, account, name, cookie or fingerprint, no app version, no page address, nothing about your work, no location. The request contains only the name of a counter. We cannot tell which click or which device added to a counter, and we store no IP address with the counts. The signal goes from your browser or your device straight to Google Firestore (see Processor below); as with any internet request, your IP address reaches Google while the request is delivered. We neither receive nor store it, and the counters carry no address. Nothing is sent when you only read this website.</p>
        <p><strong>Why.</strong> To see whether and when Autark is used, so we can plan updates and support (legitimate interest, Article 6(1)(f) GDPR). The counts are anonymous statistics; they are not used for decisions about individuals.</p>
        <p><strong>Turning it off.</strong> The app has a switch for the usage signal in its settings. You do not need to switch anything off for the download count: it only happens when you click a download button. If you prefer not to be counted, take the files from the <a href="https://github.com/teydra/OpenAutark/releases/latest" rel="noopener">GitHub release page</a>.</p>
        <p><strong>Processor and storage.</strong> The counters are plain numbers in the same Google Cloud Firestore database in Frankfurt (europe-west3) as the feedback mailbox, in separate collections (see Processor under App feedback). Only the team can read them: a private statistics page signs in with a Google account of the team and shows them as charts. Anonymous numbers hold nothing that could be deleted for one person; we keep them as long as they help us understand use.</p>

        <h2 id="website">This website</h2>
        <p>openautark.com is a static website served through Cloudflare. It sets no cookies, stores nothing on your device and loads no advertising, analytics or third-party scripts. The only thing it sends on its own is the anonymous download count described above, and only when you click a download button. Like every web host, Cloudflare processes technical connection data (such as IP address and request time) to deliver and protect the site, and keeps server logs for operation and security. Downloads are served from GitHub releases, which process your connection data under GitHub's own terms.</p>

        <h2 id="rights">Your rights</h2>
        <p>You can request access, correction, deletion or restriction, and object to processing based on legitimate interests. Write to <a href="mailto:official@teydralab.com">official@teydralab.com</a> with the date and details of your report so we can find it; we do not require a sender account. You can complain to your supervisory authority, including the <a href="https://dsb.gv.at/" rel="noopener">Austrian Data Protection Authority</a>.</p>
      </div>
    </div>
  </div>
</section>
`});
}
