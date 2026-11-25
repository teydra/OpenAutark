# Autark für iPhone (Stufe 2 + Welle 2 – Direktweg, Wecken, Push-Vorbereitung, Live Activity und Schnellzugriffe, Stand 21.11.2026)

Native iPhone-Hülle für Autark, Schwester der Android-App (`apps/android`): koppelt per QR-Code oder 9-stelligem Code mit einem PC
(Remote ID), spricht über Autarks Treffpunkt (`wss://telecoding-relay.onrender.com/autark`) mit ihm und zeigt die **unveränderte
Handy-Oberfläche des PCs** in einer `WKWebView`. Agenten, Modelle und Daten bleiben auf den PCs. Swift 5-Sprachmodus, iOS 17+, SwiftUI +
UIKit, ausschließlich Apple-Frameworks (CryptoKit, WebKit, AVFoundation, Network, Security), keine Drittpakete.

**Stand:** Das Gerüst baut und besteht seine Tests im iOS-Simulator (GitHub Actions, macOS-Runner, ohne Signatur). Stufe 2 (21.11.2026) bringt aus der
Android-Hülle den **Direktweg** Handy → PC (`Route`, `DirectPipe`, PC-Liste per `phone.pcs`), das **Wecken** eines geschlossenen PCs (`Wake`) und die
**Vorbereitung für Push** (Benachrichtigungsentscheidungen wie im Service Worker des PCs, lokale Benachrichtigungen, `PushRegistration` mit Fakes) –
alles ohne Apple-Konto; die WebRTC-Strecke ist bewusst nicht portiert (nur eine Schnittstelle, siehe „WebRTC“). Die App lief **noch nie auf
einem echten iPhone, nie gegen einen echten PC und nie gegen den echten Treffpunkt aus der App heraus** – siehe „Nicht geprüft“.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `Autark/Core/` | Plattformneutraler Kern (Foundation + CryptoKit, Framework `AutarkCore`): `Crypto` (Ed25519, X25519, HKDF, AES-GCM, base64url, Remote ID), `Json`, `RemotePair` (Kopplungsprotokoll `remote1/commitment/remote2/Code/remote3`, byte-gleich mit `remote/sas.ts`), `PhonePairing`/`Pairing`/`PairRun`, `RelayLink` (Treffpunkt-Protokoll v1), `Tunnel`, `DirectPipe` + `Route` (Direktweg), `PeerChannel` (Handshake `wf-peer-v1` + Kanal), `PcLinks`, `PcVersion`, `PcList` (`phone.pcs`: Schlüssel und Adressen der PCs), `Wake`, `Notices` (Benachrichtigungsentscheidungen), `PushRegistration`, `Rtc` (nur Schnittstelle), `PhoneConnection` (Backoff, Presence, Wechsel des PCs, Direktweg, Wecken), Welle 2: `LiveState`, `UseRules` (Android `UseState`/`SayChoices`), `PhoneUseResponder`, `UseLink` (eigener `/ws`-Socket), `LiveTokens` (`phone.liveToken`), `QuickSend` + `ShareInbox`, `StreamProxy` + `Loopback` (lokaler Eingang), `CodeChain`, `Companies` (mehrfirmenfähig, Port 47920+n), `ConnectionAddress`, `CssColor` |
| `Autark/Platform/` | `URLSessionSocket` (WebSocket über `URLSessionWebSocketTask`, mit eigenem Verbindungs-Zeitlimit und Rahmengröße je Aufruf), `KeychainStore` (Schlüssel, nur dieses Gerät, `AfterFirstUnlockThisDeviceOnly`) |
| `Autark/Shared/` | App **und** Widget-Erweiterung (Welle 2): `LiveIntents` (ActivityKit-Attribute `AutarkAgentActivityAttributes`, Knöpfe der Live Activity als `LiveActivityIntent`, Intents der Steuerelemente, `QuickBridge`), `LiveViews` (Sperrbildschirm-Banner, Dynamic Island, Sperrbildschirm-Widgets) |
| `Autark/Widgets/` | Widget-Erweiterung `AutarkWidgets` (iOS 18): Live Activity, Sperrbildschirm-Widgets, Steuerzentrale (`ControlWidget`) |
| `Autark/Share/` | Share-Extension `AutarkShare`: Bilder, Text, Links in einen Chat (App Group, die App sendet) |
| `Autark/App/Quick/` | `LiveController` (ActivityKit, Token), `QuickCenter` (Schnellzugriffe über den eigenen Socket), `QuickIntents` (App Intents, `AutarkShortcuts`, `ChatEntity`), `DictationView` |
| `Autark/App/` | SwiftUI: `AutarkApp`, `AppModel`, `Views` (Verbinden · Scanner · Code · Warten · Seite), `QRScanner` (AVFoundation), `PageBridge` (WKWebView, Gate-Cookie, `NativePort`-Kanal), `Notifier` (lokale Benachrichtigungen über `UNUserNotificationCenter`, Delegate, Token-Rückrufe des App-Delegates) |
| `Tests/CoreTests/` | XCTest des Kerns (läuft auch unter Linux) inkl. `DesktopVectors.swift` (vom echten Desktop-Code erzeugt) und den Prozess-internen Gegenstellen (`TestSupport.swift`) |
| `Tests/AppTests/` | XCTest nur im Simulator: echte `WKWebView` gegen den lokalen Eingang, `AppModel`, Keychain |
| `project.yml` | XcodeGen-Projekt (`Autark.xcodeproj` wird erzeugt, nie eingecheckt) |
| `Package.swift` | derselbe Kern als Swift-Paket, damit seine Tests auch ohne Xcode laufen (Linux/WSL: `swift-crypto` ersetzt CryptoKit) |

Wie Android (siehe `apps/android/README.md`, „Wie es funktioniert“): ein Handy-Schlüssel (Ed25519, im Keychain), Kopplung wie zwischen
PCs, ein Treffpunkt-Tunnel je PC der Firma, darüber der gepinnte Handshake und ein verschlüsselter Kanal mit Byte-Strömen zum HTTP-Port der
PC-Runtime; ein lokaler Eingang auf `127.0.0.1` (Port 47920 für die erste Firma, 47921 … für weitere = eigener Origin je Firma) reicht diese
Ströme an die `WKWebView` weiter. Die Seite lädt `http://127.0.0.1:<port>/#token=<Token>`.

### Seite ↔ App

Die Seite (`apps/desktop/src/ui/pwa/native-port.ts`) wartet auf die Fensternachricht `autark-port` mit einem `MessagePort` aus ihrem **obersten
Fenster**. Android erzeugt ihn mit `postWebMessage`; WebKit hat das nicht. Die iOS-Hülle lässt deshalb ein Benutzerskript im Hauptframe
(`atDocumentStart`) einen `MessageChannel` bauen und dessen anderes Ende per `window.postMessage('autark-port', '*', [port])` an die Seite
geben – die Seite bleibt unverändert (`event.source === window.top` trifft zu). Das Gegenstück zum Port ist **ein**
`WKScriptMessageHandler`, der **nur den Hauptframe** annimmt (ein Agenten-iframe erreicht die App nicht) und nur, wenn die Seite zum eigenen
Origin gehört. Nach jedem neuen Dokument wird der Gruß bis zu 8-mal im Abstand von 0,5 s wiederholt, bis die Seite antwortet (sie installiert
ihren Zuhörer einen Moment nach dem Laden); `companies` und `status` werden jeder neuen Seite nachgeliefert. JSON `{t, …}` wie bei Android.

