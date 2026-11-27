// Owns: the person's small to-do button over every app (an accessibility overlay of UseService: no extra permission),
// shown while this phone is paired (UseLink.linked()), also while the Autark app is closed. Three looks in one window:
// the dot (40 dp, the Autark mark, see-through; a drag beyond the touch slop moves it, a tap opens the panel, a drop
// with the finger at a side edge – or an accessibility long-click – turns it into the tab), the tab (10 × 36 dp at the nearest side edge; a
// tap brings the dot back) and the panel beside the dot: call and close (back to the dot) at its top, a strip of what
// goes along (shots and photos as small pictures, recordings and files as chips; a tap removes one), the input line as
// in a chat (owner 24.11.2026, task_r0y9wcex: "hinter einem Plus-Symbol … in eine Eingabezeile … Rechts … den
// Senden-Button") – [+] [text field, 1 line up to 4] [mic: dictate] [send] – and one short status line. The plus opens a
// small menu above the line: Screenshot (the camera icon as before: one more shot of the screen, at most TodoPost.MAX),
// Photo (the camera app through BubblePick; the panel folds to the dot meanwhile and comes back with the photo), Audio
// (AudioNote records the sound as a file – sent as audio, never transcribed; the plus turns into a red stop, which
// attaches it) and File (Android's picker through BubblePick, several at once). Opening does not capture the screen;
// Send captures the current screen (UseService.capture hides both overlays) before any line can go out.
// Dictation (owner 20.11.2026: as good as the app's own – the phone's recognizer heard "We got to steer" for "Wie geht es
// dir?") records the voice and the PC hears it, the same path as the app's composer (Dictation: WAV pieces,
// files.upload, voice.transcribe in the profile's language); the words land at the end of the field once the PC has
// heard them; without the microphone right the mic opens the app instead. Send (owner 26.11.2026, task_cxs4s3pt: asking
// the bubble is asking the agent, not a to-do): every shot goes up (files.upload), every file of the plus menu in
// pieces (files.uploadChunk), and one line with the text, the shots, the files and the post's client id goes into the chat the person used last (BubbleChat: ui.state's lastConversationId, never a
// guessed one – without it nothing goes out and the panel says why); ✓, a toast names the agent it went to, then empty
// and back to the dot. The answer comes in that chat. Call (owner 19.11.2026:
// without the app coming up): the panel folds to the dot and the call runs in the bubble (BubbleCall) – in that same
// chat with its agent (the draft's shots go there first as a silent line), the dot
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
// The quick area (owner 24.11.2026, task_r0y9wcex: "so ein Pfeil nach oben und dann klappt über dem Fenster … noch ein
// kleiner Bereich auf"): the arrow at the head's left opens a narrow part above the head – the panel grows upwards – with
// the newest important unread lines (BubbleQuick: chats.list and messages.list, one line each; a tap opens that chat in
// the app), Tasks (the app's Tasks page) and the lock-screen choice (BubbleSettings); it loads on its own thread and
// remembers whether it was open. The lock screen (BubbleLock): until the person chose, and in Off, the bubble goes while
// the keyguard shows or the screen is off (the screen and unlock broadcasts and BubbleSettings' change call sync); in On
// it stays; in On with a note every line sent while locked carries the note for the agent, and calls need On. The first
// opening asks once in the panel, never while locked; while locked the quick area shows only how many important lines
// wait, and nothing changes the choice.
// Never: keeps the person's text or shots anywhere but this panel and the RPC, or shows in the AI's screenshot.
package com.teydralab.autark.android.phoneuse;

