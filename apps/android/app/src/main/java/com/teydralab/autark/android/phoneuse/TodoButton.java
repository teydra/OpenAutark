// Owns: the person's small to-do button over every app (an accessibility overlay of UseService: no extra permission),
// shown while this phone is paired (UseLink.linked()), also while the Autark app is closed. Three looks in one window:
// the dot (40 dp, the Autark mark, see-through; a drag beyond the touch slop moves it, a tap opens the panel, a drop
// with the finger at a side edge – or an accessibility long-click – turns it into the tab), the tab (10 × 36 dp at the nearest side edge; a
// tap brings the dot back) and the panel beside the dot – icons only: screenshot, dictate, call, send, close (back to
// the dot) –, one text field (1 line, up to 4), a strip of the shots taken (a tap removes one; at most TodoPost.MAX) and
// one short status line. Opening does not capture the screen. The camera adds optional shots; Send captures the
// current screen (UseService.capture hides both overlays) before any task can go out.
// Dictation (owner 20.11.2026: as good as the app's own – the phone's recognizer heard "We got to steer" for "Wie geht es
// dir?") records the voice and the PC hears it, the same path as the app's composer (Dictation: WAV pieces,
// files.upload, voice.transcribe in the profile's language); the words land at the end of the field once the PC has
// heard them; without the microphone right the mic opens the app instead. Send: every shot goes up (files.upload), then tasks.quickCreate with the text, the shots and
// the post's client id (TodoPost) – Autark picks the owner; ✓, then empty and back to the dot. Call (owner 19.11.2026:
// without the app coming up): the panel folds to the dot and the call runs in the bubble (BubbleCall) – the first line
// spoken (or the typed text) goes out as above, the agent who took it gets the call in its 1:1 (chats.direct), the dot
// shows the agent's initial in a live ring, and one tap on it ends the call. A failure keeps everything and says one
// line; Send again reuses the client id. Hide (owner 19.11.2026): dragging the dot shows a ✕ at the bottom centre;
// dropped there, the button is hidden ("hidden" in SharedPreferences "todo_button") – hidden is hidden, no tab – until
// the person pulls it out of the round icon in the Autark app's top row (BubblePull: it comes out under the finger and
// follows it; while it is out there is no second one, and the page's icon hears out() through BubblePull.changed).
// Holding the dot starts recording without hiding it. Lifting the finger takes the screenshot and ends recording;
// after transcription both go out. Cancel aborts. A failed attempt keeps any words and says why.
// The window never takes key focus: a tap into the field types through BubbleTyping, a tiny app window below the
// navigation bar (owner 20.11.2026: the keyboard of an overlay covered Home and Back – Android layers the keyboard right
// above the window it types into, and an accessibility overlay sits above the navigation bar); the field shows the
// words as they come. Every touch outside the dot, the tab or the panel reaches the app.
// Both windows (the button and the ✕) are laid out in screen coordinates (inScreen: y 0 is the screen's top, under the
// status bar and a cutout), so the finger's raw position, the ✕, the stored place and the app's pull share one frame.
// Never: keeps the person's text or shots anywhere but this panel and the RPC, or shows in the AI's screenshot.
package com.teydralab.autark.android.phoneuse;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import com.teydralab.autark.android.MainActivity;
import com.teydralab.autark.android.R;
import com.teydralab.autark.android.relay.Json;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

final class TodoButton {
    private enum Look { DOT, TAB, PANEL }

    private static final int DOT_DP = 40;
    private static final int TAB_W_DP = 10;
    private static final int TAB_H_DP = 36;
    private static final int PANEL_DP = 236;
    private static final int ICON_DP = 36;
    private static final int THUMB_DP = 34;
    /** A drop with the finger this close to a side edge makes the tab. */
    private static final int EDGE_DP = 14;
    private static final long FRAME_MS = 32;
    private static final long WAIT_MS = 300;
    /** How long one upload or call may take before the panel says it failed. */
    private static final long CALL_MS = 60_000;
    private static final long DONE_MS = 900;
    private static final int BG = Color.argb(235, 32, 36, 34);
    /** A press this long without moving is the quick task (owner 18.11.2026: ~350 ms). */
    private static final long HOLD_MS = 350;
    private static final int RED = Color.rgb(229, 57, 53);
    /** Autark orange: the call's ring while the bubble listens. */
    private static final int ORANGE = Color.rgb(255, 79, 0);
    /** The hide target: its size and its gap above the bottom edge; a finger this near its middle drops onto it. */
    private static final int BIN_DP = 56;
    private static final int BIN_GAP_DP = 72;
    private static final int BIN_NEAR_DP = 64;
    /** SharedPreferences "todo_button": the person hid the button (the drag onto ✕; the app's pull brings it back). */
    private static final String HIDDEN = "hidden";

    private final UseService service;
    private final WindowManager windows;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SharedPreferences place;
    private final float density;
    private final boolean german = "de".equals(Locale.getDefault().getLanguage());
    private final TodoPost post = new TodoPost();
    private final ExecutorService work = Executors.newSingleThreadExecutor((job) -> {
        Thread thread = new Thread(job, "autark-todo");
        thread.setDaemon(true);
        return thread;
    });
    // A slow link/upload must never make a send capture a later page.
    private final ExecutorService sendCapture = Executors.newSingleThreadExecutor(job -> {
        Thread thread = new Thread(job, "autark-todo-send-shot");
        thread.setDaemon(true);
        return thread;
    });
    private final Runnable onLink = () -> main.post(this::sync);
    private final List<ImageView> buttons = new ArrayList<>();
    /** The call running in the bubble, or null. */
    private BubbleCall calling;
    /** The hide target while the dot is dragged, and whether the finger is over it. */
    private TextView bin;
    private boolean overBin;
    /** A manual screenshot is on its way. */
    private boolean shooting;

    private FrameLayout root;
    private WindowManager.LayoutParams params;
    private Look look = Look.DOT;
    private View dot;
    private View tab;
    private LinearLayout panel;
    private EditText field;
    private LinearLayout strip;
    private TextView line;
    private ImageView mic;
    /** The panel's dictation take, or null; whether the PC hears it now; whether Send waits for its words. */
    private Dictation dictation;
    private boolean transcribing;
    private FutureTask<TodoPost.Shot> sendAfter;
    private UseLink sendLink;
    private GradientDrawable dotRound;
    private ImageView dotMark;
    private TextView dotCheck;
    private final TodoHold hold = new TodoHold();
    private Dictation holdTake;
    private UseLink holdLink;
    private String holdWords;
    private String holdProblem;
    private FutureTask<TodoPost.Shot> holdShot;
    /** The language the PC hears the person in: the Autark profile's (validated, cached for the PC it came from), else the phone's. */
    private volatile String profileLanguage;
    /** The link whose profile language was asked for; one ask per link (a failed ask lets the next sync ask again). */
    private UseLink languageFor;
    private boolean busy;
    /** The text while the window is gone (the link paused); never stored anywhere else. */
    private String draft = "";
    private boolean closed;
    /** The panel's y before the keyboard moved it up (-1: not moved); whether the person types in it now (BubbleTyping). */
    private int yBeforeKeyboard = -1;
    private boolean typing;

