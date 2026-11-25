// Owns: the small see-through bubble at the screen's top edge while the AI uses the phone (an accessibility overlay: no
// extra permission, shown above every app). A pill of fixed width – the Autark mark, the line, then the cells on the
// right – and, under it, the AI's bigger buttons as bubbles of their own (owner 19.11.2026). Looks: active – "<agent> is
// using this phone" (or the AI's own short status line, phone.say) with Pause and ✕; paused by the person's Pause –
// "Paused · the phone is yours" with Continue and ✕; the AI's question (phone.say with ask or buttons) – its
// text, its small buttons in the row (SayChoices.row) and ✕, its bigger ones under the pill, answered once. The line
// takes up to three lines, so the pill grows downwards when the AI writes more; Pause and ✕ keep their place.
// Touches outside it reach the app as before and change nothing for the AI (owner 20.11.2026: the person keeps using
// the phone while the AI works; there is no touch-pause). For the AI's screenshot it is invisible for one
// frame (hideForShot), and while the AI's own gesture runs touches pass through it (passThrough: FLAG_NOT_TOUCHABLE),
// so the AI neither sees nor presses it. It goes HIDE_AFTER_MS after the last step, and at once when the PC says the
// AI's run is over (finished). Never: stays after ✕ (it closes at once), hides while paused or asking, or treats the
// AI's text as anything but text.
package com.teydralab.autark.android.phoneuse;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.teydralab.autark.android.R;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

final class UseBubble {
    /** What the person did with the bubble (called on the main thread). */
    interface Person {
        void pause();
        void resume();
        void end();
    }

    private enum Look { ACTIVE, HELD }

    /** Without a step this long the AI is thinking or done elsewhere: the bubble goes (the next step brings it back). */
    static final long HIDE_AFTER_MS = 2 * 60_000;
    /** After a frame was drawn, this long until it is on the screen (composited). */
    private static final long FRAME_MS = 32;
    /** The longest a step waits for the bubble to hide or let touches through. */
    private static final long WAIT_MS = 300;
    private final AccessibilityService service;
    private final WindowManager windows;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Person person;
    private final boolean german = "de".equals(Locale.getDefault().getLanguage());
    private final Runnable hide = this::remove;
    private float density;
    private LinearLayout view;
    private WindowManager.LayoutParams params;
    private TextView line;
    private LinearLayout row;
    private TextView primary;
    private TextView close;
    private LinearLayout below;
    private Look look = Look.ACTIVE;
    private volatile String by;
    private volatile String job;
    private volatile String said;
    private String question;
    private List<String> choices = Collections.emptyList();
    private Consumer<String> answer;
    private boolean shownBeforeQuestion;

    UseBubble(AccessibilityService service, Person person) {
        this.service = service;
        this.windows = (WindowManager) service.getSystemService(AccessibilityService.WINDOW_SERVICE);
        this.person = person;
    }

    /** Who acts and for which job (any thread): the agent's name for the line; a new job clears the AI's status line. */
    void who(String agent, String forJob) {
        String name = agent == null ? null : agent.replaceAll("\\s+", " ").trim();
        by = name == null || name.isEmpty() ? null : name.length() > 40 ? name.substring(0, 40) : name;
        if (forJob == null ? job != null : !forJob.equals(job)) said = null;
        job = forJob;
    }

    /** The AI's status line (phone.say without ask; any thread): shown while active, until the next one or a new job. */
    void said(String text) { said = text; main.post(this::render); }

    /** Active, visible; it goes HIDE_AFTER_MS after the last call. */
    void active() { main.post(() -> { show(Look.ACTIVE); main.removeCallbacks(hide); main.postDelayed(hide, HIDE_AFTER_MS); }); }

    /** Paused by the person's Pause: stays until Continue, ✓ or ✕. */
    void held() { main.post(() -> { show(Look.HELD); main.removeCallbacks(hide); }); }

    void close() { main.post(() -> { main.removeCallbacks(hide); remove(); }); }

    /** The PC's run `forJob` is over (any thread): the bubble goes now – unless it shows another job, or a question
     *  still waits for its answer. */
    void finished(String forJob) {
        main.post(() -> {
            String now = job;
            if (forJob != null && now != null && !forJob.equals(now)) return;
            if (question != null) return;
            said = null;
            main.removeCallbacks(hide);
            remove();
        });
    }