`offline.owner` (Felix, Android-Hülle): die App sendet der Seite `{t:'offline.owner', owner:{companyId, pcFingerprint}}` (ohne Token/Seed; `owner:null` bei Abmeldung/unklarer Zuordnung) vor dem Laden der Seite, bei jedem neuen Port als erste Nachricht und bei jedem Wechsel des PCs der Seite, **bevor** der lokale Eingang dessen Kanal an einen Strom gibt (`PhoneConnection.onPageChannel`).

Stufe 2 versteht von der Seite: `colors` (Statusleiste), `haptic`, `card`, `switch`, `add`, `forget`, `pcs`, `refused`, `wake` `{id, key, name}` (Antwort `woken` `{id}` bzw. `{id, error}`; `status` trägt `wake: true`, damit die Seite es anbietet – `ui/settings/device-wake.ts`) und `notify.enable` (Vorschlag, die Seite sendet es noch nicht: fragt die Person einmal nach Benachrichtigungen); zur Seite gehen
`status`, `companies`, `resume`, `offline.owner`, `woken`, `push.token` (Vorschlag, siehe „Benachrichtigungen“) und `notice.answer` `{id?, answer}` (Vorschlag). Eine angetippte Benachrichtigung bringt die Seite über ihren Hash (`location.hash = '#/chat/<id>'`) an die Stelle, wie `wf.navigate` im Service Worker des PCs. Alles andere (`speak`, `download`, `shot`, `voice.live`, `bubble.*`, `feedback`, `share`) wird ignoriert.

Gate-Cookie: der Eingang lässt nur Anfragen mit dem privaten Cookie `autark_gate` durch (setzt die App per `WKHTTPCookieStore` für `127.0.0.1`);
alles andere bekommt 403. User-Agent: `… AutarkIOS/<Version> (iOS <Release>; <Modell>)`.

## Direktweg Handy → PC (F29, aus `relay/Route.java`, `DirectPipe.java`)

`PhoneConnection` öffnet den Kanal zu einem PC wie Android: **alle** Peer-Adressen des PCs (`Pc.addresses`: Router-Abbildung, LAN, Tailnet, IPv6 – höchstens 8,
nur `http(s)`) werden gleichzeitig als `ws(s)://<Adresse>/peer/phone` gewählt (`DirectPipe`, URLSession, 1,5 s zum Verbinden und Hochstufen, 8-MiB-Rahmen); die erste, die
aufgeht, führt den **gepinnten Handshake** (`wf-peer-v1`, derselbe wie im Tunnel – eine fremde Antwort auf der Adresse scheitert daran), die späteren werden geschlossen
(`Route.first`). Geht keine auf oder scheitert der Handshake, öffnet `Route.open` den **Tunnel über den Treffpunkt**; ein PC hat immer nur eine Leitung (der Direktkanal ersetzt den
Tunnel, er kommt nicht dazu). Die Statuszeile sagt „Connected to <PC> directly.“.

- **Wechsel der Route bei Netzwechsel/Vordergrund:** `check()` (aus `scenePhase = .active` und `NWPathMonitor`) setzt das Zurückstellen der Wartezeiten zurück, prüft Treffpunkt **und** jeden
  Direktkanal binnen 2 s und versucht den PC der Seite, wenn er über den Tunnel läuft, **einmal** direkt (`tryDirect`): gelingt es, ersetzt der Direktkanal den Tunnel, die Ströme auf dem
  alten enden und die Seite hört `resume`. Verliert ein Direktkanal die Leitung, öffnet die Schleife denselben PC neu (Direktweg zuerst, sonst Tunnel). Kein Zeitgeber, keine Dauerschleife.
- **Lebenszeichen:** URLSession beantwortet die Pings des PCs selbst und zeigt sie der App nicht; `DirectPipe.checkAlive()` pingt deshalb nach 25 s Stille (Pong zählt als Rahmen),
  `probe()` beendet den Socket, wenn binnen 2 s gar kein Rahmen kommt.
- **Woher die Adressen kommen:** Android bekommt sie aus `phoneUse.attach` – das gibt es unter iOS nicht (die KI darf ein iPhone nicht bedienen). Die iOS-Hülle fragt deshalb den PC der Seite
  selbst: **`phone.pcs`** (`PcList`), eine `POST /rpc`-Anfrage mit dem Token des Handys auf einem eigenen Strom (Nummer 1 000 000 000) des Kanals, wie `PcVersion` es für die Version tut; die
  Antwort (`myPcs` des PCs: bis zu 16 PCs mit Schlüssel, Name und Adressen, jede Zeile gegen ihren Fingerabdruck geprüft) wird nach jedem Wechsel der Seite auf einen PC und nach jedem
  `check()` gelesen, die neue Liste (auch **neue PCs** der Firma, die jetzt gepinnt werden, und entfernte) in `Companies` gespeichert (`onPcsChanged`). Das schließt auch die in Stufe 1 genannte Lücke
  „die PC-Liste wächst nicht von selbst“. Ein älterer PC ohne `phone.pcs` antwortet mit einem Fehler: nichts ändert sich.
- **Berechtigung:** der lokale Netzwerkzugriff braucht unter iOS die Freigabe der Person: `NSLocalNetworkUsageDescription` steht in `project.yml` (der Text sagt, dass die App ohne sie weiter über den
  Treffpunkt geht). `NSBonjourServices` ist nicht nötig, die App sucht nichts im Netz, sie wählt nur die vom PC genannten Adressen. Bis die Person zustimmt, scheitert der erste Direktversuch
  (1,5 s) und der Tunnel springt ein; ATS lässt Klartext zu IP-Adressen und lokalen Namen zu (`NSAllowsLocalNetworking`), die Verschlüsselung trägt der Handshake selbst. Beides ist **nur auf einem
  Gerät zu prüfen**.
- **Nicht wie Android:** der Direktweg setzt wie dort den Treffpunkt voraus (Präsenz und PC-Liste kommen von dort): ein reines LAN ohne Internet reicht nicht.

## Wecken eines geschlossenen PCs (aus `relay/Wake.java`)

Die Seite schickt `{t:'wake', id, key, name}` (Einstellungen › Geräte, wenn kein PC antwortet); die App sucht den Wecker des PCs (sein eigener Schlüssel, `findable` am Treffpunkt) unter seiner Remote ID,
schickt **eine** versiegelte Anfrage `{op:'wake', at, nonce, sig}` – `sig` ist die Ed25519-Signatur des Handy-Schlüssels über `wf-wake-v1|<Wecker-Fingerabdruck>|<Wecker-Box>|<at>|<nonce>`, Byte für Byte
`wakeText` des Desktops (Vektor in `WakeTests`, derselbe wie in Androids `WakeTest.java` und `phone-wake.test.ts`) – und meldet der Seite `woken` mit oder ohne Fehlersatz. Das geht **nur im Vordergrund**
(der Treffpunkt-Socket lebt nur dort) und nur auf Wunsch der Person; die App weckt nichts von selbst. Dass ein echter geschlossener PC davon aufwacht, belegt nur ein echtes Handy mit einem echten PC.

**Was ohne Hintergrund nicht geht:** iOS hält keine Dauerverbindung; im Hintergrund sind die Sockets weg. Der PC kann das Handy also nicht „anrufen“ – bei jedem Vordergrundwechsel verbindet die App
sofort neu (`check()`), das ist alles, was ohne APNs geht. Alles, was das Handy von sich aus **melden** soll (Antwort der KI, fällige To-dos, ein Anruf, eine Frage), braucht APNs.

## Benachrichtigungen – was jetzt geht und was APNs braucht

