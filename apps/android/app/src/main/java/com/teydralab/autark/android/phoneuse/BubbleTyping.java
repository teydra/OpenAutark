// Owns: typing into the to-do bubble's field without the navigation bar going (owner 20.11.2026, FCMWNRMX: "die
// Navigationstasten Home und Zurück verschwinden", back once the bubble closed). Cause: Android layers the keyboard
// directly above the window it types into (DisplayContent.assignRelativeLayerForIme: the IME container goes one layer above
// its target's surface), and the bubble is an accessibility overlay, which sits above the navigation bar – so the
// keyboard covered Home and Back. The words therefore go into this activity: an app window like any other (the keyboard
// stays under the navigation bar), one pixel big and invisible, in a task of its own that leaves no trace in Recents.
// Its field holds the bubble's text; every change goes to the bubble's field (Field.typed), which the person sees. A
// touch outside it ends typing – unless it lands on the bubble's panel (Field.inside), whose buttons then work as usual –
// and the touch goes on to whatever is there; the AI's own gestures meanwhile (aiGesture) leave it open. Back, Home or
// the app leaving the screen end it too; it shows over the lock screen like the bubble. Text the bubble puts in its field
// (dictated words) comes in through set(). A start Android blocked ends after START_MS. ended() comes once. Phone use
// never sees this window: UseService skips it and reads the app under it, and its field is not for accessibility.
// Never: shows anything itself, keeps the text, or stays after typing ended.
package com.teydralab.autark.android.phoneuse;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;

public final class BubbleTyping extends Activity {
    /** The bubble's side (main thread). */
    interface Field {
        /** The text now (each change). */
        void typed(String text);
        /** Whether a point (screen px) lies on the bubble's panel. */
        boolean inside(float x, float y);
        /** Typing is over (once). */
        void ended();
    }

    /** The window's width and height in pixels (UseService knows it by this). */
    static final int SIZE = 1;
    /** A start Android did not let through ends after this long. */
    private static final long START_MS = 1_500;
    private static Field waiting;
    /** Until when (uptime ms) touches belong to the AI's own gesture. */
    private static volatile long aiUntil;
    private static String text = "";
    private static int caret;
    private static BubbleTyping open;
    private Field field;
    private EditText input;

    /** Typing starts with `now` and the caret at `at` (main thread); a typing still open ends first. */
    static void begin(Context context, String now, int at, Field to) {
        end();
        waiting = to;
        text = now == null ? "" : now;
        caret = Math.max(0, Math.min(at, text.length()));
        Intent intent = new Intent(context, BubbleTyping.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        try { context.startActivity(intent); }
        catch (RuntimeException failed) { Field gone = waiting; waiting = null; if (gone != null) gone.ended(); return; }
        new Handler(Looper.getMainLooper()).postDelayed(() -> { if (open == null && waiting == to) end(); }, START_MS);
    }

    /** The bubble's field got text of its own (dictated words, main thread): the typing goes on from it. */
    static void set(String now) {
        BubbleTyping typing = open;
        if (typing != null && typing.input != null) { typing.input.setText(now); typing.input.setSelection(typing.input.length()); }
        else if (waiting != null) { text = now == null ? "" : now; caret = text.length(); }
    }

    /** The AI's own gesture runs for `ms` from now (a step's thread): its touches leave typing open. */
    static void aiGesture(long ms) { aiUntil = SystemClock.uptimeMillis() + ms; }

    /** Typing ends now (main thread), if it runs. */
    static void end() {
        BubbleTyping now = open;
        if (now != null) now.finish();
        else if (waiting != null) { Field gone = waiting; waiting = null; gone.ended(); } // ended before the activity came up
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        field = waiting;
        waiting = null;
        if (field == null) { finish(); return; } // recreated by Android without a bubble asking: nothing to type into
        open = this;
        overridePendingTransition(0, 0);
        Window window = getWindow();
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.setFormat(PixelFormat.TRANSLUCENT);
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH);
        if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true); // the bubble shows over the lock screen, so does its typing
        else window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        WindowManager.LayoutParams at = window.getAttributes();
        at.width = SIZE;
        at.height = SIZE;
        at.gravity = Gravity.TOP | Gravity.START;
        window.setAttributes(at);
        input = new EditText(this);
        input.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); // the person's draft is not the AI's screen
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setAlpha(0f);
        input.setText(text);
        input.setSelection(caret);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable now) { if (field != null) field.typed(now.toString()); }
        });
        // The window lies under the status bar, so Android insets its content by the bar: the field came out 1×0, a view
        // without size loses its focus (Android 9+), and the keyboard never came (S9, Android 10, 27.11.2026: ic=null at
        // the window's focus). The window shows nothing, so its content takes no system insets and the field keeps 1×1.
        window.getDecorView().setOnApplyWindowInsetsListener((decor, insets) -> decor.onApplyWindowInsets(insets.replaceSystemWindowInsets(0, 0, 0, 0)));
        setContentView(input);
        input.requestFocus();
    }

    /** The keyboard is asked for once the window has the focus: asked before, Android drops it (the field is not served yet). */
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        EditText shown = input;
        if (!focused || shown == null) return;
        if (!shown.isFocused()) shown.requestFocus();
        shown.post(() -> {
            InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (keyboard != null && input == shown) keyboard.showSoftInput(shown, 0);
        });
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        boolean ai = event.getEventTime() <= aiUntil;
        if (event.getActionMasked() == MotionEvent.ACTION_OUTSIDE && !ai && (field == null || !field.inside(event.getRawX(), event.getRawY()))) finish();
        return super.onTouchEvent(event);
    }

    /** Home, Recents or another app in front: typing is over. */
    @Override protected void onStop() {
        super.onStop();
        if (!isFinishing()) finish();
    }

    @Override public void finish() {
        super.finish();
        overridePendingTransition(0, 0);
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (open == this) open = null;
        input = null;
        Field gone = field;
        field = null;
        if (gone != null) gone.ended();
    }
}
