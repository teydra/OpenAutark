// Owns: the pure rules of the request "Let the AI use this phone" (owner/Konrad 24.11.2026, #821: the AI asked three times on
// the Galaxy S9 and the person saw nothing): when the large in-app card shows (the app open in front, not already up, not
// right after "Not now"), which way the Lite build's button goes (install right first when the app may not install), and
// the words. No Android classes, so the host tests run it. Never: posts anything or touches a phone.
package com.teydralab.autark.android;

public final class PhoneUseAskRule {
    /** Which build asks: the website build without phone use (adds it) or the build with it (turns it on). */
    public enum Kind { LITE, FULL }

    /** After "Not now" the card stays away this long; the notification stays and every AI request re-posts it. */
    public static final long CARD_PAUSE_MS = 5 * 60_000L;
    public static final String TITLE = "Let the AI use this phone";
    public static final String NOT_NOW = "Not now";

    private PhoneUseAskRule() {}

    /** The card shows while Autark is open in front, no card is up and the person did not say "Not now" a moment ago. */
    public static boolean cardDue(boolean inFront, boolean cardShowing, long now, long notNowAt) {
        if (!inFront || cardShowing) return false;
        return notNowAt <= 0 || now - notNowAt >= CARD_PAUSE_MS || now < notNowAt;
    }

    /** The Lite button: false – start the download and install; true – first Android's "install unknown apps" switch. */
    public static boolean allowInstallFirst(boolean canInstall) { return !canInstall; }

    /** Android 13+ greys the switch out for an app from outside the store: the one extra step, said once. */
    public static final String RESTRICTED = "Greyed out or \"restricted setting\"? First Settings › Apps › Autark › ⋮ › Allow restricted settings (names can differ by phone maker).";

    public static String line(Kind kind) { return line(kind, false); }

    /** The card's line. `agreed`: the person agreed before and only the switch is off (after an update, or turned off by
     * hand) – the tap then opens Accessibility right away (UseDisclosure skips itself), so the words promise no reading. */
    public static String line(Kind kind, boolean agreed) {
        if (kind == Kind.LITE) return "Your AI wants to work on this phone. Autark adds phone use by itself: it fetches the phone-use version and installs it here. You then read what it does and agree.";
        return agreed
                ? "Your AI wants to work on this phone. You agreed before, but phone use is switched off. Switch it back on in Accessibility."
                : "Your AI wants to work on this phone. First you read what it does and agree, then switch it on in Accessibility.";
    }

    public static String button(Kind kind) { return button(kind, false); }

    public static String button(Kind kind, boolean agreed) {
        if (kind == Kind.LITE) return "Add phone use";
        return agreed ? "Turn back on" : "Read and turn on";
    }

    /** The full build's notification text (Mika, S9, 27.11.2026: "Tap to read what this does" opened Accessibility
     * directly – the agreement was stored, only the switch was off). The words follow where the tap really goes. */
    public static String prompt(boolean agreed, boolean restrictedSettings) {
        String first = agreed
                ? "You agreed before; phone use is switched off. Tap to open Accessibility, then Autark › Use this phone."
                : "Tap to read what this does, then Accessibility › Use this phone.";
        return restrictedSettings ? first + " " + RESTRICTED : first;
    }
}
