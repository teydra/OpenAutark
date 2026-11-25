// Owns: phone use (B-078, D6) – an AccessibilityService that reads nothing until a request asks (its config listens to
// window changes only, and this class ignores them), then does one step: ui_tree (the active window's tree,
// ScreenTree), screenshot (Android 11+), tap (always a short press of a finger, Gestures: ACTION_CLICK reported success
// while nothing happened – in a WebView, and on Samsung's app search, where Konrad's taps on "SimplySign" never opened it
// on 19.11.2026), swipe (a curved, jittered finger path, Gestures), type (ACTION_SET_TEXT on the focused field, Enter
// between lines; answers what the field reads afterwards, TypedText.readback), key (wakeup – the dark screen goes on,
// WakeActivity; Awake keeps the phone reachable and a woken screen lit –, back, home, recents, notifications,
// quick_settings, enter), open (an app by its package or by the name under its icon – AppNames –, or a link) and say
// (16.11.2026: the AI's short line in the
// bubble, or with ask its question with ✓ and ✕ – {answer: yes|no|none}, none after ASK_MS; a ✓ makes the job active;
// owner 19.11.2026: with `buttons` the AI's own labels, small ones beside the line and bigger ones under it, answered
// with the tapped label (SayChoices); KI-Runde 17.11.2026: the question also vibrates once and, with the screen off or
// the app not in front, is a notification whose buttons answer it the same way – AskNotice, answerAsk) and done (owner
// 19.11.2026: the PC's run is over – the bubble goes at once instead of lingering).
// Each step shows the bubble (UseBubble, naming the request's agent `by`); the AI's screenshot leaves it out and its own
// gestures pass through it. Who has the phone is UseState (owner 10.11.2026 16:18, 15.11.2026, 20.11.2026): their Pause
// holds until Continue, their ✕ ends the job for good; a touch or typing of the person changes nothing – the AI's next
// look shows what changed, and a gesture of the AI that Android cancelled under a finger is a plain conflict that says to
// look again. Turning "Use this phone"
// on once (UseDisclosure) covers every app – no question per app (owner 10.11.2026). The PC asks through UseLink.
// While the service is on it also carries the person's own to-do button over every app (TodoButton, shown while this
// phone is paired); both the AI's screenshot and the to-do button's take the screen without the bubble and the button
// (capture, one at a time).
// Never: acts while paused or ended, or reads a password's text.
package com.teydralab.autark.android.phoneuse;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import com.teydralab.autark.android.relay.Json;

public final class UseService extends AccessibilityService {
    /** A refused or failed step: `code` as phoneUse.reply's error code. */
    public static final class UseError extends Exception {
        public final String code;
        UseError(String code, String message) { super(message); this.code = code; }
    }

    private static final int SHOT_WIDTH = 720;
    /** A gesture Android cancelled (a finger on the glass at the same moment, a window change): a fact and my next step. */
    static final String CANCELLED = "My gesture did not finish: Android cancelled it part-way. The screen may have changed, so I "
            + "look again (phone.ui_tree) and repeat it if it is still needed.";
    /** How long the AI's question waits for the person's ✓ or ✕ (the PC waits a little longer). */
    static final long ASK_MS = 60_000;
    private static volatile UseService current;
    private static volatile Runnable changed;

    private final Random random = new Random();
    private final UseState state = new UseState();
    private final TypeTarget target = new TypeTarget();
    private UseBubble bubble;
    /** The running question's answer (phone.say ask), for a tap on its notification; null while none runs. */
    private volatile Consumer<String> asking;
    private volatile TodoButton todo;
    private final Object shooting = new Object();
    private volatile Awake awake;

    /** The service while it is on (Accessibility settings), else null. */
    public static UseService current() { return current; }

    /** The Autark app's main screen is in front (MainActivity tells; the main thread): read when the to-do button appears. */
    private static volatile boolean appFront;