Gebaut (ohne Apple-Konto, mit Fakes getestet): `Notices` (Core) trifft dieselben Entscheidungen wie der Service Worker des PCs (`sw-notify.ts`, `due-notice.ts`, `badge.ts`): Nutzlast `{title, body, url, tag, kind, silent, id,
clear, ring}`; eine Mitteilung je `tag` (die neuere ersetzt die ältere); dieselbe `id` noch einmal wird leise ersetzt, mit der neuesten Vorschau; Chat-Mitteilungen zählen gebündelte Nachrichten; fällige To-dos
(`kind: 'todo'`, „Due: …“) fallen zu **einer** Mitteilung unter `due` zusammen („3 to-dos due“) und schließen sich nach 6 s – nur der Zeitgeber der eigenen Mitteilung; `clear` schließt einen `tag`; der Badge ist die
Summe. `Notifier` + `SystemNoticeCenter` (App) zeigen das als **lokale Benachrichtigungen** (`UNUserNotificationCenter`, Kennung = `tag`, `threadIdentifier = tag`, Delegate zeigt auch im Vordergrund), ein Tippen
bringt die Seite per Hash an die Stelle. **„KI fragt, Person tippt einmal“:** eine Mitteilung mit `ask`/`buttons` (Vorschlag, nicht in der Nutzlast des PCs) bekommt eine Kategorie mit Aktionen ✓ ✕ oder den Beschriftungen
der KI (höchstens 4; iOS zeigt nicht mehr); die Antwort (`yes`/`no`/Beschriftung wie `PhoneSayAnswer`) geht als `notice.answer` an die Seite – die App öffnet sich dabei (`.foreground`), weil sie sonst keine Verbindung hat.
Keine Abfrage beim Start: `notify.enable` (Seite, Vorschlag) oder das Startargument `-AutarkNotifyDemo` für einen Gerätetest fragt einmal und zeigt zwei Beispiel-Mitteilungen.

`PushRegistration` (Core) ist die Schnittstelle für APNs: Erlaubnis → `registerForRemoteNotifications` → Token (hex, Umgebung `sandbox`/`production`, Bundle-ID) → **Senke** (`PushSink`) → Wiederholung bei Vordergrundwechsel,
bis die Senke ihn nahm; Vergessen meldet „kein Token mehr“. Die Senke der App (`PagePushSink`) schickt `{t:'push.token', token, env, bundle, platform:'apns'}` über den vorhandenen Port an die Seite (jeder neuen Seite nachgeliefert).
`Info.plist` trägt `AutarkPushEnabled: false`: solange der Schalter aus ist, fragt nichts und registriert nichts.

**Was fehlt und eine Entscheidung braucht (Konrad/Felix):** (1) das **Apple Developer Program** (Stanislaus, 99 USD/Jahr), die Push-Berechtigung `aps-environment` im signierten Profil und – für Anrufe – `com.apple.developer.usernotifications.time-sensitive`;
(2) **wer APNs sendet.** Die PCs sprechen heute nur Web Push (VAPID, `runtime/pwa/push.ts`) – eine `WKWebView`-App bekommt das nicht. APNs verlangt einen Schlüssel (.p8) des Entwicklerkontos, den ein PC der Nutzer nicht halten darf:
es braucht einen kleinen Server (am ehesten der Treffpunkt, `services/remote-relay`), dem der PC „diese Mitteilung an dieses Gerät“ meldet (der Treffpunkt kennt die Geräteschlüssel); (3) auf dem PC einen Ort für das Token
(Vorschlag: `phone.pushToken {token, env, bundle}`, an die Geräte-Zeile des Handys; `phone.forget` löscht es) und die Seite, die `push.token` weiterreicht; (4) `UIBackgroundModes: remote-notification` und ein stilles `clear`, damit gelesene
Chats ihre Mitteilung auch ohne App verlieren. Nichts davon ist gebaut oder auf einem Gerät geprüft.

## Welle 2 – Live Activity, Dynamic Island, Schnellzugriffe (21.11.2026)

Das Gegenstück zur Android-Blase („<Agent> is using this phone“, Pause, ✕, Zeile, Frage mit ✓/✕ oder eigenen Knöpfen) ist auf dem iPhone eine **Live Activity**: auf dem Sperrbildschirm als Banner, in der **Dynamic Island** als kompakte, minimale und erweiterte Ansicht. Der gemeinsame Vertrag mit den PC-Teilen steht in `workspace/apple-plattformen/IPHONE-WELLE2.md`.

**Zustand (Kern, `LiveState`).** Er besteht aus genau den sieben Schlüsseln des Vertrags `{job, by, line, ask, buttons, state, at}` mit den Grenzen von Android: Zeile 120 Zeichen, höchstens 8 Knöpfe zu je 40 Zeichen, Name 60, Lauf 64. Das Lesen ist nachsichtig, weil ein Push Schlüssel weglassen darf. Die ActivityKit-Attribute heißen **`AutarkAgentActivityAttributes`** `{device}`, denselben Namen nennt der Start-Push des PCs (`attributes-type`).

**Antworten (Kern, `PhoneUseResponder`, `UseRules`).** Die Regeln sind Wort für Wort von Android übernommen (`UseState.java`, `SayChoices.java`). Die App beantwortet nur `say` und `done`, alles andere mit `bad_request` „Unknown step …“, weil auf dem iPhone WebDriverAgent vom PC aus tippt (Teil D1).
- `say` ohne Frage antwortet sofort `{ok:true}`.
- `say` mit `ask` oder Knöpfen wartet auf ✓ (`yes`), ✕ (`no`) oder ein Label. Nach 60 s ohne Antwort gilt `none`. Bis dahin hält die Frage die folgenden Schritte an.
- Pause, Weiter und Stopp gehen als **`phoneUse.control {job, action}`** an den PC.
- Stopp beantwortet die wartende Frage und alle Schritte in der Schlange mit `ended`. Schritte eines beendeten Laufs werden abgewiesen.
- `done` beendet die Aktivität. Sie bleibt dann noch 8 s mit „Done“ stehen.
- Kommt eine Frage per Push und tippt die Person, bevor die App verbunden ist, wird der Tipp gemerkt. Er beantwortet die Frage, sobald der PC sie mit derselben id erneut schickt (60 s lang).

**Eigener Socket (Kern, `UseLink`, Android-Vorbild `phoneuse/UseLink.java`).**
- Er nutzt `/ws` über den lokalen Eingang, mit Gate-Cookie (`WebSocketOptions.headers`) und dem Token des Handys. Damit erreicht er immer den PC der Seite, direkt oder über den Tunnel.
- Reihenfolge: Hallo, `events.subscribe ['system']`, dann **`phoneUse.attach {model, screen, ready:false, platform:'ios', steps:['say','done']}`**.
- Er empfängt nur `phoneUse.request` dieses Geräts und antwortet mit `phoneUse.reply`. Über denselben Socket laufen die eigenen Aufrufe der App (`call`/`request`).
- Wartezeiten zwischen Verbindungsversuchen wie Android: 2 s bis 60 s.

**Token (Kern, `LiveTokens`).** Die App meldet **`phone.liveToken`** mit `{kind:'start'|'activity', token, env, bundle, job?}`. `token:null` vergisst einen Token. Jeder Token geht einmal raus, bis der PC ihn annimmt, und nur neu, wenn er sich ändert.

**App (`App/Quick/LiveController`, `Shared/LiveViews`, `Shared/LiveIntents`, `Widgets/AutarkWidgets`).** Pro PC-Lauf gibt es eine Aktivität. Ein neuer Lauf ersetzt die alte, `ended` schließt sie nach 8 s. Die Knöpfe sind `LiveActivityIntent`s (`LiveAnswerIntent`, `LiveControlIntent`); iOS führt sie im Prozess der App aus und startet die App dafür bei Bedarf im Hintergrund. Push-Token, Push-to-Start und die Übernahme per Push gestarteter Aktivitäten sind gebaut, aber nur mit `AutarkPushEnabled` an. Der Schalter ist aus, weil das bezahlte Konto und `aps-environment` fehlen. Das Startargument `-AutarkLiveDemo working|asking|buttons|paused|ended|two` zeigt ein Beispiel ohne PC; `two` startet zwei Läufe (die minimale Island-Ansicht erschien damit im Simulator nicht).

