// Owns: host checks of the request "Let the AI use this phone" (owner/Konrad 24.11.2026, #821): the large card shows only
// with the app open in front, never twice, and not for five minutes after "Not now" (the notification stays meanwhile);
// the Lite button asks for Android's install switch first only when the app may not install; the words. Never: a device
// test – the card's look and the notification are checked on a phone.
package com.teydralab.autark.android;

public final class PhoneUseAskRuleTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    public static void main(String[] args) {
        long t = 1_000_000_000L;
        check(PhoneUseAskRule.cardDue(true, false, t, 0), "open in front, nothing up, never dismissed: card");
        check(!PhoneUseAskRule.cardDue(false, false, t, 0), "app in the background: notification only");
        check(!PhoneUseAskRule.cardDue(true, true, t, 0), "one card at a time");
        check(!PhoneUseAskRule.cardDue(true, false, t, t - 60_000), "a minute after Not now: no card");
        check(!PhoneUseAskRule.cardDue(true, false, t, t - PhoneUseAskRule.CARD_PAUSE_MS + 1), "just inside the pause: no card");
        check(PhoneUseAskRule.cardDue(true, false, t, t - PhoneUseAskRule.CARD_PAUSE_MS), "pause over: the card again");
        check(PhoneUseAskRule.cardDue(true, false, t, t + 5_000), "a clock set back never keeps the card away");
        check(PhoneUseAskRule.allowInstallFirst(false) && !PhoneUseAskRule.allowInstallFirst(true), "install switch first only when not allowed");
        check("Let the AI use this phone".equals(PhoneUseAskRule.TITLE), "title");
        check(PhoneUseAskRule.line(PhoneUseAskRule.Kind.LITE).contains("installs it here") && PhoneUseAskRule.line(PhoneUseAskRule.Kind.FULL).contains("agree"), "one line each");
        check(!PhoneUseAskRule.button(PhoneUseAskRule.Kind.LITE).equals(PhoneUseAskRule.button(PhoneUseAskRule.Kind.FULL)), "own button per build");
        System.out.println(assertions + " phone-use request assertions passed.");
    }
}