    /** The AI's question (any thread) with its buttons (SayChoices; empty: only ✕): `then` hears the tapped label – ✕
     *  for the ✕ cell – once, on the main thread. */
    void ask(String text, List<String> buttons, Consumer<String> then) {
        main.post(() -> {
            shownBeforeQuestion = view != null;
            question = text;
            choices = buttons;
            answer = then;
            ensure();
            main.removeCallbacks(hide);
            render();
        });
    }

    /** The question is over (answered, or no answer in time): back to the look before it – or gone when it came
     *  alone and was not answered with ✓ (`keep` false). */
    void askDone(boolean keep) {
        main.post(() -> {
            question = null;
            choices = Collections.emptyList();
            answer = null;
            if (!keep && !shownBeforeQuestion) { remove(); return; }
            render();
            if (look == Look.ACTIVE) { main.removeCallbacks(hide); main.postDelayed(hide, HIDE_AFTER_MS); }
        });
    }

    /** Invisible until showAfterShot (a step's thread, never the main one): returns once a frame without it reached the
     *  screen, at most WAIT_MS. */
    boolean hideForShot() throws InterruptedException {
        CountDownLatch hidden = new CountDownLatch(1);
        main.post(() -> {
            if (view == null) { hidden.countDown(); return; }
            view.setVisibility(View.INVISIBLE);
            afterFrame(hidden::countDown);
        });
        return hidden.await(WAIT_MS, TimeUnit.MILLISECONDS);
    }

    void showAfterShot() { main.post(() -> { if (view != null) view.setVisibility(View.VISIBLE); }); }

    /** While the AI's own gesture runs, touches pass through the bubble (a step's thread; on: returns once applied). */
    void passThrough(boolean on) {
        CountDownLatch applied = new CountDownLatch(1);
        main.post(() -> {
            if (view == null || params == null) { applied.countDown(); return; }
            if (on) params.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            else params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            try { windows.updateViewLayout(view, params); } catch (RuntimeException gone) { /* removed meanwhile */ }
            afterFrame(applied::countDown);
        });
        if (on) await(applied);
    }

    private void afterFrame(Runnable then) {
        if (view == null) { then.run(); return; }
        view.postOnAnimation(() -> main.postDelayed(then, FRAME_MS));
    }

    private static void await(CountDownLatch latch) {
        try { latch.await(WAIT_MS, TimeUnit.MILLISECONDS); } catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
    }

    private void show(Look next) {
        look = next;
        ensure();
        render();
    }

    /** The cells' texts for the look (or the question, which comes first). */
    private void render() {
        if (view == null) return;
        row.removeAllViews();
        below.removeAllViews();
        if (question != null) {
            line.setText(question);
            primary.setVisibility(View.GONE);
            close.setContentDescription(german ? "Gerade nicht" : "Not now");
            for (String label : SayChoices.row(choices)) row.addView(choice(label, true), cell(LinearLayout.LayoutParams.WRAP_CONTENT));
            for (String label : SayChoices.below(choices)) below.addView(choice(label, false), under());
            below.setVisibility(below.getChildCount() > 0 ? View.VISIBLE : View.GONE);
            return;
        }
        below.setVisibility(View.GONE);
        primary.setVisibility(View.VISIBLE);
        close.setContentDescription(german ? "Beenden" : "End");
        switch (look) {
            case HELD: set(german ? "Pausiert · das Handy gehört dir" : "Paused · the phone is yours", german ? "Weiter" : "Continue"); break;
            default: {
                String who = by == null ? "Autark" : by;
                set(said != null ? said : german ? who + " bedient dieses Handy" : who + " is using this phone", "Pause");
            }
        }
    }

    private void set(String text, String button) {
        line.setText(text);
        primary.setText(button);
    }

    /** One of the AI's buttons: in the row a bold cell, under the pill a bubble of its own (up to two lines). */
    private TextView choice(String label, boolean inRow) {
        int dp4 = Math.round(4 * density);
        TextView button = text(12, true);
        button.setText(label);
        button.setContentDescription(SayChoices.YES.equals(label) ? (german ? "Ja" : "Yes") : label);
        button.setGravity(Gravity.CENTER);
        button.setMinWidth(dp4 * 9);
        if (inRow) button.setPadding(dp4 * 2, dp4 * 2, dp4 * 2, dp4 * 2);
        else {
            button.setMaxLines(2);
            button.setEllipsize(TextUtils.TruncateAt.END);
            button.setPadding(dp4 * 4, dp4 * 2, dp4 * 4, dp4 * 2);
            button.setBackground(pillBackground());
        }
        button.setOnClickListener((tap) -> reply(label));
        return button;
    }

