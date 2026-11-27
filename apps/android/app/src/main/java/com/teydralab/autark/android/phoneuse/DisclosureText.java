// Owns: the wording of the one prominent disclosure that stands before phone use may be switched on (Google Play's
// AccessibilityService policy: inside the app, what is accessed, how it is used and shared, an affirmative choice) –
// English and German, chosen by the phone's language. Pure Java, so a host test pins the facts it must name.
// Never: Android classes, or a claim the code does not keep (nothing is read in the background; password text is not read;
// the content goes to the person's own PC, whose AI model may be an online service they chose there).
package com.teydralab.autark.android.phoneuse;

public final class DisclosureText {
    private DisclosureText() {}

    public static String title(boolean german) {
        return german ? "Soll die KI dieses Handy bedienen dürfen?" : "Let the AI use this phone?";
    }

    public static String body(boolean german) {
        return german
                ? "Autark kann die KI Ihrer eigenen Firma dieses Handy für Sie bedienen lassen – zum Beispiel eine App öffnen, den Bildschirm lesen, tippen, wischen und schreiben. Das passiert nur, wenn Sie ihr am PC oder im Chat eine Aufgabe geben, die dieses Handy braucht.\n\n"
                + "Dafür nutzt Autark die Bedienungshilfen-Schnittstelle von Android (AccessibilityService API). Sobald Sie sie einschalten, kann Autark auf Anfrage:\n"
                + "• alles lesen, was auf dem Bildschirm steht: Texte, Schaltflächen und Feldnamen der offenen App (der Text von Passwortfeldern wird nicht gelesen)\n"
                + "• die Benachrichtigungsleiste öffnen und lesen – also auch private Nachrichten, E-Mails und Bankmeldungen, die dort stehen\n"
                + "• Bildschirmfotos aufnehmen, die alles zeigen, was gerade zu sehen ist\n"
                + "• tippen, wischen, Text eingeben sowie Apps und Links öffnen\n\n"
                + "Wohin die Daten gehen: Was Autark liest, geht nur über die verschlüsselte Verbindung an Ihren eigenen PC. Dort sieht es das KI-Modell, das Sie dort gewählt haben, um den nächsten Schritt zu wählen – ist das ein Online-Modell, bekommt dessen Anbieter diese Inhalte, auch private, so wie bei jeder anderen Aufgabe an diese KI. Davon geht nichts an Teydra Lab; es gibt keine Werbung und keinen Verkauf von Daten. Gezählt wird nur eine anonyme Zahl, wie oft Autark benutzt wird (Plattform und Stunde, nie Inhalte); das können Sie in den Einstellungen abschalten.\n\n"
                + "Sie behalten die Kontrolle: Nichts wird im Hintergrund gelesen – zwischen zwei Anfragen tut der Dienst nichts. Eine kleine Blase am oberen Rand zeigt, wenn die KI handelt. Sie können das Handy dabei weiter selbst benutzen: Was Sie tippen oder antippen, sieht die KI bei ihrem nächsten Blick und macht von dort aus weiter – so können Sie ihr auch helfen. „Pause“ hält sie an, bis Sie „Weiter“ tippen, und „✕“ beendet sie für diese Aufgabe. Die KI kann vorher in der Blase fragen (✓ ja, ✕ gerade nicht) oder dort eine kurze Statuszeile zeigen. Das Einschalten gilt für alle Apps, einzeln wird nicht nachgefragt. Ausschalten können Sie jederzeit unter Einstellungen › Bedienungshilfen."
                : "Autark can let the AI of your own company operate this phone for you – for example open an app, read the screen, tap, swipe and type. This only happens when you give it a task on the PC or in a chat that needs this phone.\n\n"
                + "To do this, Autark uses Android's Accessibility Service API. Once you turn it on, Autark can, when asked:\n"
                + "• read everything on the screen: texts, buttons and field names of the open app (the text of password fields is not read)\n"
                + "• open and read the notification shade – including private messages, emails and bank alerts shown there\n"
                + "• take screenshots that show whatever is on the screen\n"
                + "• tap, swipe, type text, and open apps and links\n\n"
                + "Where the data goes: What Autark reads goes only to your own PC through the encrypted connection. There, the AI model you chose on that PC sees it to choose the next step – if that is an online model, its provider receives this content, private content included, as with any other task you give that AI. Nothing of this goes to Teydra Lab; there is no advertising and no sale of data. The only thing Autark counts is an anonymous number of how often it is used (platform and hour, never content), which you can turn off in Settings.\n\n"
                + "You stay in control: nothing is read in the background – between two requests the service does nothing. A small bubble at the top shows when the AI acts. You can keep using the phone meanwhile: what you tap or type, the AI sees at its next look and carries on from there – so you can also help it along. \"Pause\" holds it until you tap \"Continue\", and \"✕\" ends it for that task. The AI can ask first in the bubble (✓ yes, ✕ not now) or show a short status line there. Turning it on covers every app; there is no question per app. You can turn it off any time under Settings › Accessibility.";
    }

