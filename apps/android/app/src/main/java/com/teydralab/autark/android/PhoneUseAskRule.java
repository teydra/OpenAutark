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

    public static String line(Kind kind) {
        return kind == Kind.LITE
                ? "Your AI wants to work on this phone. Autark adds phone use by itself: it fetches the phone-use version and installs it here. You then read what it does and agree."
                : "Your AI wants to work on this phone. First you read what it does and agree, then switch it on in Accessibility.";
    }

    public static String button(Kind kind) { return kind == Kind.LITE ? "Add phone use" : "Read and turn on"; }
}