**Schnellzugriffe.**
- **App Intents** (unter „Autark“ in Kurzbefehle, Action-Taste, Zurücktippen, Spotlight, Siri; `AutarkShortcuts`):
  - „Screenshot an Autark senden“: nimmt ein Bild entgegen, ohne Bild den neuesten Screenshot der Mediathek.
  - „Antwort an Autark senden“.
  - „Diktat an Autark“: öffnet die App.
  - „Autark öffnen“: mit einem Chat oder auf Heute.
  
  Der Chat ist jeweils ein Parameter (`ChatEntity` aus `chats.list`). Die sendenden Intents laufen ohne App-Fenster: `QuickCenter` startet die Verbindung, wartet bis 20 s auf den PC und sendet mit `files.upload` (bis 2 MiB, darüber `files.uploadChunk` in 2-MiB-Stücken) und `messages.send {conversationId, body, attachments, clientId}`.
- **Steuerzentrale** (iOS 18, `ControlWidget`): „Autark öffnen“, „Screenshot senden“ (öffnet die App und sendet den neuesten Screenshot in den letzten Chat) und „Diktat“.
- **Sperrbildschirm-Widgets**: rund öffnet es die App, breit hat es die Knöpfe „Shot“ und „Diktat“.
- **Share-Extension** `AutarkShare` für Bilder, Text und Links: Chat wählen, eine Zeile dazu, „Send“. Sie legt den Beitrag in die App Group `group.com.teydralab.autark` (`ShareInbox`), und die App sendet ihn, sobald ihr Socket steht.
- **Diktat**: Die App nimmt auf (AAC). Der PC schreibt es mit (`voice.transcribe`), der Text geht als diktierte Nachricht (`speech:{source:'endpoint'}`) in den Chat. Kann der PC nicht transkribieren, geht die Aufnahme selbst.
- **Links**: `autark://open`, `autark://chat/<id>`, `autark://dictate`, `autark://shot` (fragt vor dem Senden nach: jede App und jede Webseite kann den Link öffnen).

**Ziele.** `AutarkWidgets` (Widget-Erweiterung, **iOS 18**: eine WidgetBundle mit `#available` stürzt unter iOS 17 ab, Apple-Forum 759670/762688) und `AutarkShare` (Share-Extension, iOS 17) liegen in `Autark.app/PlugIns`. Unter iOS 17 läuft die App ohne Live Activity, Widgets und Steuerelemente.

**Belege (21.11.2026).**
- Linux-Container (`ios-linux.yml`, Swift 6.4.3): **150 Tests, 1 übersprungen, 0 Fehler**, dreimal hintereinander (Lauf 44941600401). Neu sind 18 Tests in `LiveTests`: Vertrags-JSON, Grenzen, Android-Regeln, Responder (Frage, eigene Knöpfe, `none` nach 60 s, Pause/Weiter/Stopp, `done`, früher Tipp), `UseLink` gegen einen falschen PC (Hallo/Subscribe/Attach, Cookie, nur eigene Anfragen, Aufrufe, Fehler, Neuverbindung, Antworten über den Socket), `phone.liveToken`, Chatliste, Upload in Stücken, Nachricht, Share-Ablage.
- macOS-Lauf (Xcode 26.3, iPhone 17 Pro, iOS 26.2, ohne Signatur): alle Ziele gebaut (App, `AutarkWidgets.appex` mit `com.apple.widgetkit-extension` und MinimumOSVersion 18.0, `AutarkShare.appex` mit `com.apple.share-services`). Im Simulator liefen **38 Tests, 0 Fehler**: `LiveRenderTests`, `LiveTests`, `AppModelTests`, `PageBridgeTests`, `NotifierTests`; die Kern-Tests laufen vollständig unter Linux. `LiveRenderTests` rendert die Ansichten mit `ImageRenderer` zu PNG (`w2-*-rendered.png`). Das sind die eigenen Ansichten der App, **kein Bild des Systems**.
- **Echte Simulator-Bilder** (Läufe 44941600453 und 44942711486, `xcrun simctl io … screenshot`): die Live Activity auf dem gesperrten Bildschirm als Frage mit ✓/✕, mit eigenen Knöpfen (Mo 9:00 / Di 14:30 / Später / ✕) und arbeitend mit Pause/Stop, darunter beim ersten Mal die Systemfrage „Allow Live Activities from Autark?“; die kompakte Dynamic Island über den Einstellungen (grün „arbeitet“, blau „fragt“). Nicht im Simulator belegt: die erweiterte Island (braucht ein langes Drücken) und die minimale (zwei Aktivitäten zeigten nur eine) – beide nur gerendert. Bilder: Artefakt `ios-screenshots`, `workspace/apple-plattformen/screens/welle2`.

**Nur am Gerät oder mit Konto zu belegen.**
- Knöpfe der Live Activity auf dem Sperrbildschirm und in der Island: Läuft `perform` in der App, auch wenn die App beendet war?
- Antwort an einen echten PC.
- Live-Activity-Push (Konto, `aps-environment`, Teil D2): Start per Push, Token, Updates, Ende.
- Steuerelemente in der Steuerzentrale: Öffnen sie die App wirklich (`openAppWhenRun` in der Erweiterung)?
- Sperrbildschirm-Widgets mit Knöpfen.
- Action-Taste und Zurücktippen mit dem Kurzbefehl.
- Intent im Hintergrund: Reichen 30 s, um die Verbindung aufzubauen und zu senden?
- Fotomediathek-Freigabe für „neuester Screenshot“.
- Share-Extension mit echter App Group (nur signiert).
- Diktat mit echtem Mikrofon und `voice.transcribe`.
- Diktat vom Sperrbildschirm (`AudioRecordingIntent`) ist **nicht gebaut**, siehe `PLAN.md` › Teil S.
- Ein fertiger iCloud-Link für den Kurzbefehl entsteht erst auf einem Gerät (`KURZBEFEHL-ANLEITUNG.md`).

## iPhone use: der Autark-Runner (Punkt 17, 21.11.2026)

Damit der PC ein iPhone sieht und bedient (Bildschirmfoto, Elementbaum, Tippen, Wischen mit Fingerkurve, Text, Tasten, Öffnen), gibt es ein eigenes
XCUITest-Ziel: **`AutarkRunnerUITests`** im eigenen Schema **`AutarkRunner`**, ohne Ziel-App (es bedient, was vorn ist). Der PC startet es über go-ios
(`ios runtest`), gibt ein frisches Lauf-Token und einen Port mit, und spricht dann das eigene Protokoll **`workspace/apple-plattformen/PROTOKOLL-RUNNER.md` v1**
(Vorspann `ATKRUN1\n`, Rahmen `u32be jsonLen | u32be binLen | JSON | Binäranhang`, beidseitiger HMAC-Nachweis). Entwurf und Begründungen:
`workspace/apple-plattformen/RUNNER-DESIGN.md`. Kein Code, keine Namen, Pfade oder Begriffe aus Appiums WebDriverAgent (Entscheidung Stanislaus, 21.11.2026).

