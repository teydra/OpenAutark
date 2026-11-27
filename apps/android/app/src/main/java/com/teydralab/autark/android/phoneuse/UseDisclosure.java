// Owns: the prominent disclosure screen for phone use – shown inside the app before Android's Accessibility settings are
// opened (the enable notification and a service the person switched on by hand both lead here first). "Agree and continue"
// stores the agreement (UseConsent) and opens Accessibility settings; "Not now" stores nothing, and if the service is
// already on it is switched off again. Wording: DisclosureText. Never: opens settings without the tap, or reads anything.
package com.teydralab.autark.android.phoneuse;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Locale;

public final class UseDisclosure extends Activity {
    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (UseConsent.agreed(this)) { openSettings(); finish(); return; }
        boolean german = UiLang.german(this);
        float density = getResources().getDisplayMetrics().density;
        int pad = (int) (20 * density);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText(DisclosureText.title(german));
        title.setTextSize(22);
        title.setTextColor(Color.BLACK);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(title);
        TextView body = new TextView(this);
        body.setText(DisclosureText.body(german));
        body.setTextSize(15);
        body.setTextColor(Color.rgb(0x22, 0x22, 0x22));
        body.setLineSpacing(0, 1.15f);
        body.setPadding(0, pad / 2, 0, pad / 2);
        column.addView(body);
        if (android.os.Build.VERSION.SDK_INT >= 33) { // Android 13+ greys the switch out for an app from outside the store
            TextView restricted = new TextView(this);
            restricted.setText(DisclosureText.restricted(german));
            restricted.setTextSize(14);
            restricted.setTextColor(Color.rgb(0x44, 0x44, 0x44));
            restricted.setLineSpacing(0, 1.15f);
            restricted.setPadding(0, 0, 0, pad / 2);
            column.addView(restricted);
        }
        Button agree = new Button(this);
        agree.setText(DisclosureText.agree(german));
        agree.setAllCaps(false);
        agree.setOnClickListener(view -> { UseConsent.agree(this); UseService.notifyChanged(); openSettings(); finish(); });
        column.addView(agree, new LinearLayout.LayoutParams(-1, (int) (52 * density)));
        Button decline = new Button(this);
        decline.setText(DisclosureText.decline(german));
        decline.setAllCaps(false);
        decline.setOnClickListener(view -> { UseService.turnOff(); finish(); });
        column.addView(decline, new LinearLayout.LayoutParams(-1, (int) (52 * density)));
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        scroll.setFillViewport(true);
        scroll.addView(column);
        setContentView(scroll);
    }

    private void openSettings() {
        try { startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); } catch (RuntimeException error) { /* no settings screen */ }
    }
}
