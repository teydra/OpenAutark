// Owns: the native pairing levels (B-084 decision 3), also used for "Add a company": 1 "Connect to your PC" (icon, where
// the code is on the PC, "How feedback works" – the feedback video again, 16.11.2026 F15 –, the one big "Scan QR code",
// a small "Enter the code instead"); 2 the full-height scanner
// (ScanView) with the one "Choose QR image" button (ChooseImage) pinned below and a status overlay that never moves anything; 2b the
// 9-digit code grouped 3-3-3 with "Connect" enabled at 9 digits; 3 the wait while the PC accepts (the 4-digit code
// large, Cancel). Light/dark from uiMode. Back walks the levels. Every way to an ID (scan, picture, typing) ends in one
// callback; the pairing itself, its texts and what follows belong to MainActivity. Never: pairs, stores or sends anything.
package com.teydralab.autark.android.pair;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.teydralab.autark.android.ConnectionAddress;
import com.teydralab.autark.android.usage.UsageText;
import java.util.function.BiConsumer;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

public final class PairScreens {
    private static final int START = 1, SCAN = 2, CODE = 3, WAIT = 4;
    private static Activity activity;
    private static FrameLayout host;
    private static PairLook look;
    private static boolean cancelable;
    private static Consumer<String> onRemoteId;
    private static Runnable onCancel;
    private static BiConsumer<String, String> bars;
    private static Runnable tour;
    private static BooleanSupplier usageOn;
    private static Consumer<Boolean> usageSet;
    private static int level, from;
    private static String typed = "";
    private static ScanView scan;
    private static ChooseImage strip;
    private static TextView message, digits;

    private PairScreens() {}

    /**
     * Shows level 1 in host (or level 2b with remoteIdOrNull filled in, one tap on Connect). onRemoteId gets the 9
     * digits the person scanned, picked or typed – the screens then wait (level 3) – or null when the person cancels
     * that wait. cancelable: Back on level 1 leaves through onCancel (Add a company); otherwise back() returns false there.
     */
    public static void show(Activity a, FrameLayout into, String remoteIdOrNull, boolean canCancel, Consumer<String> onId, Runnable cancel) {
        stop();
        activity = a; host = into; look = new PairLook(a); cancelable = canCancel; onRemoteId = onId; onCancel = cancel;
        typed = remoteIdOrNull == null ? "" : remoteIdOrNull;
        if (remoteIdOrNull != null) code(); else start();
    }

    /** Optional: paints the system bar strips (CSS colours top, bottom) for each level, e.g. SystemBars::apply. */
    public static void bars(BiConsumer<String, String> paint) { bars = paint; }

    /** Optional (owner 25.11.2026): the anonymous usage count's switch on level 1 – its state and what a tap on it does; null shows no row. */
    public static void usage(BooleanSupplier on, Consumer<Boolean> set) { usageOn = on; usageSet = set; }

    /** Optional: what "How feedback works" on level 1 plays (MainActivity: the feedback video); null shows no link. */
    public static void tour(Runnable play) { tour = play; }

    /** Back: one level up; true when the screens took it. */
    public static boolean back() {
        if (activity == null) return false;
        if (level == SCAN || level == CODE) { start(); return true; }
        if (level == WAIT) { cancelWait(); return true; }
        if (level == START && cancelable) { Runnable leave = onCancel; stop(); if (leave != null) leave.run(); return true; }
        return false;
    }

    /** Leaves the screens: the camera and the photo thread end, nothing is kept. */
    public static void stop() {
        leaveCamera();
        activity = null; host = null; look = null; onRemoteId = null; onCancel = null; message = null; digits = null; level = 0;
    }

    /** Request 44 (camera); true when it was that. */
    public static boolean onPermissionResult(int code, int[] grants) {
        if (code == ScanView.CAMERA_REQUEST) {
            if (scan != null) scan.permission(grants != null && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED);
            return true;
        }
        return false;
    }

    /** Request 46 (the system image chooser); true when it was that. */
    public static boolean onActivityResult(int code, int result, Intent data) {
        if (code != ChooseImage.PICK_REQUEST) return false;
        if (strip != null) strip.result(result, data);
        return true;
    }