    private LinearLayout.LayoutParams cell(int width) {
        return new LinearLayout.LayoutParams(width, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    /** A bubble under the pill: as wide as its label, at the right edge (where the person's thumb is), 4 dp apart. */
    private LinearLayout.LayoutParams under() {
        LinearLayout.LayoutParams size = cell(LinearLayout.LayoutParams.WRAP_CONTENT);
        size.gravity = Gravity.END;
        size.topMargin = Math.round(4 * density);
        return size;
    }

    private void tapPrimary() {
        if (question != null) return; // hidden while asking
        if (look == Look.HELD) person.resume(); else person.pause();
    }

    private void tapClose() {
        if (question != null) { reply(SayChoices.NO); return; }
        person.end();
    }

    private void reply(String label) {
        Consumer<String> then = answer;
        answer = null;
        if (then != null) then.accept(label);
    }

    private GradientDrawable pillBackground() {
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(235, 32, 36, 34));
        background.setCornerRadius(20 * density);
        return background;
    }

    private void ensure() {
        if (view != null) return;
        density = service.getResources().getDisplayMetrics().density;
        int dp4 = Math.round(4 * density);
        view = new LinearLayout(service);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setAlpha(0.85f); // see-through: the app below stays readable
        LinearLayout pill = new LinearLayout(service);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(dp4 * 3, 0, dp4, 0);
        pill.setBackground(pillBackground());
        ImageView mark = new ImageView(service);
        mark.setImageResource(R.drawable.ic_stat_autark);
        LinearLayout.LayoutParams markSize = new LinearLayout.LayoutParams(dp4 * 4, dp4 * 4);
        markSize.setMarginEnd(dp4 * 2);
        pill.addView(mark, markSize);
        line = text(12, false);
        line.setMaxLines(3); // more words take a second and third line: the pill grows downwards
        line.setPadding(0, dp4 * 2, dp4, dp4 * 2); // one line is as tall as the cells beside it
        line.setEllipsize(TextUtils.TruncateAt.END);
        pill.addView(line, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        row = new LinearLayout(service);
        row.setOrientation(LinearLayout.HORIZONTAL);
        pill.addView(row, cell(LinearLayout.LayoutParams.WRAP_CONTENT));
        primary = text(12, true);
        primary.setGravity(Gravity.CENTER);
        primary.setPadding(0, dp4 * 2, 0, dp4 * 2);
        primary.setOnClickListener((tap) -> tapPrimary());
        pill.addView(primary, cell(dp4 * 16));
        close = text(13, true);
        close.setText(SayChoices.NO);
        close.setGravity(Gravity.CENTER);
        close.setPadding(0, dp4 * 2, 0, dp4 * 2);
        close.setOnClickListener((tap) -> tapClose());
        pill.addView(close, cell(dp4 * 9));
        view.addView(pill, cell(LinearLayout.LayoutParams.MATCH_PARENT));
        below = new LinearLayout(service);
        below.setOrientation(LinearLayout.VERTICAL);
        below.setVisibility(View.GONE);
        view.addView(below, cell(LinearLayout.LayoutParams.MATCH_PARENT));
        int width = Math.min(service.getResources().getDisplayMetrics().widthPixels - dp4 * 8, dp4 * 80); // ≤ 320 dp, 16 dp gutters
        params = new WindowManager.LayoutParams(width, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = Math.round(36 * density);
        try { windows.addView(view, params); } catch (RuntimeException error) { view = null; params = null; }
    }

    private TextView text(int size, boolean bold) {
        TextView text = new TextView(service);
        text.setTextColor(Color.WHITE);
        text.setTextSize(size);
        if (bold) text.setTypeface(text.getTypeface(), android.graphics.Typeface.BOLD);
        return text;
    }

    private void remove() {
        if (view == null) return;
        try { windows.removeView(view); } catch (RuntimeException ignored) { /* already gone */ }
        view = null;
        params = null;
    }
}