import android.accessibilityservice.AccessibilityService;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.PowerManager;
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
import android.text.TextUtils;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import com.teydralab.autark.android.MainActivity;
import com.teydralab.autark.android.PhoneRoutes;
import com.teydralab.autark.android.R;
import com.teydralab.autark.android.relay.Json;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
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
    private static final int PANEL_DP = 264;
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
    private volatile boolean german; // the profile language from the PC (UiLang), English until one arrives
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
    private HorizontalScrollView stripScroll;
    private TextView line;
    private ImageView mic;
    /** The input line's plus and the menu it opens; the audio recording running now, or null. */
    private ImageView plus;
    private LinearLayout menu;
    private AudioNote recording;
    /** The small pictures of photos and picked images (shots keep theirs in `thumbs`). */
    private final Map<TodoPost.Item, Bitmap> fileThumbs = new HashMap<>();
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

    /** The lock screen (BubbleLock): the keyguard and the screen, and the broadcasts that say they changed. */
    private final KeyguardManager keyguard;
    private final PowerManager power;
    private boolean watchingLock;
    private final BroadcastReceiver lockChanged = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { main.post(TodoButton.this::sync); }
    };
    /** BubbleSettings (or the panel's question) changed the lock-screen choice: the bubble follows at once. Held here: the
     *  preferences keep only a weak reference to it. */
    private final SharedPreferences.OnSharedPreferenceChangeListener lockChoice = (preferences, key) -> {
        if (BubbleLock.KEY.equals(key)) main.post(this::lockChoiceChanged);
    };
    /** The quick area above the panel (BubbleQuick): its view, its arrow, the first question and what it shows now. */
    private static final String QUICK_OPEN = "quick_open";
    private static final long QUICK_MS = 10_000;
    private LinearLayout quick;
    private ImageView quickArrow;
    private LinearLayout ask;
    /** What the quick area shows: rows {chatId, text} (null while it loads), else quickProblem; the important count; whether the words show (unlocked). */
    private List<String[]> quickRows;
    private String quickProblem;
    private int quickCount;
    private boolean quickReadable;
    private int quickRound;
    private final ExecutorService quickWork = Executors.newSingleThreadExecutor((job) -> {
        Thread thread = new Thread(job, "autark-todo-quick");
        thread.setDaemon(true);
        return thread;
    });

    TodoButton(UseService service) {
        this.service = service;
        this.windows = (WindowManager) service.getSystemService(AccessibilityService.WINDOW_SERVICE);
        this.place = service.getSharedPreferences("todo_button", Context.MODE_PRIVATE);
        this.density = service.getResources().getDisplayMetrics().density;
        this.profileLanguage = SpeechLang.valid(place.getString("speech_lang", null));
        this.german = UiLang.german(profileLanguage);
        this.keyguard = (KeyguardManager) service.getSystemService(Context.KEYGUARD_SERVICE);
        this.power = (PowerManager) service.getSystemService(Context.POWER_SERVICE);
    }

    /** Shows while this phone is paired, from now on (the main thread). */
    void start() {
        UseLink.onLinked(onLink);
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        try {
            if (Build.VERSION.SDK_INT >= 33) service.registerReceiver(lockChanged, filter, Context.RECEIVER_NOT_EXPORTED);
            else service.registerReceiver(lockChanged, filter);
            watchingLock = true;
        } catch (RuntimeException error) { android.util.Log.w("autark", "lock screen broadcasts unavailable: " + error.getClass().getName()); }
        place.registerOnSharedPreferenceChangeListener(lockChoice);
        sync();
    }

    /** The service went off: the button goes for good (any thread). */
    void close() {
        UseLink.onLinked(null);
        work.shutdownNow();
        sendCapture.shutdownNow();
        quickWork.shutdownNow();
        main.post(() -> {
            closed = true;
            if (watchingLock) { try { service.unregisterReceiver(lockChanged); } catch (RuntimeException ignored) { /* gone */ } watchingLock = false; }
            place.unregisterOnSharedPreferenceChangeListener(lockChoice);
            stopAudio(false); dropDictation(); dropHold(); remove();
        });
    }

    /** Whether the phone is locked now: the keyguard shows, or the screen is off (it locks soon; the bubble goes first). */
    private boolean locked() {
        boolean keyguardUp = keyguard != null && keyguard.isKeyguardLocked();
        boolean screenOff = power != null && !power.isInteractive();
        return keyguardUp || screenOff;
    }

    /** The choice changed (BubbleSettings or the panel's question): the bubble follows, the question goes, the quick area's row says it. */
    private void lockChoiceChanged() {
        sync();
        if (BubbleLock.chosen(lockChoiceNow())) grow(ask, false);
        renderQuickLater();
    }

    /** The lock-screen choice as stored (null until the person chose). */
    private String lockChoiceNow() { return place.getString(BubbleLock.KEY, null); }

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
        boolean locked = locked();
        if (UseLink.linked() != null && !place.getBoolean(HIDDEN, false) && BubbleLock.shows(lockChoiceNow(), locked)) {
            boolean fresh = root == null;
            ensure();
            refreshLanguage();
            if (!fresh && quickReadable != BubbleLock.readable(locked)) loadQuick(); // locked or unlocked meanwhile: words or only the count
            if (calling != null && !BubbleLock.calls(lockChoiceNow(), locked)) endCall(); // locked during a call in NOTE: its lines would go without the note
        } else { languageFor = null; dropDictation(); remove(); }
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
                german = UiLang.german(found);
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
        stopAudio(true); // a recording whose window goes stays in the draft
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
        if (next != Look.PANEL) showMenu(false);
        if (next != Look.PANEL) { quick.setVisibility(View.GONE); ask.setVisibility(View.GONE); }
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
        boolean wasLocked = locked(); // as the finger lifted
        String choice = lockChoiceNow();
        run(() -> {
            String note;
            try {
                String[] chat = deliver(link, text, quick, requiredPicture(picture), choice, wasLocked);
                main.post(() -> { holdSent(); sentTo(chat); });
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
        // above the head: the first question (the lock screen, once) and the quick area the arrow opens
        ask = makeAsk();
        LinearLayout.LayoutParams askAt = new LinearLayout.LayoutParams(-1, -2);
        askAt.topMargin = dp(2);
        view.addView(ask, askAt);
        quick = new LinearLayout(service);
        quick.setOrientation(LinearLayout.VERTICAL);
        quick.setPadding(dp(4), dp(2), dp(4), dp(2));
        GradientDrawable quickBox = new GradientDrawable();
        quickBox.setColor(Color.argb(40, 255, 255, 255));
        quickBox.setCornerRadius(dp(10));
        quick.setBackground(quickBox);
        quick.setVisibility(View.GONE);
        LinearLayout.LayoutParams quickAt = new LinearLayout.LayoutParams(-1, -2);
        quickAt.topMargin = dp(2);
        view.addView(quick, quickAt);
        // the head: the quick area's arrow, call and collapse
        LinearLayout head = new LinearLayout(service);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        quickArrow = icon(R.drawable.ic_todo_up, german ? "Wichtiges und Aufgaben zeigen" : "Show what matters and tasks", this::toggleQuick);
        head.addView(quickArrow);
        head.addView(new View(service), new LinearLayout.LayoutParams(0, 1, 1));
        head.addView(icon(R.drawable.ic_todo_call, german ? "Anrufen" : "Call", this::call));
        head.addView(icon(R.drawable.ic_todo_close, german ? "Zuklappen" : "Collapse", this::collapse));
        view.addView(head, new LinearLayout.LayoutParams(-1, -2));
        // what goes along: shots, photos, recordings, files
        stripScroll = new HorizontalScrollView(service);
        stripScroll.setHorizontalScrollBarEnabled(false);
        strip = new LinearLayout(service);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        strip.setGravity(Gravity.CENTER_VERTICAL);
        stripScroll.addView(strip, new FrameLayout.LayoutParams(-2, -1));
        LinearLayout.LayoutParams stripAt = new LinearLayout.LayoutParams(-1, dp(THUMB_DP + 4));
        stripAt.bottomMargin = dp(4);
        view.addView(stripScroll, stripAt);
        // the plus menu, above the input line
        menu = makeMenu();
        LinearLayout.LayoutParams menuAt = new LinearLayout.LayoutParams(-1, -2);
        menuAt.bottomMargin = dp(4);
        view.addView(menu, menuAt);
        // the input line as in a chat: [+] [text] [mic] [send]
        LinearLayout input = new LinearLayout(service);
        input.setOrientation(LinearLayout.HORIZONTAL);
        input.setGravity(Gravity.CENTER_VERTICAL);
        plus = icon(R.drawable.ic_todo_plus, german ? "Anhängen" : "Attach", this::plusTapped);
        input.addView(plus);
        field = new EditText(service);
        field.setTextColor(Color.WHITE);
        field.setHintTextColor(Color.argb(150, 255, 255, 255));
        field.setHint(german ? "Frag oder schreib etwas" : "Ask or write something");
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
        input.addView(field, new LinearLayout.LayoutParams(0, -2, 1));
        mic = icon(R.drawable.ic_todo_mic, german ? "Diktieren" : "Dictate", this::dictate);
        input.addView(mic);
        input.addView(icon(R.drawable.ic_todo_send, german ? "In den Chat senden" : "Send to the chat", this::submit));
        view.addView(input, new LinearLayout.LayoutParams(-1, -2));
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

    // ------------------------------------------------------------------ the quick area and the lock-screen question

    /** The first question (BubbleLock): its title, one line, and a button per choice; GONE until the first opening. */
    private LinearLayout makeAsk() {
        LinearLayout box = new LinearLayout(service);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(8), dp(6), dp(8), dp(6));
        GradientDrawable round = new GradientDrawable();
        round.setColor(Color.argb(40, 255, 255, 255));
        round.setCornerRadius(dp(10));
        box.setBackground(round);
        TextView title = new TextView(service);
        title.setText(BubbleLock.title(german) + "?");
        title.setTextColor(Color.WHITE);
        title.setTextSize(13);
        box.addView(title, new LinearLayout.LayoutParams(-1, -2));
        TextView why = new TextView(service);
        why.setText(german ? "Darf die Blase auch bei gesperrtem Handy da sein? Ändern kannst du das jederzeit über den Pfeil oben in der Blase oder in Android unter App-Info › Autark."
                : "May the bubble be there while the phone is locked? You can change this any time with the arrow at the top of the bubble, or in Android's App info › Autark.");
        why.setTextColor(Color.argb(200, 255, 255, 255));
        why.setTextSize(11);
        box.addView(why, new LinearLayout.LayoutParams(-1, -2));
        for (String value : BubbleLock.ORDER) {
            TextView choice = new TextView(service);
            choice.setText(BubbleLock.label(value, german));
            choice.setTextColor(Color.WHITE);
            choice.setTextSize(13);
            choice.setGravity(Gravity.CENTER_VERTICAL);
            choice.setPadding(dp(10), dp(7), dp(10), dp(7));
            GradientDrawable pill = new GradientDrawable();
            pill.setColor(Color.argb(60, 255, 255, 255));
            pill.setCornerRadius(dp(8));
            choice.setBackground(pill);
            choice.setContentDescription(BubbleLock.label(value, german) + ". " + BubbleLock.explain(value, german));
            choice.setOnClickListener((v) -> chooseLock(value));
            LinearLayout.LayoutParams at = new LinearLayout.LayoutParams(-1, -2);
            at.topMargin = dp(4);
            box.addView(choice, at);
        }
        box.setVisibility(View.GONE);
        return box;
    }

    /** The person's choice in the panel's question: stored, the question goes, the line says what it means. */
    private void chooseLock(String value) {
        if (locked()) return; // only an unlocked phone chooses
        place.edit().putString(BubbleLock.KEY, value).putBoolean(BubbleLock.ASKED, true).apply();
        grow(ask, false);
        say(BubbleLock.explain(value, german));
    }

    /** Shows or hides one part above the head so the head stays where it was: the panel grows upwards (and stays whole). */
    private void grow(View part, boolean on) {
        if (part == null || (part.getVisibility() == View.VISIBLE) == on) return;
        if (look != Look.PANEL || params == null) { part.setVisibility(on ? View.VISIBLE : View.GONE); return; }
        int before = panelHeight();
        part.setVisibility(on ? View.VISIBLE : View.GONE);
        moveBy(before);
    }

    /** After a part above the head changed its height (it was `before`): the panel's top moves by the difference, then stays whole. */
    private void moveBy(int before) {
        if (look != Look.PANEL || params == null) return;
        int after = panelHeight();
        int y = Math.max(0, params.y - (after - before));
        params.y = TodoPlace.clamp(y, after, screen()[1]);
        if (yBeforeKeyboard >= 0) yBeforeKeyboard = Math.max(0, yBeforeKeyboard - (after - before));
        update();
    }

    /** The arrow: up while the area is closed, down while it is open. */
    private void renderArrow() {
        if (quickArrow == null || quick == null) return;
        boolean on = quick.getVisibility() == View.VISIBLE;
        quickArrow.setRotation(on ? 180f : 0f);
        quickArrow.setContentDescription(on ? (german ? "Wichtiges zuklappen" : "Close what matters")
                : (german ? "Wichtiges und Aufgaben zeigen" : "Show what matters and tasks"));
    }

    /** The arrow's tap: the area opens (and loads) or closes; the choice is kept for the next opening. */
    private void toggleQuick() {
        if (quick == null) return;
        boolean on = quick.getVisibility() != View.VISIBLE;
        place.edit().putBoolean(QUICK_OPEN, on).apply();
        if (on) grow(ask, false); // one part at a time above the head
        grow(quick, on);
        renderArrow();
        if (on) loadQuick();
    }

    /**
     * The quick area's news from the PC (its own thread, so a slow PC never holds a send): chats.list, and while unlocked
     * messages.list of the few chats with important unread lines (BubbleQuick). While locked only the count – nobody
     * holding a locked phone reads the words. An older round's late answer changes nothing.
     */
    private void loadQuick() {
        if (quick == null || quick.getVisibility() != View.VISIBLE) return;
        int round = ++quickRound;
        boolean readable = BubbleLock.readable(locked());
        quickReadable = readable;
        quickRows = null;
        quickProblem = null;
        renderQuick();
        UseLink link = UseLink.linked();
        if (link == null) { quickProblem = german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED; renderQuick(); return; }
        try {
            quickWork.execute(() -> {
                List<String[]> rows = new ArrayList<>();
                int count;
                String problem = null;
                try {
                    Object list = link.request("chats.list", Json.map(), QUICK_MS);
                    count = BubbleQuick.count(list);
                    if (readable) {
                        for (BubbleQuick.Chat chat : BubbleQuick.chats(list)) {
                            Object messages = null;
                            try { messages = link.request("messages.list", Json.map("conversationId", chat.id, "limit", BubbleQuick.PAGE), QUICK_MS); }
                            catch (UseLink.Refused unread) { /* its preview stands in */ }
                            rows.add(new String[] { chat.id, BubbleQuick.row(chat, BubbleQuick.newest(messages)) });
                        }
                    }
                } catch (UseLink.Refused refused) {
                    count = 0;
                    problem = refused.late ? (german ? "Der PC hat nicht geantwortet." : "The PC did not answer.") : refused.getMessage();
                } catch (InterruptedException stop) {
                    Thread.currentThread().interrupt();
                    return;
                } catch (RuntimeException error) {
                    android.util.Log.w("autark", "quick area failed: " + error.getClass().getName());
                    count = 0;
                    problem = german ? "Ging gerade nicht." : "Not available right now.";
                }
                int found = count;
                String line = problem;
                main.post(() -> {
                    if (round != quickRound || closed) return;
                    quickCount = found;
                    quickProblem = line;
                    quickRows = line == null ? rows : null;
                    renderQuick();
                });
            });
        } catch (RuntimeException shutDown) { /* the service went off */ }
    }

    /** The lock-screen choice changed while the area is open: its row says the new one. */
    private void renderQuickLater() { if (quick != null && quick.getVisibility() == View.VISIBLE) renderQuick(); }

    /** The quick area's rows: the important lines (or how many, while locked), Tasks, and the lock-screen choice. */
    private void renderQuick() {
        if (quick == null) return;
        int before = quick.getVisibility() == View.VISIBLE ? panelHeight() : -1;
        quick.removeAllViews();
        quick.addView(quickHeading(german ? "Wichtig" : "Important"));
        if (quickProblem != null) {
            quick.addView(quickRow(quickProblem, null, false));
        } else if (quickRows == null) {
            quick.addView(quickRow(german ? "Lädt …" : "Loading …", null, false));
        } else if (!quickReadable || quickRows.isEmpty()) {
            quick.addView(quickRow(BubbleQuick.waiting(quickReadable ? 0 : quickCount, german), null, false));
        } else {
            for (String[] row : quickRows) {
                String route = PhoneRoutes.chat(row[0]);
                quick.addView(quickRow("● " + row[1], route == null ? null : () -> openRoute(route), false));
            }
            int more = quickCount - quickRows.size();
            if (more > 0) quick.addView(quickRow(german ? "… und " + more + " weitere in den Chats" : "… and " + more + " more in the chats", () -> openRoute("#/chats"), false));
        }
        quick.addView(quickRow((german ? "Aufgaben" : "Tasks") + "  ›", () -> openRoute("#/tasks"), true));
        quick.addView(quickRow(BubbleLock.row(lockChoiceNow(), german) + "  ›", this::lockSettings, true));
        if (before >= 0) moveBy(before);
    }

    private TextView quickHeading(String text) {
        TextView view = new TextView(service);
        view.setText(text);
        view.setTextColor(Color.argb(170, 255, 255, 255));
        view.setTextSize(10);
        view.setAllCaps(true);
        view.setPadding(dp(4), dp(2), dp(4), 0);
        return view;
    }

    /** One line of the quick area: single line, cut at the end; a tap does `action` (none: plain text). */
    private TextView quickRow(String text, Runnable action, boolean strong) {
        TextView view = new TextView(service);
        view.setText(text);
        view.setTextColor(action == null ? Color.argb(200, 255, 255, 255) : Color.WHITE);
        view.setTextSize(strong ? 13 : 12);
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
        view.setPadding(dp(4), dp(6), dp(4), dp(6));
        if (action != null) view.setOnClickListener((v) -> { if (!busy) action.run(); });
        view.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        return view;
    }

    /** A place of the app (a chat, Tasks): the panel folds to the dot and the app opens there (after unlocking, when locked). */
    private void openRoute(String route) {
        boolean wasLocked = locked();
        collapse();
        Intent intent = new Intent(service, MainActivity.class).putExtra(PhoneRoutes.EXTRA, route).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { service.startActivity(intent); } catch (RuntimeException error) { say(german ? "Die App ging nicht auf." : "The app did not open."); return; }
        if (wasLocked) Toast.makeText(service, german ? "Entsperre das Handy – Autark ist dann dort offen." : "Unlock the phone – Autark is open there then.", Toast.LENGTH_SHORT).show();
    }

    /** The lock-screen row: the settings dialog (BubbleSettings) – unlocked only. */
    private void lockSettings() {
        if (locked()) { say(german ? "Entsperre das Handy, um das zu ändern." : "Unlock the phone to change this."); return; }
        collapse();
        try { BubbleSettings.open(service); } catch (RuntimeException error) { say(german ? "Die Einstellung ging nicht auf." : "The setting did not open."); }
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

    // ------------------------------------------------------------------ the plus menu

    /** Screenshot (Android 11+), Photo, Audio, File – an icon with its word each; hidden until the plus opens it. */
    private LinearLayout makeMenu() {
        LinearLayout row = new LinearLayout(service);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(2), dp(2), dp(2), dp(2));
        GradientDrawable box = new GradientDrawable();
        box.setColor(Color.argb(40, 255, 255, 255));
        box.setCornerRadius(dp(10));
        row.setBackground(box);
        // screenshots need Android 11
        if (Build.VERSION.SDK_INT >= 30) row.addView(menuItem(R.drawable.ic_todo_camera, "Screenshot", german ? "Screenshot der Seite" : "Screenshot of this page", this::shoot), new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(menuItem(R.drawable.ic_todo_photo, german ? "Foto" : "Photo", german ? "Foto mit der Kamera" : "Take a photo", this::takePhoto), new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(menuItem(R.drawable.ic_todo_audio, "Audio", german ? "Audio aufnehmen und mitschicken" : "Record audio to send", this::recordAudio), new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(menuItem(R.drawable.ic_todo_file, german ? "Datei" : "File", german ? "Datei vom Handy anhängen" : "Attach a file from the phone", this::pickFiles), new LinearLayout.LayoutParams(0, -2, 1));
        row.setVisibility(View.GONE);
        return row;
    }

    private View menuItem(int drawable, String word, String says, Runnable action) {
        LinearLayout item = new LinearLayout(service);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setPadding(dp(2), dp(5), dp(2), dp(4));
        ImageView picture = new ImageView(service);
        picture.setImageResource(drawable);
        picture.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        item.addView(picture, new LinearLayout.LayoutParams(dp(24), dp(24)));
        TextView text = new TextView(service);
        text.setText(word);
        text.setTextColor(Color.WHITE);
        text.setTextSize(10);
        text.setSingleLine(true);
        text.setGravity(Gravity.CENTER);
        item.addView(text, new LinearLayout.LayoutParams(-2, -2));
        item.setContentDescription(says);
        item.setOnClickListener((v) -> {
            if (busy) return;
            showMenu(false);
            action.run();
        });
        buttons.add(picture);
        return item;
    }

    /** The plus: opens or closes the menu; while audio records it is the red stop, which attaches the recording. */
    private void plusTapped() {
        if (busy) return;
        if (recording != null) { stopAudio(true); return; }
        showMenu(menu != null && menu.getVisibility() != View.VISIBLE);
    }

    private void showMenu(boolean on) {
        if (menu == null || (menu.getVisibility() == View.VISIBLE) == on) return;
        menu.setVisibility(on ? View.VISIBLE : View.GONE);
        if (plus != null && recording == null) {
            plus.setRotation(on ? 45f : 0f); // the plus turns into a ✕ while the menu is open
            plus.setContentDescription(on ? (german ? "Menü schließen" : "Close the menu") : (german ? "Anhängen" : "Attach"));
        }
        keepWhole();
    }

    /** A taller panel stays whole on the screen. */
    private void keepWhole() {
        if (look == Look.PANEL && params != null) {
            int y = TodoPlace.clamp(params.y, panelHeight(), screen()[1]);
            if (y != params.y) { params.y = y; update(); }
        }
    }

    /** Photo: the camera app gets the screen (the panel folds to the dot) and the panel comes back with the photo. */
    private void takePhoto() {
        if (busy) return;
        if (post.files().size() >= TodoPost.FILES_MAX) { say(refusedLine(TodoPost.TOO_MANY)); return; }
        collapse();
        BubblePick.photo(service, dp(THUMB_DP), this::picked);
    }

    /** File: Android's picker (several at once); the panel comes back with them. */
    private void pickFiles() {
        if (busy) return;
        if (post.files().size() >= TodoPost.FILES_MAX) { say(refusedLine(TodoPost.TOO_MANY)); return; }
        collapse();
        BubblePick.files(service, dp(THUMB_DP), this::picked);
    }

    /** BubblePick came back (main thread): its files join the draft, named for the agent; the panel opens with them. */
    private void picked(List<BubblePick.Got> got, String problem) {
        String note = problem;
        for (BubblePick.Got one : got) {
            boolean photo = TodoPost.Item.PHOTO.equals(one.kind);
            int next = post.count(one.kind) + 1;
            String name = photo ? BubbleChat.photoName(next) : BubbleChat.fileName(one.name, next);
            TodoPost.Item item = new TodoPost.Item(one.kind, one.file.getPath(), name, one.mime, one.bytes, 0);
            String refused = post.attach(item);
            if (refused != null) { one.file.delete(); note = refusedLine(refused); continue; }
            if (one.thumb != null) fileThumbs.put(item, one.thumb);
        }
        if (root == null || closed) return;
        if (look != Look.PANEL) show(Look.PANEL);
        renderStrip();
        say(note);
    }

    private String refusedLine(String why) {
        if (TodoPost.TOO_BIG.equals(why)) return german ? "Eine Datei darf höchstens 50 MB groß sein." : "A file can be at most 50 MB.";
        if (TodoPost.TOO_MUCH.equals(why)) return german ? "Höchstens 100 MB an Dateien pro Nachricht." : "At most 100 MB of files per message.";
        return german ? "Höchstens " + TodoPost.FILES_MAX + " Dateien pro Nachricht." : "At most " + TodoPost.FILES_MAX + " files per message.";
    }

    // ------------------------------------------------------------------ audio: a recording sent as sound (AudioNote)

    /** Audio: the microphone records into a file until the red stop (the plus) – sent as audio, never transcribed. */
    private void recordAudio() {
        if (busy || recording != null || calling != null) return;
        if (!Mic.allowed(service)) {
            collapse();
            openApp(); // the app asks for the microphone where the person sees why
            return;
        }
        if (post.files().size() >= TodoPost.FILES_MAX) { say(refusedLine(TodoPost.TOO_MANY)); return; }
        if (dictation != null) finishDictation(); // one microphone at a time: the dictated words still come
        endTyping();
        AudioNote note = new AudioNote(service, () -> stopAudio(true));
        if (!note.start()) { say(german ? "Das Mikrofon ging nicht auf." : "The microphone did not open."); return; }
        recording = note;
        showMenu(false);
        plus.setRotation(0f);
        plus.setImageResource(R.drawable.ic_todo_stop);
        plus.setColorFilter(RED);
        plus.setContentDescription(german ? "Aufnahme beenden und anhängen" : "Stop and attach the recording");
        main.post(recordTick);
    }

    /** While audio records: its time in the status line (and the level, which tells a silent take). */
    private final Runnable recordTick = new Runnable() {
        @Override public void run() {
            AudioNote note = recording;
            if (note == null) return;
            note.level();
            say((german ? "Audio läuft " : "Recording audio ") + BubbleChat.clock(note.elapsed()) + (german ? " – tippe auf ■ zum Anhängen." : " – tap ■ to attach."));
            main.postDelayed(this, 250);
        }
    };

    /** Ends the recording: `keep` attaches it to the draft (a chip), else it is dropped. True when a recording was attached. */
    private boolean stopAudio(boolean keep) {
        AudioNote note = recording;
        if (note == null) return false;
        recording = null;
        main.removeCallbacks(recordTick);
        if (plus != null) {
            plus.setImageResource(R.drawable.ic_todo_plus);
            plus.clearColorFilter();
            plus.setContentDescription(german ? "Anhängen" : "Attach");
        }
        if (!keep) { note.cancel(); say(null); return false; }
        AudioNote.Take take = note.stop();
        if (take == null) { say(german ? "Nichts aufgenommen." : "Nothing recorded."); return false; }
        if (take.silent) {
            take.file.delete();
            say(german ? "Android gibt der Blase gerade kein Mikrofon – die Aufnahme war stumm." : "Android gives the bubble no microphone right now – the recording was silent.");
            return false;
        }
        TodoPost.Item item = new TodoPost.Item(TodoPost.Item.AUDIO, take.file.getPath(),
                BubbleChat.audioName(take.ms, post.count(TodoPost.Item.AUDIO) + 1), "audio/mp4", take.file.length(), take.ms);
        String refused = post.attach(item);
        if (refused != null) { take.file.delete(); say(refusedLine(refused)); return false; }
        if (strip != null) renderStrip();
        say(null);
        return true;
    }

    /** Open the draft without capturing a page the person has not sent. */
    private void open() {
        if (busy || hold.active() || look == Look.PANEL) return;
        show(Look.PANEL);
        // the first opening asks once how the bubble behaves on the lock screen (never while locked: whoever holds a locked phone does not choose)
        if (!BubbleLock.chosen(lockChoiceNow()) && !place.getBoolean(BubbleLock.ASKED, false) && !locked()) {
            place.edit().putBoolean(BubbleLock.ASKED, true).apply();
            grow(ask, true);
        } else if (place.getBoolean(QUICK_OPEN, false)) {
            grow(quick, true);
            loadQuick();
        }
        renderArrow();
    }

    /** Back to the dot; the text, the shots and the files stay for the next opening (gone only with the service);
     *  a running recording is attached. */
    private void collapse() {
        finishDictation();
        stopAudio(true);
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

    /** Below the words for the agent when the phone cannot take a screenshot (Android 10 or older). English: the agent's line. */
    static final String NO_SHOT_NOTE = "\n\n(Sent from the bubble on Android 10 or older: no screenshot of the page is possible there.)";

    private TodoPost.Shot requiredPicture(FutureTask<TodoPost.Shot> picture) throws Failed, InterruptedException {
        if (picture != null) {
            try {
                TodoPost.Shot shot = picture.get();
                if (shot != null) return shot;
            } catch (ExecutionException error) {
                android.util.Log.w("autark", "to-do send screenshot failed: " + error.getCause().getClass().getName());
            }
        }
        // Android 8–10 (minSdk 26) cannot take a screenshot at all: the words go out without one and say so (deliver),
        // instead of a bubble that never sends there (Felix, S9 on Android 10, 27.11.2026).
        if (Build.VERSION.SDK_INT < 30) return null;
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
        // the plus menu's files: a photo or a picked image as its small picture, a recording or another file as a chip
        for (TodoPost.Item item : post.files()) {
            Bitmap thumb = fileThumbs.get(item);
            boolean audio = TodoPost.Item.AUDIO.equals(item.kind);
            View view;
            LinearLayout.LayoutParams at;
            if (thumb != null) {
                ImageView picture = new ImageView(service);
                picture.setImageBitmap(thumb);
                picture.setScaleType(ImageView.ScaleType.CENTER_CROP);
                view = picture;
                at = new LinearLayout.LayoutParams(dp(THUMB_DP), dp(THUMB_DP));
            } else {
                TextView chip = new TextView(service);
                chip.setText(audio ? "♪ " + BubbleChat.clock(item.durationMs) : item.name);
                chip.setTextColor(Color.WHITE);
                chip.setTextSize(11);
                chip.setSingleLine(true);
                chip.setEllipsize(TextUtils.TruncateAt.MIDDLE);
                chip.setMaxWidth(dp(120));
                chip.setGravity(Gravity.CENTER_VERTICAL);
                chip.setPadding(dp(8), 0, dp(8), 0);
                GradientDrawable round = new GradientDrawable();
                round.setColor(Color.argb(60, 255, 255, 255));
                round.setCornerRadius(dp(8));
                chip.setBackground(round);
                view = chip;
                at = new LinearLayout.LayoutParams(-2, dp(THUMB_DP));
            }
            String what = audio ? (german ? "Audio-Aufnahme " : "Audio recording ") + BubbleChat.clock(item.durationMs)
                    : TodoPost.Item.PHOTO.equals(item.kind) ? (german ? "Foto" : "Photo") : item.name;
            view.setContentDescription(what + (german ? " entfernen" : ", remove"));
            view.setOnClickListener((v) -> {
                if (busy) return;
                post.detach(item);
                fileThumbs.remove(item);
                new File(item.path).delete();
                renderStrip();
            });
            at.setMarginEnd(dp(4));
            strip.addView(view, at);
        }
        stripScroll.setVisibility(post.bare() ? View.GONE : View.VISIBLE);
        keepWhole();
    }

    // ------------------------------------------------------------------ dictation

    /** The mic: a tap records (the mic orange), the next tap hands the take to the PC; its words land at the end of the field. */
    private void dictate() {
        if (busy) return;
        if (dictation != null) { finishDictation(); return; } // a second tap ends the take
        stopAudio(true); // one microphone at a time: a running recording is attached first
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
        if (problem != null || (words.isEmpty() && post.bare()) || link != UseLink.linked()) {
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
        boolean wasRecording = recording != null;
        stopAudio(true); // Send while audio records: the recording goes along
        showMenu(false);
        String text = field.getText().toString().trim();
        if (dictation == null && text.isEmpty() && post.bare()) {
            if (!wasRecording) say(german ? "Schreib oder sag etwas." : "Type or say something."); // else its line says why nothing came
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
        boolean wasLocked = locked(); // as the person sent it
        String choice = lockChoiceNow();
        run(() -> {
            try {
                String[] chat = deliver(link, text, post, requiredPicture(picture), choice, wasLocked);
                main.post(() -> { sent(); sentTo(chat); });
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

    /** The worker thread (task_cxs4s3pt): the chat the person used last (BubbleChat), every shot of `from` up (each once),
     *  then one line there with the words, the shots and the post's client id – never a to-do. {chatId, agentId, agent's
     *  name or null}; Failed with a line for the person when there is no such chat (nothing goes out then). Sent while
     *  locked (`wasLocked`): nothing in OFF, the note for the agent below the words in NOTE (BubbleLock). */
    private String[] deliver(UseLink link, String text, TodoPost from, TodoPost.Shot currentPage, String choice, boolean wasLocked) throws Failed, InterruptedException {
        if (!BubbleLock.shows(choice, wasLocked)) throw new Failed(german ? "Nicht gesendet – die Blase ist auf dem Sperrbildschirm aus." : "Not sent – the bubble is off on the lock screen.");
        String[] target = chatTarget(link);
        List<String[]> attachments = upload(link, from.shotsWith(currentPage));
        attachments.addAll(uploadFiles(link, from.files()));
        String body = BubbleLock.body(text, BubbleLock.noted(choice, wasLocked));
        if (currentPage == null && Build.VERSION.SDK_INT < 30) body = body + NO_SHOT_NOTE;
        Object sent = answer(link, "messages.send", BubbleChat.send(target[0], body, attachments, from.clientId(), false));
        if (BubbleChat.messageId(sent) == null) throw new Failed(german ? "Der PC hat die Nachricht nicht angenommen." : "The PC did not take the message.");
        return new String[] { target[0], target[1], agentName(link, target[1]) };
    }

    /** The chat the person used last and its agent {chatId, agentId}; no such chat: Failed, nothing sent (no other chat is guessed). */
    private String[] chatTarget(UseLink link) throws Failed, InterruptedException {
        if (link == null) throw new Unreachable(german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED);
        if (!reachable(link)) throw new Unreachable(german ? "Der PC hat nicht geantwortet." : "The PC did not answer.");
        String chatId = BubbleChat.lastChatId(answer(link, "ui.state", Json.map()));
        String[] target = chatId == null ? null : BubbleChat.target(chatId, answer(link, "chats.get", Json.map("id", chatId)));
        if (target == null) throw new Failed(german ? "Nicht gesendet – kein offener Chat mit einem Agenten. Öffne in Autark den Chat, in den das soll, und sende noch mal."
                : "Not sent – no open chat with an agent. Open the chat it is for in Autark and send again.");
        return target;
    }

    /** Every shot up once (named for the agent: BubbleChat.shotName); {fileId, name} in order. */
    private List<String[]> upload(UseLink link, List<TodoPost.Shot> shots) throws Failed, InterruptedException {
        List<String[]> attachments = new ArrayList<>();
        for (TodoPost.Shot shot : shots) {
            String name = BubbleChat.shotName(attachments.size() + 1);
            if (shot.fileId == null) {
                String id = TodoPost.fileId(answer(link, "files.upload", TodoPost.upload(name, shot.jpeg)));
                if (id == null) throw new Failed(german ? "Der PC hat den Screenshot nicht angenommen." : "The PC did not take the screenshot.");
                shot.fileId = id;
            }
            attachments.add(new String[] { shot.fileId, name });
        }
        return attachments;
    }

    /** Every file of the plus menu up once, in pieces (uploadFile); {fileId, name} in order. */
    private List<String[]> uploadFiles(UseLink link, List<TodoPost.Item> items) throws Failed, InterruptedException {
        List<String[]> attachments = new ArrayList<>();
        for (TodoPost.Item item : items) {
            if (item.fileId == null) {
                String id = TodoPost.fileId(uploadFile(link, item));
                if (id == null) throw new Failed(german ? "Der PC hat „" + item.name + "“ nicht angenommen." : "The PC did not take “" + item.name + "”.");
                item.fileId = id;
            }
            attachments.add(new String[] { item.fileId, item.name });
        }
        return attachments;
    }

    /** One file up in files.uploadChunk pieces of TodoPost.CHUNK (never whole in memory); the last answer is its FileRef.
     *  An audio recording goes up as sound like any file – nothing here hears it. */
    private Object uploadFile(UseLink link, TodoPost.Item item) throws Failed, InterruptedException {
        File file = new File(item.path);
        String gone = german ? "„" + item.name + "“ ist nicht mehr auf dem Handy – entferne es und hänge es neu an."
                : "“" + item.name + "” is no longer on the phone – remove it and attach it again.";
        if (!file.isFile()) throw new Failed(gone);
        long size = file.length();
        int count = TodoPost.chunks(size);
        String uploadId = TodoPost.uploadId();
        byte[] piece = new byte[(int) Math.max(1, Math.min(TodoPost.CHUNK, size))];
        Object stored = null;
        try (InputStream in = new FileInputStream(file)) {
            for (int index = 0; index < count; index++) {
                int length = readFully(in, piece);
                stored = answer(link, "files.uploadChunk", TodoPost.chunk(uploadId, index, piece, length, index == count - 1, item));
            }
        } catch (IOException unreadable) {
            throw new Failed(gone);
        }
        return stored;
    }

    private static int readFully(InputStream in, byte[] into) throws IOException {
        int filled = 0;
        while (filled < into.length) {
            int read = in.read(into, filled, into.length - filled);
            if (read < 0) break;
            filled += read;
        }
        return filled;
    }

    /** The agent's name for the line that says where it went; null when the PC does not say. */
    private String agentName(UseLink link, String agentId) throws InterruptedException {
        try { return BubbleChat.agentName(link.request("agents.get", Json.map("id", agentId), CALL_MS)); }
        catch (UseLink.Refused unnamed) { return null; }
    }

    /** Where the line went, in one short line (a toast over the app the person is in). */
    private void sentTo(String[] chat) {
        String name = chat == null ? null : chat[2];
        String line = name == null ? (german ? "Im Chat gesendet" : "Sent to the chat") : (german ? "An " + name + " gesendet" : "Sent to " + name);
        Toast.makeText(service, line, Toast.LENGTH_SHORT).show();
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

    /** The draft went out: no text, no shots, no files (their copies on the phone go too) – the next opening starts a new draft. */
    private void draftSent() {
        for (TodoPost.Item item : post.files()) new File(item.path).delete();
        fileThumbs.clear();
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
        if (!BubbleLock.calls(lockChoiceNow(), locked())) { // a call's spoken lines cannot each carry the lock-screen note
            say(german ? "Anrufen geht auf dem Sperrbildschirm nicht – entsperre das Handy oder schreib die Nachricht." : "No calls from the lock screen – unlock the phone or send a message.");
            return;
        }
        if (!Mic.allowed(service)) {
            collapse();
            openApp(); // the app asks for the microphone where the person sees why
            return;
        }
        dropDictation();
        stopAudio(true); // the call needs the microphone; what was recorded goes with the draft
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

    /** BubbleCall's worker (task_cxs4s3pt): the call runs in the chat the person used last, with its agent – never a to-do.
     *  The draft's shots go there first as one silent line (the agent sees them with the call's first spoken line, which
     *  BubbleCall sends); the draft empties once they are in. {chatId, agentId}; no such chat: Failed, nothing sent. */
    private String[] route(UseLink link, String text) throws Failed, InterruptedException {
        String[] target;
        try {
            target = chatTarget(link);
            List<String[]> shots = upload(link, post.shots());
            shots.addAll(uploadFiles(link, post.files())); // the draft's files go with its shots
            if (!shots.isEmpty() && BubbleChat.messageId(answer(link, "messages.send", BubbleChat.send(target[0], "", shots, post.clientId(), true))) == null) {
                throw new Failed(german ? "Der PC hat die Screenshots nicht angenommen." : "The PC did not take the screenshots.");
            }
        } catch (Failed | RuntimeException error) {
            main.post(() -> keepSaid(text)); // nothing said is lost
            throw error instanceof Failed ? (Failed) error : new Failed(german ? "Senden ging nicht." : "Sending failed.");
        }
        main.post(this::draftSent);
        return new String[] { target[0], target[1] };
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