    /** MainActivity came to the front or left it: the resting to-do dot steps aside in the open app and returns after it (DotDodge). */
    public static void appFront(boolean front) {
        appFront = front;
        UseService service = current;
        TodoButton button = service == null ? null : service.todo;
        if (button != null) button.appFront(front);
    }

    static boolean appFront() { return appFront; }

    /** The AI's bubble or its question is on the screen (main thread). */
    boolean agentShows() { return (bubble != null && bubble.showing()) || asking != null; }

    /** The person's to-do button while the service is on (BubblePull: the app's pull brings it out). Main thread. */
    TodoButton todo() { return todo; }

    /** Called when the service turns on or off (UseLink tells the PC). */
    public static synchronized void onChange(Runnable listener) { changed = listener; }

    /** `listener` stops listening – only while it is still the one (an old company's link closing on its own thread
     *  never silences the next company's). */
    public static synchronized void dropChange(Runnable listener) { if (changed == listener) changed = null; }

    /** Tells the listener again (the person just agreed to the disclosure: UseLink reports "ready"). */
    public static void notifyChanged() {
        Runnable listener = changed;
        if (listener != null) listener.run();
    }

    /** Switches the service off (the person said "Not now" to the disclosure). */
    public static void turnOff() {
        UseService service = current;
        if (service != null) service.disableSelf();
    }

