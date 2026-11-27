// Owns: the way back to the hidden to-do bubble (owner 19.11.2026: "dass man die dann noch ganz schnell wieder anbekommt"
// – the round icon left of the title in the app's top row, ui/pwa/bubble-handle.tsx): the page's pull, its moves and its
// drop (NativePort, screen px) bring the bubble out under the finger and let it follow (TodoButton.comeOut / follow);
// while the bubble is out a pull does nothing (one bubble). Phone use off (the service not running, the disclosure not
// agreed): the pull opens the way to turn it on (UseDisclosure, which goes on to Android's Accessibility settings –
// agreed before, straight there with a toast that says what to switch; never a silent jump); a
// build without phone use offers its phone-use build (PhoneUseUpgrade). The page hears the state – whether this build
// has phone use at all, whether the bubble is out – through the one listener (NativePort: 'bubble.state').
// Never: turns phone use on by itself, or keeps any state but whether the current gesture brought the bubble out.
package com.teydralab.autark.android.phoneuse;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import com.teydralab.autark.android.PhoneUseUpgrade;

public final class BubblePull {
    /** The bubble's state for the page (main thread): `available` – this build has phone use; `out` – it is on the screen. */
    public interface State { void changed(boolean available, boolean out); }

    private static State listener;
    /** The current gesture brought the bubble out: its moves and its drop place it. */
    private static boolean pulling;

    private BubblePull() {}

    /** `state` hears every change from now on (null: nobody); it hears the current state at once. Main thread. */
    public static void listen(Context context, State state) {
        listener = state;
        if (state != null) state.changed(UseConsent.available(context), out());
    }

    /** Stops `state` – only while it is still the one. */
    public static void unlisten(State state) { if (listener == state) listener = null; }

    /** The bubble came or went (TodoButton). Main thread. */
    static void changed(Context context) {
        State state = listener;
        if (state != null) state.changed(UseConsent.available(context), out());
    }

    private static boolean out() {
        UseService service = UseService.current();
        TodoButton todo = service == null ? null : service.todo();
        return todo != null && todo.out();
    }

    /** The page's pull at (x, y) screen px (x < 0: no place, e.g. a keyboard press – the bubble's last place). Main thread. */
    public static void pull(Activity activity, int x, int y) {
        pulling = false;
        UseService service = UseService.current();
        if (service == null || !UseConsent.agreed(activity)) { enable(activity); return; }
        TodoButton todo = service.todo();
        if (todo == null || todo.out()) return; // one bubble: the page shows that it is out
        todo.comeOut(x, y);
        pulling = todo.out();
    }

    /** The finger moved on (screen px); `drop` ends the gesture with the bubble there. Main thread. */
    public static void move(int x, int y, boolean drop) {
        if (!pulling) return;
        UseService service = UseService.current();
        TodoButton todo = service == null ? null : service.todo();
        if (todo != null) todo.follow(x, y, drop);
        if (drop) pulling = false;
    }

    private static void enable(Activity activity) {
        if (!UseConsent.available(activity)) { PhoneUseUpgrade.prompt(activity); return; }
        try { activity.startActivity(new Intent(activity, UseDisclosure.class)); } catch (RuntimeException error) { EnablePrompt.show(activity); }
    }
}
