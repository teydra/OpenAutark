// Owns: the app's one own screen besides pairing – "Can't reach your PC right now" with the reason (a line the
// connection keeps updating), Try again, Choose PC, one button per other company and "Add a company" (25.11.2026: a
// company whose PCs are off must never trap the phone – the person switches back here without reinstalling); light or
// dark text like the system. D4 (19.11.2026): no Forget on this path – a PC out of reach is no reason to drop the
// pairing; Forget stays in the web UI's Settings › Devices.
// Never: decides what the buttons do (MainActivity), or polls.
package com.teydralab.autark.android;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.List;
import java.util.function.Consumer;

final class OfflineScreen {
    private OfflineScreen() {}

    /** Fills content; returns the reason's line for later connection texts. `others` are {id, name} of the other companies. */
    static TextView show(Activity activity, FrameLayout content, String reason, Runnable retry, Runnable choosePc,
                         List<String[]> others, Consumer<String> switchTo, Runnable addCompany) {
        content.removeAllViews();
        float dp = activity.getResources().getDisplayMetrics().density;
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        LinearLayout form = new LinearLayout(activity);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(Math.round(24 * dp), Math.round(32 * dp), Math.round(24 * dp), Math.round(24 * dp));
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(form, new FrameLayout.LayoutParams(-1, -2));
        content.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        form.addView(text(activity, "Can't reach your PC right now", 20, dark, dp));
        TextView line = text(activity, reason, 15, dark, dp);
        line.setMinLines(3); // the connection's texts change here; nothing below moves
        form.addView(line);
        form.addView(button(activity, "Try again", retry));
        form.addView(button(activity, "Choose PC", choosePc));
        for (String[] other : others) form.addView(button(activity, "Switch to " + other[1], () -> switchTo.accept(other[0])));
        if (addCompany != null) form.addView(button(activity, "Add a company", addCompany));
        return line;
    }

    private static TextView text(Activity activity, String value, int size, boolean dark, float dp) {
        TextView view = new TextView(activity);
        view.setText(value); view.setTextSize(size); view.setTextColor(dark ? Color.WHITE : Color.BLACK);
        view.setPadding(0, 0, 0, Math.round(12 * dp));
        return view;
    }

    private static Button button(Activity activity, String label, Runnable action) {
        Button button = new Button(activity); button.setText(label); button.setAllCaps(false);
        button.setOnClickListener(view -> action.run()); return button;
    }
}