    @Override protected void onServiceConnected() {
        bubble = new UseBubble(this, new UseBubble.Person() {
            @Override public void pause() { if (state.pause()) show(); }
            @Override public void resume() { if (state.resume()) show(); }
            @Override public void end() { state.end(); bubble.close(); }
        });
        current = this;
        awake = new Awake(this);
        todo = new TodoButton(this);
        todo.start();
        // Turned on by hand in Android's settings without the in-app disclosure: show it now (on "Not now" it switches itself off).
        if (!UseConsent.agreed(this)) {
            try { startActivity(new Intent(this, UseDisclosure.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (RuntimeException error) { EnablePrompt.show(this); }
        } else com.teydralab.autark.android.PhoneUseAsk.settle(this); // on and agreed: the standing request ("Let the AI use this phone") goes
        Runnable listener = changed;
        if (listener != null) listener.run();
    }

    @Override public boolean onUnbind(Intent intent) {
        current = null;
        if (awake != null) { awake.close(); awake = null; }
        if (bubble != null) bubble.close();
        if (todo != null) { todo.close(); todo = null; }
        Runnable listener = changed;
        if (listener != null) listener.run();
        return super.onUnbind(intent);
    }

    /** While phone.open waits for its app (and only then): the package of the last window that came up, not mine. */
    private volatile boolean watchingFront;
    private volatile String cameUp;

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        // nothing is read until a request asks: only phone.open's own wait notes which app's window came up
        if (!watchingFront || event == null || event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkg = event.getPackageName();
        if (pkg != null && !getPackageName().contentEquals(pkg)) cameUp = pkg.toString();
    }

    @Override public void onInterrupt() { /* Android's feedback interruption: no step of ours speaks */ }

    /** One step (off the main thread) of the PC's run `job` (null from an older PC) for the agent `by` (null: unnamed);
     *  the result as phoneUse.reply's `result`. */
    public Object run(String op, Map<String, Object> args, String job, String by) throws UseError {
        Awake hold = awake;
        if ("done".equals(op)) { state.finished(job); bubble.finished(job); if (hold != null) hold.done(); return Json.map(); } // no step: nothing is touched
        if (!UseConsent.agreed(this)) throw new UseError("off", "The person has not yet agreed to the phone-use disclosure in the app.");
        if (hold != null) hold.step();
        UseState.Refusal refused = state.step(job, System.currentTimeMillis());
        if ("say".equals(op)) {
            boolean ask = Boolean.TRUE.equals(args.get("ask"));
            return say(job, by, Json.str(args, "text"), SayChoices.of(args.get("buttons"), ask), SayChoices.asks(args.get("buttons"), ask), refused);
        }
        if (refused != null) { show(); throw new UseError(refused.code, refused.message); }
        bubble.who(by, job);
        show();
        try {
            switch (op) {
                case "ui_tree": return tree(job);
                case "screenshot": return screenshot(job);
                case "tap": tap(job, num(args, "x"), num(args, "y")); return Json.map();
                case "swipe": swipe(num(args, "x1"), num(args, "y1"), num(args, "x2"), num(args, "y2"), (long) num(args, "durationMs"), args.get("via")); return Json.map();
                case "type": { String now = type(job, Json.str(args, "text")); return now == null ? Json.map() : Json.map("text", now); }
                case "key": return Json.map("key", key(Json.str(args, "key")));
                case "open": return Json.map("opened", open(Json.str(args, "url"), Json.str(args, "package"), Json.str(args, "app")));
                default: throw new UseError("bad_request", "Unknown step " + op + ".");
            }
        } finally {
            show();
        }
    }

    /** The bubble shows who has the phone now: active, held by the person's Pause, or gone after ✕. */
    private void show() {
        switch (state.mode()) {
            case ACTIVE: bubble.active(); break;
            case PAUSED: bubble.held(); break;
            default: bubble.close();
        }
    }

    /** phone.say: the AI's line in the bubble, or as a question (`ask`) with its buttons until one is tapped, ✕ or ASK_MS
     *  (the step thread waits); the answer is SayChoices.answer of the tapped label, "none" without one. */
    private Map<String, Object> say(String job, String by, String text, List<String> buttons, boolean ask, UseState.Refusal refused) throws UseError {
        String line = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        if (line.isEmpty()) throw new UseError("bad_request", "phone.say needs a text.");
        if (line.length() > 120) line = line.substring(0, 119) + "…";
        if (!ask && refused != null && "ended".equals(refused.code)) {
            throw new UseError("ended", "The person ended my phone use for this task with ✕, so the bubble stays closed for it; I tell them in the chat.");
        }
        bubble.who(by, job);
        if (!ask) { bubble.said(line); show(); return Json.map("ok", true); }
        AtomicReference<String> answer = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        Consumer<String> reply = (label) -> { if (answer.compareAndSet(null, SayChoices.answer(label))) done.countDown(); };
        asking = reply;
        bubble.ask(line, buttons, reply);
        AskNotice.show(this, line, buttons);
        try { await(done, ASK_MS); }
        finally { asking = null; AskNotice.cancel(this); answer.compareAndSet(null, "none"); bubble.askDone("yes".equals(answer.get())); }
        if ("yes".equals(answer.get())) { state.agreed(job, System.currentTimeMillis()); show(); }
        return Json.map("answer", answer.get());
    }

    /** The label the person tapped on the question's notification (AskNotice), as if tapped in the bubble. */
    void answerAsk(String value) {
        Consumer<String> reply = asking;
        if (reply != null) reply.accept(value);
    }

    /** The person tapped Pause or ✕ while this step ran: it stops part-way. */
    private UseError interrupted() {
        UseState.Refusal why = state.midStep();
        return new UseError(why.code, why.message);
    }

    // ------------------------------------------------------------------ steps

    private Map<String, Object> tree(String job) throws UseError {
        AccessibilityNodeInfo root = root();
        look(job, root);
        int[] screen = screen();
        return Json.map("nodes", ScreenTree.flatten(new Wrapped(root)), "screen", Json.map("width", screen[0], "height", screen[1]));
    }

    private Map<String, Object> screenshot(String job) throws UseError {
        if (Build.VERSION.SDK_INT < 30) throw new UseError("unavailable", "Screenshots need Android 11 or newer; phone.ui_tree reads the screen.");
        AccessibilityNodeInfo root = front(); // none on some lock screens: the picture is taken all the same
        if (root != null) look(job, root);
        Bitmap full;
        try { full = capture(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new UseError("conflict", "The step was interrupted on the phone."); }
        if (full == null) throw new UseError("unavailable", "Android did not hand over a screenshot right now (at most one per second).");
        int width = Math.min(SHOT_WIDTH, full.getWidth());
        int height = Math.round(full.getHeight() * (width / (float) full.getWidth()));
        Bitmap scaled = width == full.getWidth() ? full : Bitmap.createScaledBitmap(full, width, height, true);
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, 70, jpeg);
        return Json.map("data", Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP), "mime", "image/jpeg", "width", width, "height", height,
                "screen", Json.map("width", full.getWidth(), "height", full.getHeight()));
    }

    /** The screen as the person's apps draw it – without the bubble and the to-do button (Android 11+; a thread of the
     *  caller's, never the main one). One at a time: Android hands out at most one screenshot per second. Null when
     *  Android handed none over. */
    Bitmap capture() throws InterruptedException { return capture(Long.MAX_VALUE, false); }

    /** A user send has a deadline: don't attach a different page because another capture held the lock. */
    Bitmap capture(long deadline, boolean waitForKeyboard) throws InterruptedException {
        if (Build.VERSION.SDK_INT < 30) return null;
        synchronized (shooting) {
            while (waitForKeyboard && keyboardVisible()) {
                if (SystemClock.elapsedRealtime() >= deadline) return null;
                Thread.sleep(16);
            }
            if (SystemClock.elapsedRealtime() >= deadline) return null;
            AtomicReference<Bitmap> shot = new AtomicReference<>();
            CountDownLatch done = new CountDownLatch(1);
            TodoButton button = todo;
            try {
                if (!bubble.hideForShot() || (button != null && !button.hideForShot())) return null;
                if (SystemClock.elapsedRealtime() >= deadline || Thread.currentThread().isInterrupted()) return null;
                takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                    @Override public void onSuccess(ScreenshotResult result) {
                        try (android.hardware.HardwareBuffer buffer = result.getHardwareBuffer()) {
                            Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                            if (hardware != null) shot.set(hardware.copy(Bitmap.Config.ARGB_8888, false));
                        } catch (RuntimeException error) {
                            Log.w("autark", "screen capture conversion failed: " + error.getClass().getName());
                        } finally {
                            done.countDown();
                        }
                    }
                    @Override public void onFailure(int code) { done.countDown(); }
                });
                done.await(5_000, TimeUnit.MILLISECONDS);
            } finally {
                bubble.showAfterShot();
                if (button != null) button.showAfterShot();
            }
            return shot.get();
        }
    }