    /** The one status slot of the level shown: a line, optionally "\n" and the 4-digit code (shown large while waiting). Any thread. */
    public static void status(String text) {
        Activity shown = activity;
        if (shown == null) return;
        shown.runOnUiThread(() -> {
            if (message == null) return;
            String value = text == null ? "" : text;
            int split = value.indexOf('\n');
            message.setText(split < 0 ? value : value.substring(0, split));
            if (digits != null) digits.setText(split < 0 ? "" : value.substring(split + 1).replaceAll("\\s", "").replaceAll("(\\d)(?=\\d)", "$1 "));
            if (level == SCAN) message.setVisibility(value.isEmpty() ? View.INVISIBLE : View.VISIBLE);
        });
    }

    /** The pairing did not work: back to the level the ID came from, with the reason in its status slot. Any thread. */
    public static void failed(String reason) {
        Activity shown = activity;
        if (shown == null) return;
        shown.runOnUiThread(() -> {
            if (activity == null) return;
            if (from == SCAN) scan(); else if (from == CODE) code(); else start();
            status(reason);
        });
    }

    // ------------------------------------------------------------------ levels

    private static void start() {
        leaveCamera();
        level = START;
        LinearLayout page = look.column(look.bg);
        page.addView(look.topRow(cancelable ? look.back(look.ink, PairScreens::back) : null), PairLook.row(look.dp(48)));
        page.addView(new View(activity), PairLook.fill());
        page.addView(look.icon(), look.centred(96));
        page.addView(look.text("Connect to your PC", 26, look.ink, true), look.spaced(24, 0));
        page.addView(look.text("On your PC: Settings › Devices › My ID", 15, look.muted, false), look.spaced(8, 0));
        Runnable play = tour;
        if (play != null) page.addView(look.quiet("How feedback works", look.link, play), look.spaced(8, 0));
        page.addView(new View(activity), PairLook.fill());
        if (usageOn != null && usageSet != null) page.addView(look.check("Anonymous usage count", UsageText.SENTENCE, usageOn.getAsBoolean(), usageSet), look.spaced(8, 0));
        page.addView(slot(), PairLook.row(look.dp(44)));
        page.addView(look.primary("Scan QR code", PairScreens::scan), PairLook.row(look.dp(56)));
        page.addView(look.quiet("Enter the code instead", look.link, PairScreens::code), look.spaced(8, 0));
        put(page, look.bg, look.bg);
    }

    private static void scan() {
        leaveCamera();
        level = SCAN;
        LinearLayout page = look.column(PairLook.CAMERA);
        page.setPadding(0, 0, 0, 0);
        FrameLayout camera = new FrameLayout(activity);
        scan = new ScanView(activity, look, PairScreens::scanned);
        camera.addView(scan, new FrameLayout.LayoutParams(-1, -1));
        FrameLayout.LayoutParams backAt = new FrameLayout.LayoutParams(look.dp(48), look.dp(48), Gravity.TOP | Gravity.START);
        backAt.setMargins(look.dp(8), look.dp(8), 0, 0);
        camera.addView(look.back(0xFFFFFFFF, PairScreens::back), backAt);
        TextView hint = look.text("Point at the QR code on your PC", 15, 0xFFFFFFFF, true);
        FrameLayout.LayoutParams hintAt = new FrameLayout.LayoutParams(-1, look.dp(48), Gravity.TOP);
        hintAt.setMargins(look.dp(56), look.dp(8), look.dp(56), 0);
        camera.addView(hint, hintAt);
        TextView pill = slot();
        pill.setTextColor(0xFFFFFFFF);
        pill.setBackground(look.round(0xB3000000, 20, 0));
        pill.setPadding(look.dp(16), look.dp(10), look.dp(16), look.dp(10));
        pill.setVisibility(View.INVISIBLE);
        FrameLayout.LayoutParams pillAt = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        pillAt.setMargins(look.dp(16), 0, look.dp(16), look.dp(16));
        camera.addView(pill, pillAt);
        page.addView(camera, PairLook.fill());
        strip = new ChooseImage(activity, look, PairScreens::picked);
        page.addView(strip, PairLook.row(ChooseImage.height(look)));
        put(page, PairLook.CAMERA, PairLook.CAMERA);
        scan.start();
        strip.start();
    }

