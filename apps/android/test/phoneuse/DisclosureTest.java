// Owns: executable checks that the Play install rule and the phone-use disclosure keep their promises, without a device:
// Play installs never self-update; the disclosure names what is read, where it goes, the password limit and the way out
// in both languages, that the person keeps using the phone while the AI works (owner 20.11.2026: no touch-pause), and
// the AI's ✓/✕ question, and the hint when the app's pull meets phone use off after an earlier agreement.
// Never: claims the screen shows (that needs a phone).
package com.teydralab.autark.android.phoneuse;

public final class DisclosureTest {
    private static int assertions;

    public static void main(String[] args) {
        check(com.teydralab.autark.android.InstallSourceProbe.selfUpdates(null));
        check(com.teydralab.autark.android.InstallSourceProbe.selfUpdates("com.google.android.packageinstaller"));
        check(!com.teydralab.autark.android.InstallSourceProbe.selfUpdates("com.android.vending"));
        for (boolean german : new boolean[] {false, true}) {
            String body = DisclosureText.body(german);
            for (String needed : german
                    ? new String[] {"AccessibilityService", "Bildschirmfotos", "Passwortfeldern", "eigenen PC", "Teydra Lab", "Hintergrund", "Benachrichtigungsleiste", "Bankmeldungen", "KI-Modell", "auch private", "Pause", "Weiter", "✕", "Bedienungshilfen", "weiter selbst benutzen", "nächsten Blick", "✓"}
                    : new String[] {"Accessibility Service", "screenshots", "password fields", "your own PC", "Teydra Lab", "background", "notification shade", "bank alerts", "AI model", "private content", "Pause", "Continue", "✕", "Accessibility", "keep using the phone", "next look", "✓"}) {
                check(body.contains(needed));
            }
            // Only what is checked: no claim about the microphone, the camera or a locked screen (owner 11.11.2026).
            for (String unchecked : new String[] {"Mikrofon", "Kamera", "gesperrt", "microphone", "camera", "locked", "30 Sekunden", "30 seconds", "5 Sekunden", "5 seconds", "pausiert die KI sofort", "pauses at once"}) check(!body.contains(unchecked));
            check(!DisclosureText.title(german).isEmpty() && !DisclosureText.agree(german).isEmpty() && !DisclosureText.decline(german).isEmpty());
        }
        check(DisclosureText.isGerman("de") && DisclosureText.isGerman("DE") && !DisclosureText.isGerman("en") && !DisclosureText.isGerman(null));
        // S9 check 27.11.2026: the app's pull with phone use off never jumps away silently – the disclosure, or (agreed
        // before) a hint as the Accessibility settings open
        check(DisclosureText.turnOn(true).contains("Bedienungshilfe") && DisclosureText.turnOn(true).contains("Autark") && DisclosureText.turnOn(false).contains("accessibility service"));
        try {
            String base = System.getProperty("autark.android") + "/app/src/main/java/com/teydralab/autark/android/phoneuse/";
            String disclosure = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(base + "UseDisclosure.java")), java.nio.charset.StandardCharsets.UTF_8);
            String pull = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(base + "BubblePull.java")), java.nio.charset.StandardCharsets.UTF_8);
            String agreed = disclosure.substring(disclosure.indexOf("if (UseConsent.agreed(this))"), disclosure.indexOf("LinearLayout column"));
            check(agreed.contains("Toast.makeText(") && agreed.contains("DisclosureText.turnOn(german)") && agreed.indexOf("Toast.makeText(") < agreed.indexOf("openSettings()"));
            check(pull.contains("if (service == null || !UseConsent.agreed(activity)) { enable(activity); return; }") && pull.contains("new Intent(activity, UseDisclosure.class)"));
        } catch (java.io.IOException error) { throw new AssertionError(error); }
        System.out.println(assertions + " Play install-rule and disclosure assertions passed.");
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Unexpected result " + assertions); }
}