    private boolean keyboardVisible() {
        for (AccessibilityWindowInfo window : getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
        }
        return false;
    }

    /** A finger's short press at (x, y) – what the person's own tap does, in every app. */
    private void tap(String job, float x, float y) throws UseError {
        AccessibilityNodeInfo root = front(); // none on some lock screens: the finger works there too
        if (root != null) {
            List<ScreenTree.Node> visited = new ArrayList<>();
            ScreenTree.flatten(new Wrapped(root), visited);
            target.tapped(job, str(root.getPackageName()), fieldAt(visited, Math.round(x), Math.round(y)));
        }
        int[] screen = screen();
        gesture(Gestures.tap(x, y, screen[0], screen[1], random));
    }

    /** A swipe, or with `via` (x, y pairs between start and end) one stroke through those points. Needs no readable
     *  window: the lock screen takes it. */
    private void swipe(float x1, float y1, float x2, float y2, long durationMs, Object via) throws UseError {
        int[] screen = screen();
        long ms = durationMs <= 0 ? 400 : durationMs;
        List<?> between = via instanceof List ? (List<?>) via : java.util.Collections.emptyList();
        if (between.isEmpty()) { gesture(Gestures.swipe(x1, y1, x2, y2, ms, screen[0], screen[1], random)); return; }
        if (between.size() % 2 != 0 || between.size() > 32) throw new UseError("bad_request", "via is up to 16 points.");
        float[] through = new float[between.size() + 4];
        through[0] = x1;
        through[1] = y1;
        for (int i = 0; i < between.size(); i++) {
            Object value = between.get(i);
            if (!(value instanceof Number)) throw new UseError("bad_request", "via is up to 16 points.");
            through[i + 2] = ((Number) value).floatValue();
        }
        through[through.length - 2] = x2;
        through[through.length - 1] = y2;
        gesture(Gestures.path(through, ms, screen[0], screen[1], random));
    }