| Ort | Inhalt |
|---|---|
| `Autark/Core/Runner/` | plattformneutraler Kern, auch im Framework `AutarkCore` und unter Linux getestet: `RunnerWire` (Vorspann, Rahmen, Grenzen, Nachweis, Umgebung, Zeitgrenzen), `RunnerRequest` (jede Operation mit ihren Feldprüfungen, Fehlerliste, Antwortformen, `RunnerScreen`), `RunnerTree` (Element → flache Knotenliste, Abschneiden, Passwortfelder ohne Wert, zweite Wurzel für Systemdialoge, Elementarten-Tabelle; `RunnerFront`: welche App vorn ist), `RunnerLock` (gesperrt ja/nein/unbekannt aus den Signalen, welche Operationen die Sperre ablehnt, Code-Eingabe im SpringBoard-Baum sprachunabhängig erkennen), `RunnerSwipe` (gerade Linie als Rückfall, Bildschirmprüfung, Referenzkurve „glide“ wie `pointer-motion.ts`), `RunnerSession`/`RunnerHub` (Zustandsautomat je Verbindung: Anmeldung, `busy`, `not_ready`, 5 s Anmeldefrist, 60 s Stille; über alle Verbindungen: eine angemeldete, höchstens zwei unangemeldete, 5 falsche Nachweise, Leerlauf-Ende) |
| `Runner/AutarkRunnerUITests.swift` | der eine Test `testServe()`: liest `AUTARK_RUNNER_TOKEN`, `AUTARK_RUNNER_PORT`, `AUTARK_RUNNER_IDLE_S` (`AUTARK_RUNNER_DIAG=1` nur fürs CI-Protokoll), hält die Hauptschleife; `record(_:)` macht XCTest-Befunde während einer Operation zu deren Fehlercode |
| `Runner/RunnerServer.swift` | `NWListener` nur auf `127.0.0.1` (und `::1`, wenn möglich), nur auf dem gegebenen Port, reicht Operationen mit ihrer Zeitgrenze an den Haupt-Thread, beendet sich bei `end`, Leerlauf, 5 falschen Nachweisen; hängt der Haupt-Thread 60 s, `exit(1)` |
| `Runner/RunnerOps.swift` | die Operationen gegen XCUIAutomation (öffentliche API); vor jeder Eingabe die Sperrprüfung (`locked`) |
| `Runner/Private/RunnerPrivate.{h,m}` | `@try/@catch` um XCTest-Aufrufe; Zeigerpfad der XCTest-Laufzeit (`XCPointerEventPath`, `XCSynthesizedEventRecord`) nur per `NSClassFromString`/`instancesRespondToSelector:`, kein Link gegen private Symbole – fehlt etwas, wischt der Runner gerade (`"mode":"line"`); Sperrsignale: Darwin-Benachrichtigung `com.apple.springboard.lockstate` (öffentliche notify-API) und ein `XCUIDevice`-Getter nur, wenn er per Name und Signatur gefunden wird |
| `Tools/runner-name.sh` | setzt nach jedem Bau `CFBundleDisplayName` = „Autark Control“ in der Hülle (Xcode baut sie aus seiner XCTRunner-Vorlage, keine Build-Einstellung erreicht sie) |
| `Tools/runner-probe.py` | Referenz-Client (Teil F), nur Python-Standardbibliothek, mit `--selftest` |
| `Tools/runner-proof.py` | der CI-Beweis: fährt den echten Runner im Simulator durch jede Operation und jeden Fehlercode, den der Simulator zeigen kann; App vorn nach `open`/Home/Link; Name auf dem Home-Bildschirm; mit `--sim-udid` die Sperr-Runde (sperren per Cmd-L, Abgleich mit `notifyutil` im Simulator, `locked`-Ablehnungen, Home auf dem Sperrbildschirm, Entsperren, Mitteilungszentrale ist keine Sperre) |
| `.github/workflows/runner.yml` | macOS-Lauf, **nur** per `workflow_dispatch` oder mit dem Wort `runner` in eckigen Klammern im Commit-Text (zehnfach gezählte Minuten) |

**Start am iPhone** (PC-Teil, `RUNNER-DESIGN.md` 4.2): `ios runtest --bundle-id=com.teydralab.autark.runner.xctrunner --test-runner-bundle-id=com.teydralab.autark.runner.xctrunner --xctest-config=AutarkRunnerUITests.xctest --test-to-run=AutarkRunnerUITests/testServe --env=AUTARK_RUNNER_TOKEN=<64 Hex> --env=AUTARK_RUNNER_PORT=<49152–65535> --udid=<udid>`, dazu `ios forward <lokal> <Port>`; nie `-v`, `-t` oder `--log-output`.
**Im Simulator / CI:** `xcodebuild build-for-testing -scheme AutarkRunner …`, dann `TEST_RUNNER_AUTARK_RUNNER_TOKEN=… TEST_RUNNER_AUTARK_RUNNER_PORT=… xcodebuild test-without-building -only-testing:AutarkRunnerUITests/AutarkRunnerUITests/testServe …` im Hintergrund und `python3 Tools/runner-proof.py --port … --token … --out …`.