    TodoButton(UseService service) {
        this.service = service;
        this.windows = (WindowManager) service.getSystemService(AccessibilityService.WINDOW_SERVICE);
        this.place = service.getSharedPreferences("todo_button", Context.MODE_PRIVATE);
        this.density = service.getResources().getDisplayMetrics().density;
        this.profileLanguage = SpeechLang.valid(place.getString("speech_lang", null));
    }

    /** Shows while this phone is paired, from now on (the main thread). */
    void start() {
        UseLink.onLinked(onLink);
        sync();
    }

    /** The service went off: the button goes for good (any thread). */
    void close() {
        UseLink.onLinked(null);
        work.shutdownNow();
        sendCapture.shutdownNow();
        main.post(() -> { closed = true; dropDictation(); dropHold(); remove(); });
    }

    // ------------------------------------------------------------------ screenshot frame (a worker thread)

    /** Invisible until showAfterShot: returns once a frame without it reached the screen, at most WAIT_MS. */
    boolean hideForShot() throws InterruptedException {
        CountDownLatch hidden = new CountDownLatch(1);
        main.post(() -> {
            if (root == null) { hidden.countDown(); return; }
            root.setAlpha(0f); // keep the live touch target attached during a PC screenshot
            root.postOnAnimation(() -> main.postDelayed(hidden::countDown, FRAME_MS));
        });
        return hidden.await(WAIT_MS, TimeUnit.MILLISECONDS);
    }

    void showAfterShot() { main.post(() -> { if (root != null) root.setAlpha(1f); }); }

    // ------------------------------------------------------------------ window

    private void sync() {
        if (closed) return;
        if (UseLink.linked() != null && !place.getBoolean(HIDDEN, false)) { ensure(); refreshLanguage(); } else { languageFor = null; dropDictation(); remove(); }
    }

    /**
     * The Autark profile's language from the PC, once per link (the main thread), by the narrow call todos.speechLanguage:
     * its answer holds the language tag or null and nothing else. A PC that does not know the call (an older one) or has no
     * language gives the phone's own language; the broad settings call is never used instead. A temporary failure (no
     * answer, no socket) keeps the language last received from the same PC and asks again at the next sync; a language kept
     * for another PC does not count.
     */
    private void refreshLanguage() {
        UseLink link = UseLink.linked();
        if (link == null || link == languageFor) return;
        languageFor = link;
        String origin = link.origin();
        if (!origin.equals(place.getString("speech_lang_origin", null))) profileLanguage = null;
        run(() -> {
            Object answer = null;
            boolean temporary = false;
            try { answer = link.request("todos.speechLanguage", Json.map(), CALL_MS); }
            catch (UseLink.Refused refused) { temporary = refused.late || UseLink.UNLINKED.equals(refused.getMessage()); }
            String found = SpeechLang.profileLanguage(answer);
            boolean again = temporary;
            main.post(() -> {
                // the link changed or went meanwhile: a late answer of the old PC changes nothing
                if (!SpeechLang.isActive(languageFor, link) || !SpeechLang.isActive(UseLink.linked(), link)) return;
                if (again) { languageFor = null; return; }
                profileLanguage = found;
                if (found == null) place.edit().remove("speech_lang").remove("speech_lang_origin").apply(); // an older PC, or none set: the phone's own
                else place.edit().putString("speech_lang", found).putString("speech_lang_origin", origin).apply();
            });
        });
    }

    private int dp(int value) { return Math.round(value * density); }

