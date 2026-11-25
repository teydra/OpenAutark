// Owns: the pairing screens' look – light and dark tones from the system's uiMode, the accent #2C665A, dp, rounded fills
// with a touch ripple, and the few parts the levels share (page column, top row, app icon, centred text, the one big
// primary action, a quiet link, the back mark, layout params). Never: arranges a level, holds state or runs an action.
package com.teydralab.autark.android.pair;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.teydralab.autark.android.R;
import java.util.function.Consumer;

final class PairLook {
    static final int ACCENT = 0xFF2C665A;
    static final int CAMERA = 0xFF000000;
    final Activity activity;
    final boolean dark;
    final int bg, ink, muted, card, line, link;

    PairLook(Activity activity) {
        this.activity = activity;
        dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        bg = dark ? 0xFF111614 : 0xFFF6F8F7;
        ink = dark ? 0xFFE8EEEB : 0xFF16201D;
        muted = dark ? 0xFF9AA6A1 : 0xFF5B6662;
        card = dark ? 0xFF1C2421 : 0xFFFFFFFF;
        line = dark ? 0xFF2F3A36 : 0xFFD6DEDA;
        link = dark ? 0xFF8CCBB8 : ACCENT;
    }

    int dp(float value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }

    static String css(int color) { return String.format("#%06X", color & 0xFFFFFF); }

    GradientDrawable round(int fill, float radiusDp, int stroke) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(radiusDp));
        if (stroke != 0) shape.setStroke(dp(1), stroke);
        return shape;
    }

    Drawable touch(Drawable fill, int ripple) { return new RippleDrawable(ColorStateList.valueOf(ripple), fill, fill == null ? round(0xFFFFFFFF, 12, 0) : null); }

    TextView text(String value, float sp, int color, boolean bold) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return view;
    }

    /** The one primary action of a level: full width, 56 dp, accent fill; disabled shows faded and does nothing. */
    TextView primary(String label, Runnable action) {
        TextView view = text(label, 17, 0xFFFFFFFF, true);
        view.setBackground(touch(round(ACCENT, 16, 0), 0x40FFFFFF));
        view.setOnClickListener(clicked -> { if (clicked.isEnabled()) action.run(); });
        return view;
    }

    static void enable(View view, boolean on) { view.setEnabled(on); view.setAlpha(on ? 1f : 0.4f); }

    /** A quiet text action with a 48 dp touch target. */
    TextView quiet(String label, int color, Runnable action) {
        TextView view = text(label, 15, color, true);
        view.setMinHeight(dp(48));
        view.setPadding(dp(16), 0, dp(16), 0);
        view.setBackground(touch(null, (color & 0xFFFFFF) | 0x30000000));
        view.setOnClickListener(clicked -> action.run());
        return view;
    }

    /** A ticked row: a box and its title and sentence beside it (owner 25.11.2026: the anonymous usage count on the first level, same wording as Settings). */
    View check(String title, String text, boolean checked, Consumer<Boolean> changed) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.TOP);
        row.setPadding(dp(12), dp(8), dp(12), dp(8));
        row.setBackground(round(card, 12, line));
        CheckBox box = new CheckBox(activity);
        box.setChecked(checked);
        box.setButtonTintList(ColorStateList.valueOf(dark ? link : ACCENT));
        box.setContentDescription(title);
        box.setOnCheckedChangeListener((view, on) -> changed.accept(on));
        row.addView(box, new LinearLayout.LayoutParams(-2, -2));
        TextView words = text(title + " – " + text, 13, muted, false);
        words.setGravity(Gravity.START);
        row.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
        row.setOnClickListener(clicked -> box.toggle());
        return row;
    }

    /** The back mark at a level's top left (48 x 48 dp). */
    TextView back(int color, Runnable action) {
        TextView view = quiet("←", color, action);
        view.setTextSize(22);
        view.setPadding(0, 0, 0, 0);
        view.setContentDescription("Back");
        return view;
    }

    /** A level's page: a vertical column in the level's tone with the side gutters. */
    LinearLayout column(int background) {
        LinearLayout page = new LinearLayout(activity);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(background);
        page.setPadding(dp(24), dp(8), dp(24), dp(24));
        return page;
    }

    /** The 48 dp top row; empty when there is no back mark, so every level starts at the same height. */
    View topRow(View back) {
        FrameLayout row = new FrameLayout(activity);
        if (back != null) row.addView(back, new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.START));
        return row;
    }

    ImageView icon() {
        ImageView icon = new ImageView(activity);
        icon.setImageResource(R.drawable.autark_icon);
        icon.setBackground(round(card, 22, 0));
        icon.setClipToOutline(true);
        icon.setContentDescription("Autark");
        return icon;
    }

    LinearLayout.LayoutParams centred(int sizeDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp));
        params.gravity = Gravity.CENTER_HORIZONTAL;
        return params;
    }

    /** Wrap height (or a fixed height when heightDp > 0) with a top margin. */
    LinearLayout.LayoutParams spaced(int topDp, int heightDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, heightDp > 0 ? dp(heightDp) : -2);
        params.topMargin = dp(topDp);
        return params;
    }

    static LinearLayout.LayoutParams row(int height) { return new LinearLayout.LayoutParams(-1, height); }
    static LinearLayout.LayoutParams fill() { return new LinearLayout.LayoutParams(-1, 0, 1); }
}