    /** phone.key wakeup: the screen goes on (WakeActivity) and stays on between the AI's steps; the lock stays. */
    private String wake() throws UseError {
        android.os.PowerManager power = getSystemService(android.os.PowerManager.class);
        if (!power.isInteractive()) {
            try { startActivity(new Intent(this, WakeActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (RuntimeException error) { throw new UseError("conflict", "Android did not turn the screen on: " + error.getClass().getSimpleName()); }
            for (int i = 0; i < 30 && !power.isInteractive(); i++) SystemClock.sleep(100);
            if (!power.isInteractive()) throw new UseError("conflict", "Android did not turn the screen on.");
            SystemClock.sleep(1_000); // the activity leaves and the lock screen draws
        }
        Awake hold = awake;
        if (hold != null) hold.keepLit();
        return "wakeup";
    }

    /** Types `text`; what the field reads afterwards (TypedText.readback: null for a password field). */
    private String type(String job, String text) throws UseError {
        if (text == null) throw new UseError("bad_request", "No text.");
        AccessibilityNodeInfo root = root();
        String app = str(root.getPackageName());
        AccessibilityNodeInfo field = editable(root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT));
        String refused = target.refuse(job, app, field == null ? null : TypeTarget.Field.of(identity(field), new Wrapped(field)));
        if (refused != null) throw new UseError("conflict", refused);
        String[] lines = text.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            notLate();
            if (!state.acting()) throw interrupted();
            String moved = moved(app, field);
            if (moved != null) {
                throw new UseError("conflict", i == 0 ? moved + " Nothing was typed." : moved + " The first " + i + " line(s) went in, the rest did not.");
            }
            if (!lines[i].isEmpty()) {
                CharSequence before = existing(field);
                if (!setText(field, before + lines[i])) {
                    if (before.length() > 0) setText(field, before);
                    throw new UseError("conflict", "The field did not take the text.");
                }
            }
            if (i < lines.length - 1) enter(field);
        }
        field.refresh();
        return TypedText.readback(field.getText(), field.isPassword(), field.isShowingHintText());
    }

    // What the field really holds before the words go in. Some apps (WhatsApp) report an empty field's placeholder as
    // its text without isShowingHintText(); typing would then put "Message" in front. A known hint is compared; else the
    // field is cleared once: a placeholder shows the same words again, real text does not (it is put back in front of
    // the new words, as before). No cursor guess: on the Samsung (0.3.11, 10.11.2026) WhatsApp's search – a zero-width
    // space, then "Ask Meta AI or Search", no hint – still got the words behind its placeholder; the cursor check, which
    // kept any field whose cursor was not at 0, is the one path that leaves such a field untouched.
    private CharSequence existing(AccessibilityNodeInfo field) {
        CharSequence text = field.getText();
        if (field.isShowingHintText() || text == null || TypedText.placeholder(text, field.getHintText())) return "";
        if (!setText(field, "")) return text;
        CharSequence after = field.getText();
        if (field.isShowingHintText() || after == null || after.length() == 0 || !TypedText.same(after, text)) return text;
        return "";
    }

    private static boolean setText(AccessibilityNodeInfo field, CharSequence value) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        boolean ok = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        field.refresh();
        return ok;
    }

