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
        // The list shows the service's label, not the app's name (S9 27.11.2026: "Use this phone")
        check(DisclosureText.turnOn(true).contains("Bedienungshilfe") && DisclosureText.turnOn(true).contains("„Use this phone“") && !DisclosureText.turnOn(true).contains("Autark"));
        check(DisclosureText.turnOn(false).contains("accessibility service") && DisclosureText.turnOn(false).contains("\"Use this phone\""));
        // Mika 27.11.2026: Samsung's One UI 2 (Android 10) holds the service at the bottom under "Installierte Dienste" – the
        // hint names it there; any other maker or Android keeps the general words rather than a name that may be wrong
        check(DisclosureText.section(true, "samsung", 29).equals("Installierte Dienste") && DisclosureText.section(false, "Samsung", 29).equals("Installed services"));
        check(DisclosureText.section(true, "Google", 29).isEmpty() && DisclosureText.section(true, "samsung", 34).isEmpty() && DisclosureText.section(true, null, 29).isEmpty());
        String s9 = DisclosureText.turnOn(true, DisclosureText.section(true, "samsung", 29));
        check(s9.contains("„Installierte Dienste“") && s9.contains("„Use this phone“") && s9.contains("einschalten") && s9.startsWith("Die Blase braucht die Bedienungshilfe"));
        check(DisclosureText.turnOn(false, DisclosureText.section(false, "samsung", 29)).contains("\"Installed services\""));
        check(DisclosureText.turnOn(true, "").equals(DisclosureText.turnOn(true)) && DisclosureText.turnOn(false, null).equals(DisclosureText.turnOn(false)));
        try {
            String base = System.getProperty("autark.android") + "/app/src/main/java/com/teydralab/autark/android/phoneuse/";
            String disclosure = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(base + "UseDisclosure.java")), java.nio.charset.StandardCharsets.UTF_8);
            String strings = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(System.getProperty("autark.android") + "/app/src/main/res/values/strings.xml")), java.nio.charset.StandardCharsets.UTF_8);
            check(strings.contains("<string name=\"use_label\" translatable=\"false\">" + DisclosureText.SERVICE + "</string>"));
            String pull = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(base + "BubblePull.java")), java.nio.charset.StandardCharsets.UTF_8);
            String agreed = disclosure.substring(disclosure.indexOf("if (UseConsent.agreed(this))"), disclosure.indexOf("LinearLayout column"));
            check(agreed.contains("Toast.makeText(") && agreed.contains("DisclosureText.turnOn(german, section)") && agreed.indexOf("Toast.makeText(") < agreed.indexOf("openSettings()"));
            // Mika 27.11.2026: the settings are asked to scroll to Autark's own row (the service's flattened name)
            String open = disclosure.substring(disclosure.indexOf("private void openSettings()"));
            check(open.contains("new ComponentName(this, UseService.class).flattenToString()") && open.contains("args.putString(\":settings:fragment_args_key\", row)")
                    && open.contains(".putExtra(\":settings:fragment_args_key\", row)") && open.contains(".putExtra(\":settings:show_fragment_args\", args)"));
            check(pull.contains("if (service == null || !UseConsent.agreed(activity)) { enable(activity); return; }") && pull.contains("new Intent(activity, UseDisclosure.class)"));
        } catch (java.io.IOException error) { throw new AssertionError(error); }
        System.out.println(assertions + " Play install-rule and disclosure assertions passed.");
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Unexpected result " + assertions); }
}
