// Owns: the words of the anonymous usage count on the phone (owner 25.11.2026), one place for the first level's tick and the
// page's Settings › Security (the page asks for them through NativePort, so the phone says the same everywhere). The
// desktop's ui/settings/usage-count.ts says the same for a PC. Never: logic.
package com.teydralab.autark.android.usage;

public final class UsageText {
    public static final String TITLE = "Anonymous usage count";
    /** Under the switch: exactly what goes out. */
    public static final String SENTENCE = "When this phone is used, it adds 1 to a counter of ours, at most once an hour. Only the platform and the hour are sent – no ID, no version, no content – and we store no IP address. Off: nothing is sent.";

    private UsageText() {}
}