    /** The regular way when Android greys out the switch for an app from outside the store (Android 13+, "restricted
     *  setting"): what to allow and where – the menu names differ a little between phone makers. */
    public static String restricted(boolean german) {
        return german
                ? "Ist „Use this phone“ ausgegraut oder meldet Android eine eingeschränkte Einstellung? Das ist Androids Schutz für Apps, die nicht aus dem Play Store kommen. So geben Sie es frei: Einstellungen › Apps › Autark › ⋮ (oben rechts) › Eingeschränkte Einstellungen zulassen. Danach Einstellungen › Bedienungshilfen › Use this phone einschalten. Damit darf Autark auf Anfrage den Bildschirm lesen und das Handy bedienen, wie oben beschrieben. Die Bezeichnungen können je nach Hersteller etwas abweichen."
                : "Is \"Use this phone\" greyed out, or does Android say a setting is restricted? That is Android's protection for apps from outside the Play Store. To allow it: Settings › Apps › Autark › ⋮ (top right) › Allow restricted settings. Then turn on Settings › Accessibility › Use this phone. Autark may then read the screen and operate the phone when asked, as described above. The names can differ a little between phone makers.";
    }

    public static String agree(boolean german) { return german ? "Zustimmen und weiter" : "Agree and continue"; }

    /** The short hint as Android's Accessibility settings open for someone who already agreed (no silent jump there). */
    public static String turnOn(boolean german) { return turnOn(german, ""); }

    /** The same hint naming the part of the list Autark stands in (section(); "" keeps the general words). */
    public static String turnOn(boolean german, String section) {
        if (section == null || section.isEmpty()) {
            return german ? "Die Blase braucht die Bedienungshilfe: tippe in der Liste auf Autark und schalte sie ein."
                    : "The bubble needs the accessibility service: tap Autark in the list and turn it on.";
        }
        return german ? "Die Blase braucht die Bedienungshilfe: unten unter „" + section + "“ auf Autark tippen und einschalten."
                : "The bubble needs the accessibility service: further down under \"" + section + "\", tap Autark and turn it on.";
    }

    /** Where the Accessibility list shows an app's own service, as this phone names it: Samsung's One UI 2 (Android 10,
     *  S9 27.11.2026) puts the areas first and the services at the bottom under "Installed services"; later One UI and other
     *  makers name and place it differently, so there "" – the hint stays general rather than wrong. */
    public static String section(boolean german, String maker, int sdk) {
        if (!"samsung".equalsIgnoreCase(maker) || sdk != 29) return "";
        return german ? "Installierte Dienste" : "Installed services";
    }

    public static String decline(boolean german) { return german ? "Nicht jetzt" : "Not now"; }

    public static boolean isGerman(String language) { return "de".equalsIgnoreCase(language); }
}