    private String key(String name) throws UseError {
        String key = name == null ? "" : name.trim().toLowerCase(java.util.Locale.ROOT);
        int action;
        switch (key) {
            case "wakeup": return wake();
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": case "app_switch": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick_settings": action = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "enter": {
                AccessibilityNodeInfo root = root();
                AccessibilityNodeInfo field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (field == null) throw new UseError("conflict", "No text field has the focus for Enter.");
                enter(field);
                return "enter";
            }
            default: throw new UseError("bad_request", "Through the Autark app the keys are wakeup, back, home, recents, notifications, quick_settings and enter.");
        }
        if (!performGlobalAction(action)) throw new UseError("conflict", "Android did not press " + key + ".");
        return key;
    }

    private String open(String url, String pkg, String app) throws UseError {
        Intent intent;
        if ((pkg == null || pkg.isEmpty()) && app != null && !app.trim().isEmpty()) {
            List<String[]> apps = launcherApps();
            String[] icon = AppNames.match(apps, app);
            if (icon == null) throw new UseError("not_found", AppNames.missing(apps, app));
            pkg = icon[1];
            intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setClassName(icon[1], icon[2]); // exactly the icon that matched
        } else if (pkg != null && !pkg.isEmpty()) {
            intent = getPackageManager().getLaunchIntentForPackage(pkg);
            if (intent == null) throw new UseError("not_found", pkg + " is not installed on this phone; phone.open with app opens an app by the name under its icon.");
        } else if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) {
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        } else {
            throw new UseError("bad_request", "Give an http(s) link, a package name or an app's name.");
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        notLate();
        cameUp = null;
        watchingFront = pkg != null && !pkg.isEmpty();
        try {
            try { startActivity(intent); } catch (RuntimeException error) { throw new UseError("conflict", "Android did not open it: " + error.getMessage()); }
            if (watchingFront) awaitFront(pkg, app);
        } finally {
            watchingFront = false;
        }
        return pkg != null && !pkg.isEmpty() ? pkg : url;
    }

    /** How long phone.open waits for its app to come to the front (StepDeadline's 15 s hold this and one tree read). */
    static final long OPEN_WAIT_MS = 6_000;

    /**
     * 27.11.2026 (SimplySign: "opened", yet the app never showed): the started app has to come to the front – a window of
     * its package came up, or the window in front is its own – else the step fails with which app is there instead.
     */
    private void awaitFront(String pkg, String shown) throws UseError {
        long until = SystemClock.elapsedRealtime() + OPEN_WAIT_MS;
        for (int tick = 1; SystemClock.elapsedRealtime() < until; tick++) {
            if (pkg.equals(cameUp)) return;
            if (tick % 5 == 0) { // every half second: an app already in front brings no new window
                AccessibilityNodeInfo front = front();
                if (front != null && pkg.contentEquals(front.getPackageName() == null ? "" : front.getPackageName())) return;
            }
            try { Thread.sleep(100); }
            catch (InterruptedException stop) { Thread.currentThread().interrupt(); throw new UseError("timeout", "The step ran out of time on the phone."); }
        }
        AccessibilityNodeInfo front = front(); // an app already in front brings no new window: its own window counts
        String now = front == null ? null : str(front.getPackageName());
        if (pkg.equals(now) || pkg.equals(cameUp)) return;
        throw new UseError("conflict", AppNames.notInFront(shown, pkg, now != null && !now.isEmpty() ? now : cameUp, OPEN_WAIT_MS));
    }

    /** StepDeadline gave up on this step (its worker was interrupted): no tap, text or app start may follow late. */
    private static void notLate() throws UseError {
        if (Thread.currentThread().isInterrupted()) throw new UseError("timeout", "The step ran out of time on the phone; nothing more was done.");
    }

    /** The launcher's icons: {the name under the icon, package, activity} each (the manifest's launcher query makes them
     *  visible on Android 11+). */
    private List<String[]> launcherApps() {
        android.content.pm.PackageManager packages = getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<String[]> apps = new ArrayList<>();
        for (android.content.pm.ResolveInfo info : packages.queryIntentActivities(launcher, 0)) {
            if (info.activityInfo == null) continue;
            apps.add(new String[] { str(info.loadLabel(packages)), info.activityInfo.packageName, info.activityInfo.name });
        }
        return apps;
    }