    private int[] screen() {
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Rect bounds = windows.getCurrentWindowMetrics().getBounds();
            return new int[] { bounds.width(), bounds.height() };
        }
        DisplayMetrics metrics = service.getResources().getDisplayMetrics();
        return new int[] { metrics.widthPixels, metrics.heightPixels };
    }

    private void ensure() {
        if (root != null) return;
        root = new FrameLayout(service);
        dot = makeDot();
        tab = makeTab();
        panel = makePanel();
        root.addView(dot, new FrameLayout.LayoutParams(dp(DOT_DP), dp(DOT_DP)));
        root.addView(tab, new FrameLayout.LayoutParams(dp(TAB_W_DP), dp(TAB_H_DP)));
        root.addView(panel, new FrameLayout.LayoutParams(dp(PANEL_DP), FrameLayout.LayoutParams.WRAP_CONTENT));
        params = new WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        inScreen(params);
        boolean asTab = place.getBoolean("tab", false);
        int[] screen = screen();
        params.x = TodoPlace.clamp(place.getInt("x", screen[0] - dp(DOT_DP) - dp(8)), dp(DOT_DP), screen[0]);
        params.y = TodoPlace.clamp(place.getInt("y", screen[1] / 3), dp(DOT_DP), screen[1]);
        try { windows.addView(root, params); } catch (RuntimeException error) { root = null; params = null; return; }
        show(asTab ? Look.TAB : Look.DOT);
        BubblePull.changed(service);
    }

    /** A window laid out in screen coordinates: the status bar, the navigation bar and a cutout move nothing. */
    private static void inScreen(WindowManager.LayoutParams at) {
        at.flags |= WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
        if (Build.VERSION.SDK_INT >= 30) {
            at.setFitInsetsTypes(0);
            at.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        } else if (Build.VERSION.SDK_INT >= 28) {
            at.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }

    private void remove() {
        endCall();
        endTyping();
        dropHold(); // a hold whose window went records nothing more
        removeBin();
        if (root == null) return;
        draft = field == null ? "" : field.getText().toString(); // a pause of the link (or hiding) keeps what the person typed
        try { windows.removeView(root); } catch (RuntimeException ignored) { /* already gone */ }
        root = null;
        params = null;
        look = Look.DOT;
        BubblePull.changed(service);
    }

    private void update() {
        if (root == null) return;
        try { windows.updateViewLayout(root, params); } catch (RuntimeException gone) { /* removed meanwhile */ }
    }

    /** One look at a time; typing ends with the panel. */
    private void show(Look next) {
        if (root == null) return;
        look = next;
        dot.setVisibility(next == Look.DOT ? View.VISIBLE : View.GONE);
        tab.setVisibility(next == Look.TAB ? View.VISIBLE : View.GONE);
        panel.setVisibility(next == Look.PANEL ? View.VISIBLE : View.GONE);
        int[] screen = screen();
        if (next == Look.TAB) {
            boolean left = place.getBoolean("left", false);
            params.x = TodoPlace.sideX(left, dp(TAB_W_DP), screen[0]);
            params.y = TodoPlace.clamp(place.getInt("y", screen[1] / 3), dp(TAB_H_DP), screen[1]);
        } else if (next == Look.DOT) {
            params.x = TodoPlace.clamp(place.getInt("x", screen[0] - dp(DOT_DP + 8)), dp(DOT_DP), screen[0]);
            params.y = TodoPlace.clamp(place.getInt("y", screen[1] / 3), dp(DOT_DP), screen[1]);
        } else {
            int[] at = TodoPlace.panel(params.x, params.y, dp(DOT_DP), dp(PANEL_DP), panelHeight(), screen[0], screen[1]);
            params.x = at[0];
            params.y = at[1];
        }
        if (next != Look.PANEL) endTyping();
        yBeforeKeyboard = -1;
        update();
        if (next == Look.PANEL) root.post(this::fitPanel);
    }

    /** The panel as it really sits (the lock screen laid the window out further right than asked): left until it is whole on the screen. */
    private void fitPanel() {
        if (root == null || params == null || look != Look.PANEL || root.getWidth() <= 0) return;
        int[] at = new int[2];
        root.getLocationOnScreen(at);
        // The panel's own width, not root.getWidth(): a window that sticks out past the right edge is measured only as wide as
        // the room left, so its width then looks as if nothing overflowed (the home screen's cut-off panel).
        int want = SpeechLang.shiftInto(at[0], Math.max(root.getWidth(), dp(PANEL_DP)), screen()[0]);
        if (want != at[0]) {
            params.x = Math.max(0, params.x + want - at[0]);
            update();
        }
    }

    private int panelHeight() {
        panel.measure(View.MeasureSpec.makeMeasureSpec(dp(PANEL_DP), View.MeasureSpec.EXACTLY), View.MeasureSpec.UNSPECIFIED);
        return panel.getMeasuredHeight();
    }

    /** The person tapped into the field: the panel moves above the keyboard and the words come through BubbleTyping
     *  (an app window, so the keyboard stays below the navigation bar); the field shows them as they come. */
    private void typeHere() {
        if (look != Look.PANEL || params == null || typing) return;
        int y = TodoPlace.aboveKeyboard(params.y, panel.getHeight(), screen()[1]);
        if (y != params.y) { if (yBeforeKeyboard < 0) yBeforeKeyboard = params.y; params.y = y; update(); }
        typing = true;
        String now = field.getText().toString();
        BubbleTyping.begin(service, now, now.length(), new BubbleTyping.Field() {
            @Override public void typed(String text) {
                if (field == null || !typing) return;
                field.setText(text);
                field.setSelection(field.getText().length());
            }
            @Override public boolean inside(float x, float y) { return insidePanel(x, y); }
            @Override public void ended() { typingEnded(); }
        });
    }

    /** Text of the bubble's own in the field (dictated words, a call's unsent line, a sent draft): while the person types,
     *  their typing goes on from it (BubbleTyping.set), so the next key never brings the old text back. */
    private void setText(String text) {
        field.setText(text);
        field.setSelection(field.getText().length());
        if (typing) BubbleTyping.set(text);
    }

    /** While the AI's own gesture runs, touches pass through the button (a step's thread; on: returns once applied), so
     *  an AI tap where the dot sits lands on the app below. */
    void passThrough(boolean on) {
        CountDownLatch applied = new CountDownLatch(1);
        main.post(() -> {
            if (root == null || params == null) { applied.countDown(); return; }
            if (on) params.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            else params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            update();
            root.postOnAnimation(() -> main.postDelayed(applied::countDown, FRAME_MS));
        });
        if (!on) return;
        try { applied.await(WAIT_MS, TimeUnit.MILLISECONDS); } catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
    }

    /** The keyboard goes (any panel step that needs the screen or sends): BubbleTyping closes, ended() follows. */
    private void endTyping() { if (typing) BubbleTyping.end(); }

    private void typingEnded() {
        typing = false;
        if (params != null && yBeforeKeyboard >= 0) { params.y = yBeforeKeyboard; yBeforeKeyboard = -1; update(); }
    }

    /** Whether a point (screen px) lies on the panel: a tap there keeps the keyboard. */
    private boolean insidePanel(float x, float y) {
        if (root == null || look != Look.PANEL) return false;
        int[] at = new int[2];
        root.getLocationOnScreen(at);
        return x >= at[0] && x < at[0] + root.getWidth() && y >= at[1] && y < at[1] + root.getHeight();
    }

    // ------------------------------------------------------------------ the dot and the tab

    private View makeDot() {
        FrameLayout view = new FrameLayout(service);
        dotRound = new GradientDrawable();
        dotRound.setShape(GradientDrawable.OVAL);
        dotRound.setColor(BG);
        view.setBackground(dotRound);
        view.setAlpha(0.72f); // see-through: the app below stays readable
        dotMark = new ImageView(service);
        dotMark.setImageResource(R.drawable.ic_stat_autark);
        view.addView(dotMark, new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER));
        dotCheck = new TextView(service);
        dotCheck.setText("✓");
        dotCheck.setTextColor(Color.WHITE);
        dotCheck.setTextSize(18);
        dotCheck.setGravity(Gravity.CENTER);
        dotCheck.setVisibility(View.GONE);
        view.addView(dotCheck, new FrameLayout.LayoutParams(-1, -1));
        view.setContentDescription(german ? "Autark-Aufgabe" : "Autark to-do");
        view.setOnClickListener((v) -> { if (calling != null) endCall(); else open(); }); // during a call one tap ends it
        // An accessibility service's long-click (no finger to lift) puts the dot at the edge; the finger's hold is the quick task.
        view.setOnLongClickListener((v) -> { toTab(TodoPlace.left(params.x, dp(DOT_DP), screen()[0])); return true; });
        float slop = ViewConfiguration.get(service).getScaledTouchSlop();
        view.setOnTouchListener(new View.OnTouchListener() {
            private float downX, downY;
            private int startX, startY;
            private boolean dragging, held;
            private final Runnable threshold = () -> { if (view == dot && view.isShown()) held = holdStart(); };

            @Override public boolean onTouch(View v, MotionEvent event) {
                if (params == null) { main.removeCallbacks(threshold); return false; }
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX(); downY = event.getRawY();
                        startX = params.x; startY = params.y;
                        dragging = false; held = false;
                        if (calling == null) main.postDelayed(threshold, HOLD_MS); // during a call every tap ends it, however slow
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (!dragging && !held && TodoPlace.dragged(dx, dy, slop)) { dragging = true; main.removeCallbacks(threshold); showBin(); }
                        if (dragging) {
                            int[] screen = screen();
                            params.x = TodoPlace.clamp(startX + Math.round(dx), dp(DOT_DP), screen[0]);
                            params.y = TodoPlace.clamp(startY + Math.round(dy), dp(DOT_DP), screen[1]);
                            update();
                            nearBin(event.getRawX(), event.getRawY());
                        }
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        main.removeCallbacks(threshold);
                        if (held) { holdRelease(); return true; }
                        boolean hide = dragging && overBin;
                        removeBin();
                        if (hide) { hide(startX, startY); return true; }
                        if (dragging) {
                            int screenWidth = screen()[0];
                            place.edit().putInt("x", params.x).putInt("y", params.y).apply();
                            if (TodoPlace.droppedAtEdge(event.getRawX(), screenWidth, dp(EDGE_DP))) toTab(event.getRawX() < screenWidth / 2f);
                        } else {
                            v.performClick();
                        }
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        main.removeCallbacks(threshold);
                        removeBin();
                        if (held && !hold.released()) dropHold();
                        return true;
                    default:
                        return false;
                }
            }
        });
        return view;
    }

    private View makeTab() {
        View view = new View(service);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(BG);
        shape.setCornerRadius(dp(5));
        view.setBackground(shape);
        view.setAlpha(0.6f);
        view.setContentDescription(german ? "Autark-Aufgabe zeigen" : "Show Autark to-do");
        view.setOnClickListener((v) -> { place.edit().putBoolean("tab", false).apply(); show(Look.DOT); });
        return view;
    }

    private void toTab(boolean left) {
        place.edit().putBoolean("tab", true).putBoolean("left", left).putInt("y", params.y).apply();
        show(Look.TAB);
    }

    // ------------------------------------------------------------------ hiding: the ✕ target while the dot is dragged

    /** The ✕ at the bottom centre, its own window that never takes a touch (the dot's drag goes on above it). */
    private void showBin() {
        if (bin != null) return;
        bin = new TextView(service);
        bin.setText("✕");
        bin.setTextColor(Color.WHITE);
        bin.setTextSize(22);
        bin.setGravity(Gravity.CENTER);
        GradientDrawable round = new GradientDrawable();
        round.setShape(GradientDrawable.OVAL);
        round.setColor(BG);
        bin.setBackground(round);
        bin.setAlpha(0.85f);
        bin.setContentDescription(german ? "Hierher ziehen zum Ausblenden" : "Drop here to hide");
        int[] screen = screen();
        int[] at = TodoPlace.binCorner(screen[0], screen[1], dp(BIN_DP), dp(BIN_GAP_DP));
        WindowManager.LayoutParams binAt = new WindowManager.LayoutParams(dp(BIN_DP), dp(BIN_DP),
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                PixelFormat.TRANSLUCENT);
        binAt.gravity = Gravity.TOP | Gravity.START;
        inScreen(binAt);
        binAt.x = at[0];
        binAt.y = at[1];
        overBin = false;
        try { windows.addView(bin, binAt); } catch (RuntimeException error) { bin = null; }
    }

    /** The finger over the ✕: it turns red and a little bigger (in place – nothing else moves). */
    private void nearBin(float fingerX, float fingerY) {
        if (bin == null) return;
        int[] screen = screen();
        int[] at = TodoPlace.binCorner(screen[0], screen[1], dp(BIN_DP), dp(BIN_GAP_DP));
        boolean near = TodoPlace.near(fingerX, fingerY, at[0] + dp(BIN_DP) / 2f, at[1] + dp(BIN_DP) / 2f, dp(BIN_NEAR_DP));
        if (near == overBin) return;
        overBin = near;
        ((GradientDrawable) bin.getBackground()).setColor(near ? RED : BG);
        bin.setScaleX(near ? 1.2f : 1f);
        bin.setScaleY(near ? 1.2f : 1f);
    }

    private void removeBin() {
        if (bin != null) { try { windows.removeView(bin); } catch (RuntimeException ignored) { /* already gone */ } }
        bin = null;
        overBin = false;
    }

    /** Dropped onto ✕: the dot keeps the place it had before the drag and goes until the person pulls it out in the app. */
    private void hide(int x, int y) {
        place.edit().putInt("x", x).putInt("y", y).putBoolean(HIDDEN, true).apply();
        sync();
        Toast.makeText(service, german ? "Blase aus – zieh sie in der Autark-App aus dem runden Symbol oben wieder heraus." : "Bubble hidden – pull it out again from the round icon at the top of the Autark app.", Toast.LENGTH_LONG).show();
    }

    // ------------------------------------------------------------------ the app's pull (BubblePull)

    /** Whether the button is on the screen now (the app's header icon shows it quietly then). */
    boolean out() { return root != null; }

    /** The app's pull: the dot comes out with its middle under the finger (screen px; x < 0: at its last place). */
    void comeOut(int x, int y) {
        SharedPreferences.Editor edit = place.edit().putBoolean(HIDDEN, false).putBoolean("tab", false);
        if (x >= 0) edit.putInt("x", x - dp(DOT_DP) / 2).putInt("y", y - dp(DOT_DP) / 2);
        edit.apply();
        sync();
        if (root == null) Toast.makeText(service, german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED, Toast.LENGTH_SHORT).show();
    }

    /** The finger moves on (screen px): the dot follows; `keep` stores the place (the drop). */
    void follow(int x, int y, boolean keep) {
        if (params == null || look != Look.DOT) return;
        int[] screen = screen();
        params.x = TodoPlace.clamp(x - dp(DOT_DP) / 2, dp(DOT_DP), screen[0]);
        params.y = TodoPlace.clamp(y - dp(DOT_DP) / 2, dp(DOT_DP), screen[1]);
        update();
        if (keep) place.edit().putInt("x", params.x).putInt("y", params.y).apply();
    }

    // ------------------------------------------------------------------ the hold: a quick task from the dot

    /** At the hold threshold start the same recorder as the panel, without touching the overlay. */
    private boolean holdStart() {
        if (busy || calling != null || look != Look.DOT) return false;
        return hold.begin(() -> {
            UseLink link = UseLink.linked();
            if (!Mic.allowed(service)) {
                holdProblem = german ? "Mikrofon nicht freigegeben – tippe auf das Mikrofon." : "Microphone not allowed – tap the mic to enable it.";
            } else if (link == null) {
                holdProblem = german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED;
            } else {
                Dictation take = new Dictation(service, link, language(), this::holdHeard, this::finishHoldTake);
                if (take.start()) {
                    holdTake = take;
                    holdLink = link;
                    dotRound.setStroke(dp(3), RED);
                } else {
                    take.cancel();
                    holdProblem = german ? "Das Mikrofon ging nicht auf." : "The microphone did not open.";
                }
            }
        });
    }

    /** Only a real lift takes the picture; if the recorder hit its limit, its words wait for the lift. */
    private void holdRelease() {
        hold.release(() -> {
            if (holdTake != null || (holdWords != null && !holdWords.isEmpty())) holdShot = captureAtSend();
            if (holdTake != null) finishHoldTake();
            else holdDone();
        });
    }

    private void finishHoldTake() {
        if (holdTake == null) return;
        dotRound.setStroke(dp(3), Color.WHITE);
        holdTake.finish();
    }

    private void holdHeard(String text, String problem) {
        if (holdTake == null) return;
        holdTake = null;
        holdWords = text.trim();
        holdProblem = problem;
        if (hold.released()) holdDone();
    }

    private void dropHold() {
        if (holdTake != null) holdTake.cancel();
        if (holdShot != null) holdShot.cancel(true);
        holdTake = null;
        holdWords = null;
        holdProblem = null;
        holdLink = null;
        holdShot = null;
        hold.reset();
        if (dotRound != null) dotRound.setStroke(0, Color.TRANSPARENT);
    }

    private String language() { return SpeechLang.tag(profileLanguage, Locale.getDefault().toLanguageTag()); }

    private void holdDone() {
        String text = holdWords == null ? "" : holdWords;
        String problem = holdProblem;
        UseLink link = holdLink;
        FutureTask<TodoPost.Shot> picture = holdShot;
        holdShot = null; // the send now owns the image
        dropHold();
        if (text.isEmpty() || problem != null || link != UseLink.linked()) {
            if (picture != null) picture.cancel(true);
            holdToPanel(text, null, problem != null ? problem
                    : link != UseLink.linked() ? unreachableLine()
                    : german ? "Nichts gehört – schreib es hier." : "Nothing heard – type it here.");
            return;
        }
        TodoPost quick = new TodoPost();
        busy = true;
        run(() -> {
            String note;
            try {
                String[] task = deliver(link, text, quick, requiredPicture(picture));
                if (task == null) throw new Failed(german ? "Der PC hat keine Aufgabe zurückgegeben." : "The PC gave no task back.");
                main.post(this::holdSent);
                return;
            } catch (Unreachable error) {
                note = unreachableLine();
            } catch (Failed error) {
                note = error.getMessage();
            } catch (RuntimeException error) {
                android.util.Log.w("autark", "to-do quick send failed: " + error.getClass().getName());
                note = german ? "Senden ging nicht." : "Sending failed.";
            }
            String line = note;
            main.post(() -> { busy = false; holdToPanel(text, quick.clientId(), line); });
        });
    }

    private void holdSent() {
        busy = false;
        if (dotMark == null) return;
        dotMark.setVisibility(View.GONE);
        dotCheck.setVisibility(View.VISIBLE);
        main.postDelayed(() -> { if (dotMark != null) { dotCheck.setVisibility(View.GONE); dotMark.setVisibility(View.VISIBLE); } }, DONE_MS);
    }

    /** Keep the words and failure in the panel. On retry capture the page again with the same client id. */
    private void holdToPanel(String words, String clientId, String note) {
        if (root == null) return;
        if (clientId != null) post.adopt(clientId);
        if (!words.isEmpty() && field != null) {
            String now = field.getText().toString().trim();
            setText(now.isEmpty() ? words : now + " " + words);
        }
        if (look != Look.PANEL) show(Look.PANEL);
        renderStrip();
        say(note);
    }

    // ------------------------------------------------------------------ the panel

    private LinearLayout makePanel() {
        LinearLayout view = new LinearLayout(service);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(dp(6), dp(4), dp(6), dp(6));
        GradientDrawable background = new GradientDrawable();
        background.setColor(BG);
        background.setCornerRadius(dp(16));
        view.setBackground(background);
        view.setAlpha(0.94f);
        LinearLayout row = new LinearLayout(service);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        ImageView camera = icon(R.drawable.ic_todo_camera, german ? "Noch ein Screenshot" : "One more screenshot", this::shoot);
        if (Build.VERSION.SDK_INT < 30) camera.setVisibility(View.GONE); // screenshots need Android 11
        row.addView(camera);
        mic = icon(R.drawable.ic_todo_mic, german ? "Diktieren" : "Dictate", this::dictate);
        row.addView(mic);
        row.addView(new View(service), new LinearLayout.LayoutParams(0, 1, 1));
        row.addView(icon(R.drawable.ic_todo_call, german ? "Anrufen" : "Call", this::call));
        row.addView(icon(R.drawable.ic_todo_send, german ? "Als Aufgabe senden" : "Send as a task", this::submit));
        row.addView(icon(R.drawable.ic_todo_close, german ? "Zuklappen" : "Collapse", this::collapse));
        view.addView(row, new LinearLayout.LayoutParams(-1, -2));
        field = new EditText(service);
        field.setTextColor(Color.WHITE);
        field.setHintTextColor(Color.argb(150, 255, 255, 255));
        field.setHint(german ? "Was ist zu tun?" : "What needs doing?");
        field.setTextSize(14);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        field.setMinLines(1);
        field.setMaxLines(4);
        field.setPadding(dp(8), dp(6), dp(8), dp(6));
        GradientDrawable box = new GradientDrawable();
        box.setColor(Color.argb(40, 255, 255, 255));
        box.setCornerRadius(dp(8));
        field.setBackground(box);
        field.setOnTouchListener((v, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) typeHere();
            return false;
        });
        field.setText(draft);
        draft = "";
        view.addView(field, new LinearLayout.LayoutParams(-1, -2));
        strip = new LinearLayout(service);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams stripAt = new LinearLayout.LayoutParams(-1, dp(THUMB_DP + 4));
        stripAt.topMargin = dp(4);
        view.addView(strip, stripAt);
        line = new TextView(service);
        line.setTextColor(Color.argb(220, 255, 255, 255));
        line.setTextSize(11);
        line.setMaxLines(2);
        LinearLayout.LayoutParams lineAt = new LinearLayout.LayoutParams(-1, -2);
        lineAt.topMargin = dp(2);
        view.addView(line, lineAt);
        renderStrip();
        say(null);
        return view;
    }

    private ImageView icon(int drawable, String says, Runnable action) {
        ImageView view = new ImageView(service);
        view.setImageResource(drawable);
        view.setContentDescription(says);
        view.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        view.setPadding(dp(7), dp(7), dp(7), dp(7));
        view.setOnClickListener((v) -> action.run());
        view.setLayoutParams(new LinearLayout.LayoutParams(dp(ICON_DP), dp(ICON_DP)));
        buttons.add(view);
        return view;
    }

    /** Open the draft without capturing a page the person has not sent. */
    private void open() {
        if (!busy && !hold.active() && look != Look.PANEL) show(Look.PANEL);
    }

    /** Back to the dot; the text and the shots stay for the next opening (gone only with the service). */
    private void collapse() {
        finishDictation();
        show(Look.DOT);
    }

    private void say(String text) {
        if (line == null) return;
        line.setText(text == null ? "" : text);
        line.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void setBusy(boolean on) {
        busy = on;
        for (ImageView button : buttons) button.setAlpha(on ? 0.4f : 1f);
    }

    // ------------------------------------------------------------------ screenshots

    private void shoot() {
        if (Build.VERSION.SDK_INT < 30 || busy || shooting) return;
        if (post.shots().size() >= TodoPost.MAX - 1) {
            say(german ? "Ein Platz bleibt für den Screenshot beim Senden frei." : "One slot is reserved for the screenshot taken on Send.");
            return;
        }
        endTyping(); // the keyboard is not part of the screenshot
        shooting = true;
        run(() -> {
            byte[][] jpeg = new byte[1][];
            Bitmap thumb = shot(jpeg);
            if (thumb == null || jpeg[0] == null) { main.post(() -> { shooting = false; say(german ? "Gerade kein Screenshot möglich." : "No screenshot right now."); }); return; }
            byte[] bytes = jpeg[0];
            main.post(() -> {
                shooting = false;
                if (!post.add(bytes)) return;
                thumbs.add(thumb);
                renderStrip();
                say(null);
            });
        });
    }

    /** One screenshot (the worker thread): its JPEG (longest side at most 1600 px, quality 85) into jpeg[0], the thumbnail
     *  returned; null when Android gave none. */
    private Bitmap shot(byte[][] jpeg) throws InterruptedException {
        Bitmap full = service.capture();
        if (full == null) { // Android hands out one per second: once more after that
            Thread.sleep(1_100);
            full = service.capture();
        }
        if (full == null) return null;
        Bitmap scaled = scaleShot(full);
        jpeg[0] = shotJpeg(scaled);
        int thumbHeight = dp(THUMB_DP);
        return Bitmap.createScaledBitmap(scaled, Math.max(1, Math.round(scaled.getWidth() * thumbHeight / (float) scaled.getHeight())), thumbHeight, true);
    }

    private static Bitmap scaleShot(Bitmap full) {
        int[] size = TodoPlace.shotSize(full.getWidth(), full.getHeight());
        return size[0] == full.getWidth() ? full : Bitmap.createScaledBitmap(full, size[0], size[1], true);
    }

    private static byte[] shotJpeg(Bitmap scaled) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        return scaled.compress(Bitmap.CompressFormat.JPEG, 85, out) ? out.toByteArray() : null;
    }

    /** Queue before dictation finishes or the link is probed. No delayed retry on a later page. */
    private FutureTask<TodoPost.Shot> captureAtSend() {
        long deadline = SystemClock.elapsedRealtime() + 650;
        boolean keyboardWasOurs = typing;
        endTyping();
        FutureTask<TodoPost.Shot> picture = new FutureTask<>(() -> {
            Bitmap full = service.capture(deadline, keyboardWasOurs);
            if (full == null) return null;
            byte[] jpeg = shotJpeg(scaleShot(full));
            return jpeg == null ? null : new TodoPost.Shot(jpeg);
        });
        sendCapture.execute(picture);
        return picture;
    }

    private TodoPost.Shot requiredPicture(FutureTask<TodoPost.Shot> picture) throws Failed, InterruptedException {
        if (picture != null) {
            try {
                TodoPost.Shot shot = picture.get();
                if (shot != null) return shot;
            } catch (ExecutionException error) {
                android.util.Log.w("autark", "to-do send screenshot failed: " + error.getCause().getClass().getName());
            }
        }
        if (Build.VERSION.SDK_INT < 30) throw new Failed(german ? "Nicht gesendet – Screenshots brauchen Android 11 oder neuer." : "Not sent – screenshots require Android 11 or later.");
        throw new Failed(german ? "Nicht gesendet – kein Screenshot möglich. Prüfe die Bildschirmfreigabe für Autark und tippe erneut auf Senden."
                : "Not sent – no screenshot available. Check Autark’s screen access and tap Send again.");
    }

    /** The thumbnails, in the order of post.shots(). */
    private final List<Bitmap> thumbs = new ArrayList<>();

    private void renderStrip() {
        strip.removeAllViews();
        List<TodoPost.Shot> shots = post.shots();
        for (int i = 0; i < shots.size() && i < thumbs.size(); i++) {
            TodoPost.Shot shot = shots.get(i);
            Bitmap thumb = thumbs.get(i);
            ImageView view = new ImageView(service);
            view.setImageBitmap(thumb);
            view.setScaleType(ImageView.ScaleType.CENTER_CROP);
            view.setContentDescription((german ? "Screenshot " : "Screenshot ") + (i + 1) + (german ? " entfernen" : ", remove"));
            view.setOnClickListener((v) -> {
                if (busy) return;
                post.remove(shot);
                thumbs.remove(thumb);
                renderStrip();
            });
            LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(dp(THUMB_DP * 2 / 3), dp(THUMB_DP));
            at.setMarginEnd(dp(4));
            strip.addView(view, at);
        }
        strip.setVisibility(shots.isEmpty() ? View.GONE : View.VISIBLE);
        if (look == Look.PANEL && params != null) { // a taller panel stays whole on the screen
            int y = TodoPlace.clamp(params.y, panelHeight(), screen()[1]);
            if (y != params.y) { params.y = y; update(); }
        }
    }

    // ------------------------------------------------------------------ dictation

    /** The mic: a tap records (the mic orange), the next tap hands the take to the PC; its words land at the end of the field. */
    private void dictate() {
        if (busy) return;
        if (dictation != null) { finishDictation(); return; } // a second tap ends the take
        if (!Mic.allowed(service)) {
            collapse();
            openApp(); // the app asks for the microphone where the person sees why
            return;
        }
        UseLink link = UseLink.linked();
        if (link == null) { say(german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED); return; }
        endTyping();
        Dictation[] mine = new Dictation[1];
        mine[0] = new Dictation(service, link, language(), (text, problem) -> dictated(mine[0], text, problem), this::finishDictation);
        if (!mine[0].start()) { say(german ? "Das Mikrofon ging nicht auf." : "The microphone did not open."); return; }
        dictation = mine[0];
        transcribing = false;
        mic.setColorFilter(ORANGE); // Autark orange while it records
        say(german ? "Ich höre … tippe nochmal zum Beenden." : "Listening … tap again to finish.");
    }

    /** The take goes to the PC (a second mic tap, Collapse, Send); the mic is dimmed until the words are there. */
    private void finishDictation() {
        if (dictation == null || transcribing) return;
        transcribing = true;
        if (mic != null) { mic.clearColorFilter(); mic.setAlpha(0.4f); }
        say(german ? "Wird geschrieben …" : "Transcribing …");
        dictation.finish();
    }

    /** The PC heard the take: its words at the end of the field; then Send, when it waited for them. */
    private void dictated(Dictation take, String text, String problem) {
        if (dictation != take) return;
        dictation = null;
        transcribing = false;
        if (mic != null) { mic.clearColorFilter(); mic.setAlpha(1f); }
        if (!text.isEmpty()) {
            String now = field != null ? field.getText().toString() : draft;
            String next = SpokenAudio.join(now, text);
            if (field != null) setText(next); else draft = next;
        }
        say(problem != null ? problem : text.isEmpty() ? (german ? "Nichts verstanden." : "Didn't catch that.") : null);
        FutureTask<TodoPost.Shot> picture = sendAfter;
        UseLink link = sendLink;
        sendAfter = null;
        sendLink = null;
        if (picture == null) return;
        String words = field == null ? "" : field.getText().toString().trim();
        if (problem != null || (words.isEmpty() && post.shots().isEmpty()) || link != UseLink.linked()) {
            picture.cancel(true);
            setBusy(false);
            if (problem == null && link != UseLink.linked()) waitForPc(words, link);
            return;
        }
        submit(words, link, picture);
    }

    /** The take is dropped (the window goes, the link went): nothing more is sent. */
    private void dropDictation() {
        if (dictation != null) dictation.cancel();
        dictation = null;
        transcribing = false;
        if (sendAfter != null) { sendAfter.cancel(true); setBusy(false); }
        sendAfter = null;
        sendLink = null;
        if (mic != null) { mic.clearColorFilter(); mic.setAlpha(1f); }
    }

    // ------------------------------------------------------------------ send and call

    /** One RPC answer, or the PC's error as a Failed. */
    private static class Failed extends Exception { Failed(String message) { super(message); } }

    /** The PC was not reached (no answer, or no socket): the draft waits and goes out again with the same client id. */
    private static final class Unreachable extends Failed { Unreachable(String message) { super(message); } }

    private interface Job { void run() throws Exception; }

    private void run(Job job) {
        try {
            work.execute(() -> {
                try { job.run(); }
                catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
                catch (Exception error) { android.util.Log.w("autark", "to-do step failed: " + error.getClass().getName()); }
            });
        } catch (RuntimeException shutDown) { /* the service went off */ }
    }

    private void submit() {
        if (busy || calling != null) return;
        String text = field.getText().toString().trim();
        if (dictation == null && text.isEmpty() && post.shots().isEmpty()) {
            say(german ? "Schreib oder sag, was zu tun ist." : "Type or say what needs doing.");
            return;
        }
        UseLink link = UseLink.linked();
        if (link == null) { say(german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED); return; }
        setBusy(true);
        FutureTask<TodoPost.Shot> picture = captureAtSend();
        if (dictation != null) {
            sendAfter = picture;
            sendLink = link;
            finishDictation();
        } else {
            submit(text, link, picture);
        }
    }

    private void submit(String text, UseLink link, FutureTask<TodoPost.Shot> picture) {
        post.clientIdFor(text); // a fresh automatic shot alone never changes a retry's id
        say(german ? "Wird gesendet …" : "Sending …");
        run(() -> {
            try {
                String[] task = deliver(link, text, post, requiredPicture(picture));
                if (task == null) throw new Failed(german ? "Der PC hat keine Aufgabe zurückgegeben." : "The PC gave no task back.");
                main.post(this::sent);
            } catch (Unreachable error) {
                main.post(() -> { setBusy(false); waitForPc(text, link); });
            } catch (Failed error) {
                main.post(() -> { setBusy(false); say(error.getMessage()); });
            } catch (RuntimeException error) {
                android.util.Log.w("autark", "to-do send failed: " + error.getClass().getName());
                main.post(() -> { setBusy(false); say(german ? "Senden ging nicht." : "Sending failed."); });
            }
        });
    }

    /** The worker thread: every shot of `from` up (each once), then tasks.quickCreate with its client id; the task read
     *  from the answer, or null. */
    private String[] deliver(UseLink link, String text, TodoPost from, TodoPost.Shot currentPage) throws Failed, InterruptedException {
        if (link == null) throw new Unreachable(german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED);
        if (!reachable(link)) throw new Unreachable(german ? "Der PC hat nicht geantwortet." : "The PC did not answer.");
        List<String[]> attachments = new ArrayList<>();
        for (TodoPost.Shot shot : from.shotsWith(currentPage)) {
            String name = "screen-" + (attachments.size() + 1) + ".jpg";
            if (shot.fileId == null) {
                String id = TodoPost.fileId(answer(link, "files.upload", TodoPost.upload(name, shot.jpeg)));
                if (id == null) throw new Failed(german ? "Der PC hat den Screenshot nicht angenommen." : "The PC did not take the screenshot.");
                shot.fileId = id;
            }
            attachments.add(new String[] { shot.fileId, name });
        }
        return TodoPost.task(answer(link, "tasks.quickCreate", TodoPost.create(text, attachments, from.clientId())));
    }

    /** One call to the PC, waited for on this worker thread (at most CALL_MS). */
    private Object answer(UseLink link, String method, Map<String, Object> params) throws Failed, InterruptedException {
        try { return link.request(method, params, CALL_MS); }
        catch (UseLink.Refused refused) {
            String line = refused.late ? (german ? "Der PC hat nicht geantwortet." : "The PC did not answer.") : refused.getMessage();
            throw Resend.provesAlive(refused.late, refused.getMessage()) ? new Failed(line) : new Unreachable(line);
        }
    }

    /**
     * Before a send (a worker thread): a short ping. A socket that answers nothing is dropped and the link connects anew
     * (a phone whose network changed holds a dead socket that carries the draft nowhere; 20.11.: six recordings arrived after
     * 14 hours) - but this try ends: the new socket may sit on another PC below the same address, so only a new tap sends.
     */
    private boolean reachable(UseLink link) throws InterruptedException {
        if (link.alive(Resend.PING_MS)) return true;
        link.reconnect();
        return false;
    }

    /**
     * The PC did not answer: the draft stays in the panel and goes out only when the person sends it again. The address of the
     * link (UseLink.origin) does not name the PC - the company proxy can switch its target below the same address - so no
     * automatic retry: a draft never goes to a PC the person did not see it for.
     */
    private void waitForPc(String text, UseLink link) {
        say(unreachableLine());
    }

    private String unreachableLine() {
        return german ? "Nicht gesendet – dein PC ist nicht erreichbar. Tippe auf Senden, wenn er wieder da ist."
                : "Not sent – your PC is not reachable. Tap send when it is back.";
    }

    /** The task is there: ✓, the draft empty, back to the dot. */
    private void sent() {
        draftSent();
        say("✓");
        main.postDelayed(() -> { setBusy(false); say(null); if (look == Look.PANEL) collapse(); }, DONE_MS);
    }

    /** The draft went out as a task: no text, no shots – the next opening starts a new draft. */
    private void draftSent() {
        post.clear();
        thumbs.clear();
        draft = "";
        if (field != null) setText("");
        if (strip != null) renderStrip();
    }

    // ------------------------------------------------------------------ the call in the bubble (BubbleCall)

    /** The panel's call: it folds to the dot and the bubble listens; the first line (or the typed text) finds the agent. */
    private void call() {
        if (busy || calling != null) return;
        if (!Mic.allowed(service)) {
            collapse();
            openApp(); // the app asks for the microphone where the person sees why
            return;
        }
        dropDictation();
        UseLink link = UseLink.linked();
        if (link == null) { say(german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED); return; }
        String typed = field.getText().toString().trim();
        post.clientId(); // a retry after a failure sends the same one
        collapse();
        calling = new BubbleCall(service, link, language(), new BubbleCall.Host() {
            @Override public String[] route(String text) throws Exception { return TodoButton.this.route(link, text); }
            @Override public void look(String initial, boolean hearing) { callLook(initial, hearing); }
            @Override public void over(String line) { callOver(line); }
            @Override public void note(String line) { if (line != null && !line.isEmpty()) Toast.makeText(service, line, Toast.LENGTH_SHORT).show(); }
        });
        calling.start(typed);
    }

    /** BubbleCall's worker: the line and the draft's shots as a task (the draft empties once it is in); the agent's 1:1
     *  {chatId, agentId}, or null when no agent took the task. */
    private String[] route(UseLink link, String text) throws Failed, InterruptedException {
        String[] task;
        try {
            task = deliver(link, text, post, null);
        } catch (Failed | RuntimeException error) {
            main.post(() -> keepSaid(text)); // nothing said is lost
            throw error instanceof Failed ? (Failed) error : new Failed(german ? "Senden ging nicht." : "Sending failed.");
        }
        if (task == null) {
            main.post(() -> keepSaid(text));
            throw new Failed(german ? "Der PC hat keine Aufgabe zurückgegeben." : "The PC gave no task back.");
        }
        main.post(this::draftSent);
        String agent = TodoPost.callee(task);
        if (agent == null) return null;
        Object chat;
        try { chat = answer(link, "chats.direct", Json.map("memberId", agent)); }
        catch (Failed refused) { throw new Failed((german ? "Die Aufgabe ist drin, der Anruf ging nicht: " : "The task is in, the call did not start: ") + refused.getMessage()); }
        @SuppressWarnings("unchecked") String chatId = chat instanceof Map ? Json.str((Map<String, Object>) chat, "id") : null;
        if (chatId == null) throw new Failed(german ? "Die Aufgabe ist drin, der Anruf ging nicht." : "The task is in, the call did not start.");
        return new String[] { chatId, agent };
    }

    /** A first line that did not go out lands in the draft's text (typed text that went with it is there already). */
    private void keepSaid(String text) {
        String now = field != null ? field.getText().toString().trim() : draft.trim();
        if (now.contains(text)) return;
        String next = now.isEmpty() ? text : now + " " + text;
        if (field != null) setText(next); else draft = next;
    }

    /** The dot during the call: fully visible, a ring (orange while I listen, white while the phone speaks or connects)
     *  and the agent's initial once known. */
    private void callLook(String initial, boolean hearing) {
        if (dot == null || root == null || calling == null) return;
        dot.setAlpha(1f);
        dot.setContentDescription(german ? "Anruf beenden" : "End call");
        dotRound.setStroke(dp(3), hearing ? ORANGE : Color.WHITE);
        boolean letter = initial != null;
        dotMark.setVisibility(letter ? View.GONE : View.VISIBLE);
        dotCheck.setText(letter ? initial : "✓");
        dotCheck.setVisibility(letter ? View.VISIBLE : View.GONE);
    }

    /** The call is over: the dot as before; a line (no agent, a failure, the link gone) opens the panel with it – without a screenshot. */
    private void callOver(String line) {
        calling = null;
        if (dot == null || root == null) return;
        dot.setAlpha(0.72f);
        dot.setContentDescription(german ? "Autark-Aufgabe" : "Autark to-do");
        dotRound.setStroke(0, Color.TRANSPARENT);
        dotCheck.setVisibility(View.GONE);
        dotCheck.setText("✓");
        dotMark.setVisibility(View.VISIBLE);
        if (line == null) return;
        if (look != Look.PANEL) show(Look.PANEL);
        renderStrip();
        say(line);
    }

    /** Ends the call in the bubble, if one runs (its over() comes back here). */
    private void endCall() {
        BubbleCall running = calling;
        if (running != null) running.end();
    }

    /** The app on screen where it was (the microphone right is asked there). */
    private void openApp() {
        Intent intent = new Intent(service, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { service.startActivity(intent); } catch (RuntimeException error) { say(german ? "Die App ging nicht auf." : "The app did not open."); }
    }
}