    private static void code() {
        leaveCamera();
        level = CODE;
        LinearLayout page = look.column(look.bg);
        page.addView(look.topRow(look.back(look.ink, PairScreens::back)), PairLook.row(look.dp(48)));
        page.addView(look.text("Enter the code", 26, look.ink, true), look.spaced(24, 0));
        page.addView(look.text("The 9 digits under Settings › Devices on your PC", 15, look.muted, false), look.spaced(8, 0));
        EditText[] field = new EditText[1];
        TextView connect = look.primary("Connect", () -> typedId(field[0]));
        field[0] = CodeField.create(look, typed, connect, () -> typedId(field[0]), () -> { if (message != null) message.setText(""); });
        page.addView(field[0], look.spaced(24, 72));
        page.addView(slot(), PairLook.row(look.dp(44)));
        page.addView(new View(activity), PairLook.fill());
        page.addView(connect, PairLook.row(look.dp(56)));
        put(page, look.bg, look.bg);
        field[0].requestFocus();
        field[0].post(() -> { if (level == CODE) keyboard().showSoftInput(field[0], InputMethodManager.SHOW_IMPLICIT); });
    }

    private static void waiting() {
        leaveCamera();
        level = WAIT;
        LinearLayout page = look.column(look.bg);
        page.addView(look.topRow(null), PairLook.row(look.dp(48)));
        page.addView(new View(activity), PairLook.fill());
        page.addView(look.icon(), look.centred(72));
        TextView line = look.text("Connecting…", 18, look.ink, true);
        line.setMaxLines(2);
        page.addView(line, look.spaced(24, 56));
        digits = look.text("", 44, look.ink, true);
        digits.setLetterSpacing(0.1f);
        page.addView(digits, look.spaced(8, 64));
        message = line;
        page.addView(new View(activity), PairLook.fill());
        page.addView(look.quiet("Cancel", look.link, PairScreens::cancelWait), look.spaced(8, 0));
        put(page, look.bg, look.bg);
    }

    // ------------------------------------------------------------------ what the levels do

    private static boolean scanned(String text) {
        String id = ConnectionAddress.scanned(text);
        if (id == null) { status("This QR code is not an Autark pairing code."); return false; }
        go(id);
        return true;
    }

    private static void picked(String text) {
        String id = text == null ? null : ConnectionAddress.scanned(text);
        if (id == null) { status(text == null ? "No QR code found in this picture." : "This picture's QR code is not an Autark pairing code."); return; }
        go(id);
    }

    private static void typedId(EditText field) {
        String id;
        try { id = ConnectionAddress.remoteId(field.getText().toString()); } catch (IllegalArgumentException wrong) { status(wrong.getMessage()); return; }
        keyboard().hideSoftInputFromWindow(field.getWindowToken(), 0);
        typed = id;
        go(id);
    }

    private static void go(String id) {
        from = level;
        Consumer<String> target = onRemoteId;
        waiting();
        if (target != null) target.accept(id);
    }

    private static void cancelWait() {
        Consumer<String> target = onRemoteId;
        start();
        if (target != null) target.accept(null);
    }

    // ------------------------------------------------------------------ parts

    private static void put(View page, int top, int bottom) {
        host.removeAllViews();
        host.addView(page, new FrameLayout.LayoutParams(-1, -1));
        if (bars != null) bars.accept(PairLook.css(top), PairLook.css(bottom));
    }

    private static void leaveCamera() {
        if (scan != null) { scan.stop(); scan = null; }
        if (strip != null) { strip.stop(); strip = null; }
        if (host != null && level == CODE) keyboard().hideSoftInputFromWindow(host.getWindowToken(), 0);
        message = null; digits = null;
    }

    private static InputMethodManager keyboard() { return (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE); }

    /** The level's status line: two lines high, empty until something is said. */
    private static TextView slot() {
        message = look.text("", 14, look.muted, false);
        message.setMaxLines(2);
        return message;
    }
}
