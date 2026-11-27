// Owns: the words that tell the person a call's voice is made by a machine (Konrad 27.11.2026: the local voice's licence,
// OpenRAIL-M, asks for a clear notice that its speech is machine-generated). The incoming call notice (CallNotice) and the
// "Call running" notice (KeepAlive) carry it for as long as they show; the page's call card shows the same words (desktop
// shared/model/call.ts AI_VOICE_NOTICE). One fixed English line on every phone, as Konrad worded it.
// Never: decides whether a call runs or which voice speaks.
package com.teydralab.autark.android;

public final class CallVoiceNote {
    private CallVoiceNote() {}

    /** The notice, the same words as the page's call card. */
    public static final String TEXT = "AI voice (machine-generated)";
}