    // ------------------------------------------------------------------ helpers

    /** Right before each change to the field (also before clearing a placeholder, and again after each Enter): still the
     *  same app in front and still the same field with the input focus? null if so, else what changed. No typing into a
     *  field that went to the background. */
    private String moved(String app, AccessibilityNodeInfo field) {
        AccessibilityNodeInfo front = front();
        if (front == null || !app.equals(str(front.getPackageName()))) return "Another app came to the front.";
        AccessibilityNodeInfo focused = front.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null || !focused.equals(field)) return "The input focus left the field.";
        return null;
    }

    /** phone.ui_tree / phone.screenshot: what the AI saw – the app in front and its focused text field. */
    private void look(String job, AccessibilityNodeInfo root) {
        AccessibilityNodeInfo focused = editable(root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT));
        target.looked(job, str(root.getPackageName()), focused == null ? null : TypeTarget.Field.of(identity(focused), new Wrapped(focused)));
    }

    /** The smallest visible editable field under the point, or null. */
    private static TypeTarget.Field fieldAt(List<ScreenTree.Node> nodes, int x, int y) {
        TypeTarget.Field best = null;
        long bestArea = Long.MAX_VALUE;
        for (ScreenTree.Node node : nodes) {
            AccessibilityNodeInfo info = ((Wrapped) node).info;
            if (!info.isEditable() || !info.isVisibleToUser()) continue;
            int[] b = node.bounds();
            if (x < b[0] || x >= b[2] || y < b[1] || y >= b[3]) continue;
            long area = (long) (b[2] - b[0]) * (b[3] - b[1]);
            if (area < bestArea) { bestArea = area; best = TypeTarget.Field.of(identity(info), node); }
        }
        return best;
    }

    /** Android's identity of the view behind a node: the node snapshot itself, compared by AccessibilityNodeInfo.equals
     *  (full source node id + window id; stays while the keyboard moves the view, differs for a look-alike view). Never
     *  its hashCode alone: that folds the ids into 32 bits (AOSP AccessibilityNodeInfo, Konrad 12.11.2026 21:35). */
    private static Object identity(AccessibilityNodeInfo info) { return info; }

    private static AccessibilityNodeInfo editable(AccessibilityNodeInfo node) { return node != null && node.isEditable() ? node : null; }

    private static String str(CharSequence value) { return value == null ? "" : value.toString(); }

    private AccessibilityNodeInfo root() throws UseError {
        AccessibilityNodeInfo root = front();
        if (root == null) throw new UseError("unavailable", "The screen has no readable window right now (locked, or a game drawing itself): phone.screenshot shows it.");
        return root;
    }

    /** The window in front as the person sees it: the active one – unless that is my own typing window (BubbleTyping,
     *  one invisible pixel, while the person types into the to-do bubble); then the topmost app window under it, so the
     *  AI never reads, types into or measures the person's draft. */
    private AccessibilityNodeInfo front() {
        AccessibilityNodeInfo active = getRootInActiveWindow();
        if (active == null || !typingWindow(active)) return active;
        AccessibilityNodeInfo best = null;
        int layer = Integer.MIN_VALUE;
        for (android.view.accessibility.AccessibilityWindowInfo window : getWindows()) {
            if (window.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION || window.getLayer() <= layer) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null || typingWindow(root)) continue;
            best = root;
            layer = window.getLayer();
        }
        return best;
    }

    /** My own typing window: this app's, one pixel big. */
    private boolean typingWindow(AccessibilityNodeInfo root) {
        if (!getPackageName().equals(str(root.getPackageName()))) return false;
        Rect bounds = new Rect();
        root.getBoundsInScreen(bounds);
        return bounds.width() <= BubbleTyping.SIZE && bounds.height() <= BubbleTyping.SIZE;
    }

    private void enter(AccessibilityNodeInfo field) throws UseError {
        if (Build.VERSION.SDK_INT < 30 || !field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
            throw new UseError("conflict", "This field did not take Enter.");
        }
    }

    private void gesture(Gestures.Stroke stroke) throws UseError {
        notLate();
        if (!state.acting()) throw interrupted();
        Path path = new Path();
        path.moveTo(stroke.points[0], stroke.points[1]);
        for (int i = 2; i < stroke.points.length; i += 2) path.lineTo(stroke.points[i], stroke.points[i + 1]);
        GestureDescription description = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path, 0, stroke.durationMs)).build();
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean ok = new AtomicBoolean(false);
        TodoButton button = todo;
        bubble.passThrough(true); // the AI's own finger lands on the app below, never on Pause or ✕ or the to-do dot
        if (button != null) button.passThrough(true);
        BubbleTyping.aiGesture(stroke.durationMs + 1_000); // its touch is no reason to end the person's typing
        try {
            boolean sent = dispatchGesture(description, new GestureResultCallback() {
                @Override public void onCompleted(GestureDescription gesture) { ok.set(true); done.countDown(); }
                // Android cancels an injected gesture when a real finger comes down at the same moment.
                @Override public void onCancelled(GestureDescription gesture) { done.countDown(); }
            }, null);
            if (!sent) throw new UseError("conflict", "Android did not take the gesture.");
            await(done, stroke.durationMs + 3_000);
        } finally {
            bubble.passThrough(false);
            if (button != null) button.passThrough(false);
        }
        if (!ok.get()) throw state.acting() ? new UseError("conflict", CANCELLED) : interrupted();
    }

    private int[] screen() {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect bounds = ((android.view.WindowManager) getSystemService(WINDOW_SERVICE)).getCurrentWindowMetrics().getBounds();
            return new int[] { bounds.width(), bounds.height() };
        }
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        return new int[] { metrics.widthPixels, metrics.heightPixels };
    }

    private static void await(CountDownLatch latch, long ms) throws UseError {
        try { latch.await(ms, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new UseError("conflict", "The step was interrupted on the phone."); }
    }

    private static float num(Map<String, Object> args, String key) throws UseError {
        Object value = args.get(key);
        if (!(value instanceof Number)) throw new UseError("bad_request", key + " is missing.");
        return ((Number) value).floatValue();
    }

    /** An AccessibilityNodeInfo as ScreenTree reads it. */
    private static final class Wrapped implements ScreenTree.Node {
        final AccessibilityNodeInfo info;
        Wrapped(AccessibilityNodeInfo info) { this.info = info; }
        @Override public CharSequence text() { return info.getText(); }
        @Override public CharSequence desc() { return info.getContentDescription(); }
        @Override public String id() { return info.getViewIdResourceName(); }
        @Override public CharSequence cls() { return info.getClassName(); }
        @Override public CharSequence pkg() { return info.getPackageName(); }
        @Override public int[] bounds() { Rect r = new Rect(); info.getBoundsInScreen(r); return new int[] { r.left, r.top, r.right, r.bottom }; }
        @Override public boolean visible() { return info.isVisibleToUser(); }
        @Override public boolean clickable() { return info.isClickable(); }
        @Override public boolean scrollable() { return info.isScrollable(); }
        @Override public boolean checkable() { return info.isCheckable(); }
        @Override public boolean checked() { return info.isChecked(); }
        @Override public boolean enabled() { return info.isEnabled(); }
        @Override public boolean focused() { return info.isFocused(); }
        @Override public boolean selected() { return info.isSelected(); }
        @Override public boolean password() { return info.isPassword(); }
        @Override public int childCount() { return info.getChildCount(); }
        @Override public ScreenTree.Node child(int index) { AccessibilityNodeInfo child = info.getChild(index); return child == null ? null : new Wrapped(child); }
    }
}