**Was der Simulator belegt** (macOS-Lauf [44951831619](https://github.com/teydra/proactive-agent-runtime/actions/runs/44951831619), Commit `99927f0`, iPhone 16 Pro mit iOS 18.6, Xcode 16.4 für den Simulator, 26.3 fürs Gerätebündel, 9 Min 22 s; 38 von 40 Pflichtprüfungen, Bilder selbst angesehen):

- Das Ziel baut ohne Ziel-App (Hülle `com.teydralab.autark.runner.xctrunner`, Test-Bündel `com.teydralab.autark.runner`), startet mit `TEST_RUNNER_AUTARK_RUNNER_*` und lauscht nur auf `127.0.0.1`/`::1` des gegebenen Ports.
- Anmeldung: Vorspann, `hello`/`auth` mit beidseitigem HMAC; ein HTTP-Client wird ohne ein Byte geschlossen, Operationen vor `auth` → `unauthorized`, falscher Nachweis → `auth_failed`, `v: 0` → `unsupported_version [1]`, ein Client mit anderem Token lehnt den Nachweis des Runners ab.
- `state` (47 ms), `screenshot` PNG 1206×2622 px für 402×874 pt (genau 3,000 px/pt auf beiden Achsen, 2,7 MB roh, 172 ms) und JPEG mit `maxEdge` 800, `open` mit Bundle-ID (Einstellungen, 5,7 s beim ersten Start), `tree` (155 Knoten, 0,8 s), `tap` auf „General“ (die Seite öffnet sich), `swipe` mit 12 Punkten **über den Zeigerpfad** (`"mode":"path"`, die Seite scrollt bis zu ihrem Ende), Zurück-Knopf aus dem Baum, `text` „Grüße“ und „ 👋“ ins Suchfeld der Einstellungen (Baum liest „Grüße 👋“ zurück), `\u0008` löscht, `button home`, `open` mit `https://example.com` (Safari zeigt die Seite), `busy`, `out_of_bounds`, `bad_request` (`tel:`), `unsupported` (Lautstärke im Simulator), `unknown_op`, `app_not_found` (`tree` einer fremden Bundle-ID), `truncated`, `ping`, eine neuere angemeldete Verbindung schließt die ältere, `end` beendet den Test (xcodebuild Rückgabe 0) und schließt den Port, **Leerlauf-Ende** nach 30 s ohne Verbindung (Test endet mit 0).
- Die Zeigerpfad-Klassen der XCTest-Laufzeit samt Methoden (`initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`, `liftUpAtOffset:`, `initWithName:interfaceOrientation:`, `addPointerEventPath:`, `synthesizeWithError:`) stehen im Protokoll des ersten Laufs (44950636780).

**Was der Simulator widerlegt hat und wie es jetzt gebaut ist:**

- `NWListener` mit `requiredInterfaceType = .loopback` und `acceptLocalOnly` setzte im Simulator **jede** Verbindung zurück (Lauf 44950636780). Der Runner lauscht deshalb mit einem BSD-Socket, gebunden an `127.0.0.1` (und `::1`); von außen ist er damit schon durch die Adresse unerreichbar.
- `UIScreen` meldet im Runner-Prozess 320×480 (seine Hülle hat keinen Startbildschirm, iOS fährt sie im Kompatibilitätsmodus). Die Maße kommen deshalb aus dem Rahmen von SpringBoard und den Pixeln des Bildschirmfotos.
- **App im Vordergrund:** `XCUIApplication.state` ist dafür nicht verlässlich – nach der Home-Taste meldete Einstellungen weiter „vorn“, Safari (über einen Link geöffnet, sichtbar) nie. Seit Commit `e47dddb` traut `RunnerFront` zuerst den eigenen Aktionen (`open` → diese App, Home → SpringBoard, Link → unbekannt) und fragt `state` nur noch Apps, die nicht durch eine eigene Aktion nach hinten gingen (Linux-Tests, **nicht mehr im Simulator gelaufen**). Was weiter niemand sieht: ein Tipp, der die App wechselt (Link in einer App, Symbol auf dem Home-Bildschirm) – dann bleibt `front` die App davor, bis der PC eine App öffnet. Eine verlässliche Abfrage gibt es nur über eine nicht dokumentierte Stelle (Entscheidung wie beim Zeigerpfad, `RUNNER-DESIGN.md` Abschnitt 8).
- `button action` dauerte im Simulator 5,8 s (über der Grenze von 5 s); die Fähigkeit `button.action` gibt es deshalb nur noch auf dem Gerät. `focused` setzt iOS nie (`hasFocus` blieb bei offenem Suchfeld leer); für „Tastatur offen“ ist `state.keyboard` verlässlich.

**Name, Sperre, App vorn (Konrad #53, 21.11.2026; Branch `ci/runner-2-20261121`, Commit `f045a89`) – gebaut, Kern unter Linux getestet, macOS-Lauf steht noch aus** (GitHub startete am 21.11. 23:12 keine Jobs mehr: Zahlung/Ausgabenlimit des Kontos; der Linux-Lauf 44955528913 lief deshalb nicht, auch die neuen Linux-Tests sind noch nicht gelaufen):

- **Name:** Die Hülle heißt auf dem Home-Bildschirm „Autark Control“ (`CFBundleDisplayName`, App-Sprache Englisch); Bundle-IDs bleiben (`com.teydralab.autark.runner.xctrunner`, `com.teydralab.autark.runner`). Xcode kopiert die Hülle aus seiner Vorlage `XCTRunner.app` und ersetzt nur Bundle-ID und `CFBundleName` (Bauprotokoll, `CopyPlistFile`); deshalb setzt `Tools/runner-name.sh` den Namen nach dem Bauen – im CI für den Simulator und fürs Gerätebündel. Wer den Runner anders baut oder signiert, muss das Skript vor dem Signieren laufen lassen. Apples Signatur der Hülle passte schon vorher nicht mehr zum Info.plist (Xcode schreibt die Bundle-ID hinein); der PC signiert ohnehin neu.
- **Sperre:** `state.locked` ist `true`/`false`, sobald eine Quelle lesbar ist (dann steht `lock_state` in `caps`): zuerst der Zustand der Darwin-Benachrichtigung `com.apple.springboard.lockstate` (öffentliche notify-API aus `notify.h`, keine Sonderrechte), dazu ein `XCUIDevice`-Getter (`isScreenLocked`, `screenLocked` oder `isLocked`), aber nur, wenn die XCTest-Laufzeit ihn mit BOOL-Rückgabe hat. Zusätzlich sucht der Runner vor jedem `tap`, `swipe` und `text` im SpringBoard-Baum eine **Code-Eingabe** – ein sichtbares Passwortfeld oder eine Zahlentastatur mit allen zehn Ziffern (Element-Typ und Ziffer, keine Sprache) – und zählt sie immer als gesperrt; ohne lesbare Quelle ist `locked` dann `true`, sonst `null`. Gesperrt: `front` ist `com.apple.springboard`, `tree` ohne `bundle` zeigt SpringBoard (den Sperrbildschirm), jede Eingabe außer `button home`/`volume_*` antwortet `locked` und wird **nicht** ausgeführt; `state`, `screenshot`, `tree` gehen weiter. Der Runner tippt nie, um die Sperre zu prüfen.
- **App vorn:** `runner-proof.py` prüft jetzt `state` nach `open` (Einstellungen), nach Home (SpringBoard), nach einem Link (unbekannt oder Safari, nie die App dahinter), nach erneutem `open` und erneutem Home.
- Was der eine macOS-Lauf belegen soll: Sperre (Cmd-L) → `locked: true`, deckungsgleich mit `notifyutil -g com.apple.springboard.lockstate` im Simulator; `tap`/`text`/`swipe`/`open` → `locked`; Home auf dem Sperrbildschirm geht; entsperrt → `false`; heruntergezogene Mitteilungszentrale → `false`; Icon „Autark Control“ im SpringBoard-Baum und auf einem Bild; `CFBundleDisplayName` im Gerätebündel. Die Diagnose (`AUTARK_RUNNER_DIAG=1`) schreibt dazu alle Methoden von `XCUIDevice` und alle sperrbezogenen Selektoren der XC-Klassen ins Protokoll und die Dauer der Code-Eingabe-Prüfung.

**Gerätebündel** (Artefakt `Autark-Runner-unsigned`, 5,6 MB, nach dem Herunterladen gelöscht; Kopie unter `workspace/apple-plattformen/runner-proof-20261121/run2/`): `Payload/AutarkRunnerUITests-Runner.app`, arm64, SDK iphoneos 26.2, Hülle mit Apples XCTRunner-Signatur (muss neu signiert werden), `PlugIns/AutarkRunnerUITests.xctest` (iOS 17.0), **mit** `Frameworks/` (XCTest, XCUIAutomation, Testing, … – Xcode 26 legt sie bei; beim Signieren mit signieren oder entfernen, am Gerät prüfen), ohne `.dSYM`.

**Nur am Gerät belegbar** (bezahltes Konto, signierter Runner): `ios runtest` mit `--env` unter Windows über den Userspace-Tunnel; ob der Loopback-Port über `ios forward` (usbmux) erreichbar ist (IPv4 oder IPv6); Signieren und Installieren; Vertrauen ins Entwicklerprofil, Code beim ersten UI-Test, Entwicklermodus; Lebensdauer des Testprozesses, Anruf; **Sperre am Gerät**: ob der Runner-Prozess im Sandkasten des iPhones `com.apple.springboard.lockstate` lesen darf und ob der Wert mit Code und Face ID der Sperre folgt (liest er immer 0, meldet der Runner fälschlich `false` – dann bleibt nur die Code-Eingabe-Erkennung, und der PC muss selbst prüfen), ob die Code-Eingabe im SpringBoard-Baum als Zahlentastatur oder Passwortfeld erscheint, was Home auf dem Sperrbildschirm mit Code bewirkt (erwartet: Code-Eingabe bzw. Face ID, nie entsperrt), wie lange die Code-Eingabe-Prüfung vor jedem Tippen dauert; Lautstärke-, Aktions- und Kamerataste; Zeigerpfad mit der XCTest-Laufzeit des iPhones; Text in echten Apps; Querformat; Apple-Gerätetreiber und Firewall am PC.

## WebRTC – nicht portiert

`RtcWay`, `RtcPlan`, `PageRtc` und `WebRtc` (Android, F25) sind **nicht** portiert; `Rtc.swift` benennt nur die Schnittstelle (`RtcEngine`, `RtcPeer`, `RtcEvents`, wie `RtcEngine.java`), nichts nutzt sie. Wer es später baut: als Bibliothek
kommt ein Swift-Paket mit dem Google-libwebrtc-xcframework in Frage – die Community-Fassung **stasel/WebRTC** (Swift Package, binäres xcframework, ca. 25–30 MB je Architektur, BSD-ähnliche libwebrtc-Lizenz) oder ein eigener Bau
von Googles xcframework (viel Aufwand, kein Mac im Team: nur im CI). Aufwand: `RtcWay` (315 Zeilen Java: Signalisierung im Kanal, Datenkanal, der den Handshake erneut fährt), `RtcPlan` (51 Zeilen, rein, in einer Stunde portiert und getestet),
`PageRtc` (84 Zeilen) und der Anschluss an `PhoneConnection` – rund zwei Tage plus ein echtes Gerät, um zu sehen, ob WebRTC im Mobilnetz überhaupt vor dem Tunnel gewinnt. Dabei libwebrtc stumm schalten (kein Kandidat, keine Adresse, kein SDP im Log, wie `WebRtcConfig.SILENT`).
Ohne WebRTC läuft ein iPhone im Mobilnetz über den Tunnel und im WLAN direkt – das deckt den Alltag, WebRTC wäre nur der dritte Weg für „unterwegs ohne Tunnel-Umweg“.

## Bauen und testen

**CI (maßgeblich):** `.github/workflows/ios.yml` (macOS-15-Runner, Xcode 26.3) auf Branch `ci/ios-*` – **ein Push startet den Lauf nur, wenn sein letzter Commit-Text `[macos]` enthält** (private macOS-Minuten zählen zehnfach; auch ein bloßes Erwähnen des Wortes startet ihn) –, `workflow_dispatch` geht auch:
`xcodegen generate` → `xcodebuild build` (Simulator, `CODE_SIGNING_ALLOWED=NO`) → `xcodebuild test` → App starten und Bildschirmfotos
(`xcrun simctl io … screenshot`) → Artefakte `ios-screenshots`, `ios-test-logs` (Logs + `.xcresult`). Private macOS-Minuten zählen zehnfach: ein Job, nichts wird archiviert. Seit Welle 2 laufen im Simulator nur die App-Tests (`AppModelTests`, `PageBridgeTests`, `NotifierTests`, `LiveRenderTests`) und `LiveTests` (`-only-testing`, rund 1,5 Minuten statt 7,5); den ganzen Kern prüft der Linux-Container. Der Schritt mit den Bildschirmfotos zeigt vorher die Live Activity auf dem Sperrbildschirm und in der Island (`-AutarkLiveDemo`).

**Lokal ohne Mac (Kern + Prüfung der öffentlichen Schnittstelle, Linux/WSL):** Swift-Toolchain installieren, dann in `apps/ios`:
`swift test` (Kern-Tests; `Package.swift` zieht `swift-crypto` nur unter Linux). Der Stand vom 21.11.2026 (Stufe 2): 132 Tests (einer davon der Interop-Test, übersprungen ohne Gegenstelle), 131 grün in 26 s – dreimal hintereinander im Linux-Container des CI (`ios-linux.yml`, Swift 6.4.3). Stufe 1 hatte 87 Tests; neu sind `DirectTests` (URL der Adressen, Speicherung, `Route`, `DirectPipe` mit echtem Handshake, `PhoneConnection` direkt/Rückfall/Hochstufen/PC-Liste/toter Socket, `PcList`), `WakeTests` (Vektor + Wecker am Treffpunkt) und `NoticeTests` (Entscheidungen und `PushRegistration` mit Fakes); `ios-linux.yml` läuft bei jedem Push, der Kern oder seine Tests ändert. Im Simulator (macOS-Lauf vom 21.11.2026, 13 Min 20 s): 149 Tests (1 übersprungen), 0 Fehler, darunter neu `NotifierTests` mit einem falschen Benachrichtigungszentrum; `AppModelTests` laufen dort wie vorher. Hinweis: die Unit-Tests laufen im Host `Autark.app`; unter XCTest (`XCTestConfigurationFilePath`) legt `AutarkApp` deshalb kein `SystemNoticeCenter`/`SystemPushPlatform` an – mit ihnen war der Seitentest des AppModel im Host-Prozess minutenlang langsam und lief in Zeitüberschreitung. Der Ed25519-Wecker-Vektor wird unter Apple (CryptoKit signiert zufällig) nur verifiziert, unter Linux (swift-crypto, deterministisch) Byte für Byte verglichen.

**Auf einem Mac:** `brew install xcodegen && cd apps/ios && xcodegen generate && open Autark.xcodeproj`.

**Testvektoren neu erzeugen** (nach Änderungen am Desktop-Protokoll): `node --experimental-strip-types apps/ios/Tools/gen-vectors.mjs <Quellbaum> apps/ios/Tests/CoreTests/DesktopVectors.swift`
(das Skript importiert `remote/sas.ts`, `devices/{pair-proof,handshake,channel,keys}.ts`, `rendezvous/seal.ts` und `services/remote-relay/src/protocol.ts` nur lesend;
der Quellbaum ist der private Desktop-Baum, im CI-Klon liegt er nicht).

**Gegen den echten PC-Code (Linux/WSL, nicht im CI):** `Tools/real-pc.mjs` startet den echten Treffpunkt (`services/remote-relay`) und als PC den echten Desktop-Code
(`relay-client.ts`, `remote/requests.ts` mit Rolle `phone`, `PhoneBridge`) mit einem kleinen HTTP-Server als Runtime-Port; `RealPcInteropTests` (übersprungen ohne die
Umgebungsvariablen `AUTARK_REAL_RELAY`, `AUTARK_REAL_REMOTE_ID`, `AUTARK_REAL_LOG`) koppelt den Swift-Kern damit per Remote ID, vergleicht den 4-stelligen Code, verbindet über einen echten Tunnel und
lädt Seite, 900-kB-Antwort und 700-kB-Upload durch den lokalen Eingang. `Tools/interop-linux.sh` und `Tools/check-linux.sh` sind die WSL-Helfer von Juri (Pfade dieses PCs). Unter Linux hat
URLSession keinen WebSocket (libcurl ohne WS), deshalb nutzt dieser Test `RawWebSocket.swift` (nur Tests) statt `URLSessionSocket`.

## Was die Tests belegen – und was nicht

Belegt (Linux **und** Simulator, siehe CI-Lauf):

- **Byte-Gleichheit mit dem Desktop**: Remote ID, `stable()`-JSON, Commitment, Transkript, 4-stelliger Code, MACs (`remote-wait`, `remote-accept`)
  – dieselben Vektoren wie `apps/android/test/RemotePairTest.java`, **und** dieselben Werte, die der echte Desktop-Code beim Erzeugen der Datei
  ausgegeben hat. Peer-Handshake `wf-peer-v1`: der echte `handshake.ts` lief mit festen Telefon-Schlüsseln; das Telefon erreicht dieselben beiden
  Sitzungsschlüssel, und die vom echten `SecureChannel` versiegelten Rahmen lassen sich öffnen bzw. sind Byte für Byte gleich. Treffpunkt-Versiegelung
  (`seal.ts`: Schlüssel, versiegelte Anfrage, Antwort, Tunnel-Textrahmen) und die vom Treffpunkt verlangten Signaturtexte.
- RFC-Vektoren (8032, 7748, 5869), `CodeChain` mit dem W4-Vektor der Android-Tests.
- Ein ganzer Weg **im Prozess** gegen Gegenstellen, die aus den Desktop-Quellen nachgebaut sind (nicht aus dem Swift-Code): Treffpunkt
  (`services/remote-relay`, Protokoll v1: Challenge, Hello, Ready, Presence, Find, Pair, Open, Tunnel-Rahmen), PC-Seite des Handshakes, PC-Seite der
  Kopplung (Ziel A, Rolle `phone`) und der Stream-Server (`phone.ts`). Darüber: Kopplung mit gleichem Code auf beiden Seiten, Annehmen/Ablehnen/Abbrechen,
  verfälschte Annahme und falsche PC-Schlüssel werden abgewiesen, Verbinden, Version des PCs, Wiederverbinden nach Treffpunkt-Abbruch und PC-Ausfall,
  Probe bei toter Leitung, PC-Wechsel bei `refused`/Auswahl, der lokale Eingang mit echten TCP-Clients (Gate-Cookie, große Antworten und Uploads im
  256-KiB-Fenster, 503 bei toter Leitung, Probe nach 4 s Stille).
- Im Simulator: die echte `WKWebView` lädt die Seite über den lokalen Eingang (das Gate-Cookie erreicht ihn wirklich, `isSecureContext` ist wahr,
  User-Agent), der `MessagePort`-Kanal funktioniert in beide Richtungen mit demselben `{t,…}`, ein iframe erreicht die App nicht; `AppModel` von der Eingabe der
  neun Ziffern bis zur Seite und zum zweiten Start mit gespeicherter Kopplung; Keychain-Speicher.

**Nicht geprüft (nur ein echtes Gerät/ein echter PC belegt es):**

- Kopplung und Betrieb gegen einen **echten PC** und den **echten Treffpunkt** aus der iOS-App; `URLSessionWebSocketTask` gegen `wss://telecoding-relay.onrender.com`
  (Zertifikat, Pings, Abbrüche im Mobilnetz); Verhalten von URLSession bei Netzwechsel/Flugmodus (die Tests ersetzen die Verbindung durch eine in-process).
- Der QR-Scanner (Simulator hat keine Kamera), die Kameraerlaubnis, Anruf-/Mikrofon-Seiten, Dateiauswahl.
- Hintergrund: iOS hält keine Dauerverbindung – im Hintergrund trennt iOS die Sockets; beim Zurückkehren (`scenePhase = .active`) und bei jedem Netzwechsel
  (`NWPathMonitor`) prüft die App die Verbindung sofort (`check()`), die Seite lädt ihre Daten neu (`resume`). **Benachrichtigungen vom PC kommen erst über APNs**
  (siehe „Benachrichtigungen“: Apple-Konto, Entitlement und ein Server, der APNs sendet – offene Entscheidung, Konrad/Felix).
- **Direktweg auf einem echten iPhone:** ob die Freigabe „Lokales Netzwerk“ (Text in `NSLocalNetworkUsageDescription`) erscheint und der erste Versuch danach klappt; ob `URLSessionWebSocketTask` ein
  `ws://` zu einer LAN-, Tailnet-(100.x), Router- oder IPv6-Adresse ohne weitere ATS-Ausnahme aufbaut (`NSAllowsLocalNetworking` deckt lokale Adressen; IP-Adressen sind von ATS ausgenommen – am Gerät zu bestätigen);
  ob 1,5 s zum Verbinden im echten WLAN reichen; der Wechsel WLAN ↔ Mobilnetz mit `NWPathMonitor` und die 2-s-Probe; dass die Seite danach wirklich weiterläuft (die Tests ersetzen Netz und PC durch Prozess-interne Gegenstellen aus den Desktop-Quellen).
- **Wecken:** dass ein echter geschlossener PC über den echten Treffpunkt aufwacht (die Signatur ist byte-gleich mit dem Desktop belegt, der Wecker im Test ist nachgebaut, nicht der echte `sleeper.ts`).
- **Benachrichtigungen:** alles am echten `UNUserNotificationCenter` (Anzeige, Ersetzen nach Kennung, Gruppierung, Badge, Aktionen ✓ ✕, Tippen auf dem Sperrbildschirm), die Freigabe-Abfrage, APNs (Token, Sandbox/Produktion, Zustellung, stilles `clear`).
- **Kaltstart mit gecachter Hülle (Felix' Nachfrage):** `offline.owner` erreicht die Seite nur, wenn die Seite beim Kaltstart ohne PC überhaupt aus ihrem Cache lädt – im Simulator ist nur geprüft, dass die App die Nachricht vor dem Laden und bei jedem Port sendet (`PageBridgeTests`/`AppModelTests`),
  nicht, dass eine gecachte Hülle (Service Worker/Offline-Cache der Seite in der `WKWebView` unter `http://127.0.0.1:<port>`) ohne Verbindung wirklich lädt. Das belegt nur ein echtes iPhone im Flugmodus.
- Universal Links (`https://openautark.com/pair/#<ID>` öffnet die App): braucht die signierte App mit „Associated Domains“ und die Datei
  `apple-app-site-association` auf der Website. Der Fallback `autark://pair/<ID>` ist in `Info.plist` eingetragen und im `AppModel`-Test geprüft, nicht auf dem Gerät.
- Ob `http://127.0.0.1:<port>` auf einem echten iPhone dieselbe Behandlung bekommt wie im Simulator (App Transport Security: `NSAllowsLocalNetworking`;
  Secure Context für Kamera/Mikrofon/Service Worker), Web-Speicher je Firma (die Firmen teilen den Host `127.0.0.1`; „Forget“ löscht den gesamten
  Web-Speicher der App, nicht nur den einer Firma).
- Keychain auf einem signierten Build: im unsignierten Simulator-Build fehlt die Keychain-Berechtigung, `KeychainStore` fällt dann (nur bei
  `errSecMissingEntitlement`) auf eine Datei im App-Ordner zurück (kein Backup, Schutz bis zum ersten Entsperren).

## Nicht portiert (Stand Welle 2)

WebRTC (`RtcWay`, `RtcPlan`, `PageRtc`, `WebRtc`: nur die Schnittstelle `Rtc.swift`), Handy-Bedienung **durch die App** (Androids `UseService`:
iOS erlaubt einer App nicht, andere Apps zu bedienen – auf dem iPhone tippt der eigene Runner vom PC aus, siehe „iPhone use: der Autark-Runner“; die App beantwortet seit Welle 2 nur `say`/`done` über ihren `UseLink`), Benachrichtigungen vom PC (APNs und der Server dazu),
Diktat vom Sperrbildschirm ohne Entsperren (`AudioRecordingIntent`, siehe Welle 2), Downloads aufs Handy, Handy-Stimme,
To-do-Blase, Feedback-Tour/-Bildschirmfoto/-Absturzbericht, Fotoleiste im Scanner (Android liest QR-Codes auch aus Bildern), Update-Zeile.

## Signieren und TestFlight (vorbereitet, aus)

Eigener Workflow `.github/workflows/testflight.yml`, startet nur von Hand (`workflow_dispatch`): ein Linux-Vorlauf prüft Schlüssel, App-Eintrag,
registriertes Gerät und die nächste Build-Nummer (`Tools/asc_preflight.py`, nur lesend), dann archiviert der macOS-Job einmal mit **automatischer
Signatur über einen App-Store-Connect-API-Schlüssel** (Rolle Admin, `-allowProvisioningUpdates`), exportiert mit Apples cloud-verwaltetem
Verteilungszertifikat und lädt per `altool` hoch. Keine Zertifikate oder Profile als Secrets, nur `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8_BASE64`. Die Schritte nach der Zahlung (Vereinbarungen, Team-ID, Schlüssel, Gerät, App-ID und App-Gruppe, App-Eintrag, Secrets, Start,
Ausfuhrkonformität, interne Tester) stehen in **[SIGNING.md](SIGNING.md)**, mit Quellen. Noch offen für den App Store: Associated Domains
(`applinks:openautark.com`), App-Store-Datenschutzangaben (Kamera, Mikrofon).
Das App-Symbol ist das Autark-Zeichen (`apps/website/public/img/brand/autark-app-icon-1024.png`, die Ecken mit der Kachelfarbe gefüllt: App-Store-Symbole haben keinen Alphakanal).
