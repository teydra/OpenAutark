// Owns: the app's one own screen besides pairing – "Autark can't open its page" when the company's local entrance
// could not open its port (another app holds it), with the reason and the plain fact that the app keeps trying by
// itself (owner 27.11.2026: no Try again; the page itself is in the app and always loads, and shows its PCs' state
// itself); light or dark text like the system. While it shows, it runs the caller's retry every RETRY_MS; once its view
// is gone (the page opened, pairing, another company), that ends.
// Never: decides what a retry does (MainActivity), or shows a control that only repeats what the app already does.
package com.teydralab.autark.android;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

final class EntranceScreen {
    /** How often the screen tries again by itself. */
    static final long RETRY_MS = 3_000;

    private EntranceScreen() {}

    /** Fills content and runs `retry` every RETRY_MS while it shows. */
    static void show(Activity activity, FrameLayout content, String reason, Runnable retry) {
        content.removeAllViews();
        float dp = activity.getResources().getDisplayMetrics().density;
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        LinearLayout form = new LinearLayout(activity);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(Math.round(24 * dp), Math.round(32 * dp), Math.round(24 * dp), Math.round(24 * dp));
        content.addView(form, new FrameLayout.LayoutParams(-1, -1));
        form.addView(text(activity, "Autark can't open its page", 20, dark, dp));
        form.addView(text(activity, reason, 15, dark, dp));
        TextView trying = text(activity, "Autark keeps trying by itself and opens the page as soon as the port is free.", 13, dark, dp);
        trying.setAlpha(0.7f);
        form.addView(trying);
        Runnable[] again = new Runnable[1];
        again[0] = () -> {
            if (form.getParent() != content || !form.isAttachedToWindow()) return; // the screen is gone
            retry.run();
            if (form.getParent() == content) form.postDelayed(again[0], RETRY_MS);
        };
        form.postDelayed(again[0], RETRY_MS);
    }

    private static TextView text(Activity activity, String value, int size, boolean dark, float dp) {
        TextView view = new TextView(activity);
        view.setText(value); view.setTextSize(size); view.setTextColor(dark ? Color.WHITE : Color.BLACK);
        view.setPadding(0, 0, 0, Math.round(12 * dp));
        return view;
    }
}
