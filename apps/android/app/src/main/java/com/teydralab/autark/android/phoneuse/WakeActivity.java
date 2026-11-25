// Owns: turning the screen on for the AI (phone.key wakeup): an invisible activity that may show over the lock screen,
// asks Android to turn the screen on (the system's own way – ACQUIRE_CAUSES_WAKEUP needs a permission apps do not get
// since Android 14) and leaves again, so the lock screen is in front for the AI's swipe. Never: unlocks, dismisses the
// lock screen, or shows anything.
package com.teydralab.autark.android.phoneuse;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

public final class WakeActivity extends Activity {
    private static final long LEAVE_MS = 800;

    @SuppressWarnings("deprecation") // the window flags are Android 8.0's way; 8.1+ uses the two setters
    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        getWindow().getDecorView().postDelayed(this::finish, LEAVE_MS);
    }
}
