// Owns: the large in-app card of the request "Let the AI use this phone" while Autark is open in front (owner/Konrad
// 24.11.2026, #821): a native dialog – it works with an empty web page and an unreachable PC – with the title, one line of
// what happens and one primary button. Lite build: the button adds phone use (PhoneUseUpgrade.begin: download and install
// through the app's own session; first Android's "install unknown apps" switch for this app when it is off). Full build:
// the button opens the disclosure (UseDisclosure), never Accessibility settings before it. "Not now" (or Back) closes the
// card and keeps the notification. One card at a time; it closes with its activity.
// Never: starts a download or opens settings without the tap, or turns phone use on.
package com.teydralab.autark.android;

import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.teydralab.autark.android.phoneuse.UseConsent;
import com.teydralab.autark.android.phoneuse.UseDisclosure;

final class PhoneUseCard {
    private static AlertDialog open;
    private static long notNowAt;

    private PhoneUseCard() {}

    /** Shows the card on `activity` unless one is up or the person just said "Not now" (main thread). */
    static void show(MainActivity activity, PhoneUseAskRule.Kind kind) {
        if (!PhoneUseAskRule.cardDue(activity.inFront(), open != null && open.isShowing(), System.currentTimeMillis(), notNowAt)) return;
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int background = dark ? Color.rgb(0x1E, 0x2A, 0x27) : Color.WHITE;
        int foreground = dark ? Color.rgb(0xEE, 0xF4, 0xF2) : Color.rgb(0x10, 0x22, 0x1E);
        float density = activity.getResources().getDisplayMetrics().density;
        int pad = (int) (24 * density);
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(pad, pad, pad, pad / 2);
        TextView title = new TextView(activity);
        title.setText(PhoneUseAskRule.TITLE);
        title.setTextSize(24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(foreground);
        column.addView(title);
        TextView body = new TextView(activity);
        boolean agreed = kind == PhoneUseAskRule.Kind.FULL && UseConsent.agreed(activity); // the button then opens Accessibility right away
        body.setText(PhoneUseAskRule.line(kind, agreed));
        body.setTextSize(17);
        body.setTextColor(foreground);
        body.setLineSpacing(0, 1.15f);
        body.setPadding(0, pad / 2, 0, pad / 2);
        column.addView(body);
        if (kind == PhoneUseAskRule.Kind.FULL && android.os.Build.VERSION.SDK_INT >= 33) {
            TextView restricted = new TextView(activity);
            restricted.setText(PhoneUseAskRule.RESTRICTED);
            restricted.setTextSize(14);
            restricted.setTextColor(foreground);
            restricted.setAlpha(0.8f);
            restricted.setPadding(0, 0, 0, pad / 2);
            column.addView(restricted);
        }
        Button go = new Button(activity);
        go.setText(PhoneUseAskRule.button(kind, agreed));
        go.setAllCaps(false);
        go.setTextSize(18);
        go.setTextColor(Color.WHITE);
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(0xFFFF4F00);
        fill.setCornerRadius(14 * density);
        go.setBackground(fill);
        column.addView(go, new LinearLayout.LayoutParams(-1, (int) (60 * density)));
        Button later = new Button(activity);
        later.setText(PhoneUseAskRule.NOT_NOW);
        later.setAllCaps(false);
        later.setTextColor(foreground);
        later.setBackgroundColor(Color.TRANSPARENT);
        column.addView(later, new LinearLayout.LayoutParams(-1, (int) (52 * density)));
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(column);
        AlertDialog dialog = new AlertDialog.Builder(activity).setView(scroll).create();
        GradientDrawable card = new GradientDrawable();
        card.setColor(background);
        card.setCornerRadius(20 * density);
        Window window = dialog.getWindow();
        if (window != null) window.setBackgroundDrawable(card);
        dialog.setOnCancelListener(view -> notNowAt = System.currentTimeMillis()); // Back or a tap outside = Not now
        later.setOnClickListener(view -> { notNowAt = System.currentTimeMillis(); dialog.dismiss(); });
        go.setOnClickListener(view -> { dialog.dismiss(); go(activity, kind); });
        open = dialog;
        try {
            dialog.show();
            if (window != null) window.setLayout((int) (activity.getResources().getDisplayMetrics().widthPixels * 0.94f), ViewGroup.LayoutParams.WRAP_CONTENT);
            if (window != null) window.setGravity(Gravity.CENTER);
        } catch (RuntimeException error) { open = null; /* the activity is going: the notification stays */ }
    }

    private static void go(MainActivity activity, PhoneUseAskRule.Kind kind) {
        PhoneUseAsk.cancel(activity); // the tap is the answer to the notification, too
        if (kind == PhoneUseAskRule.Kind.LITE) { PhoneUseUpgrade.begin(activity, activity.updates()::step); return; }
        try { activity.startActivity(new Intent(activity, UseDisclosure.class)); } catch (RuntimeException error) { /* the notification posts again with the next request */ }
    }

    /** The activity goes: its card goes with it. */
    static void close() {
        AlertDialog dialog = open;
        open = null;
        if (dialog != null) { try { dialog.dismiss(); } catch (RuntimeException error) { /* already gone */ } }
    }
}
