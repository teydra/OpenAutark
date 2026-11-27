// Owns: the app's own setting for the bubble on the lock screen (BubbleLock: Off, On, On with a note to the AI) as a
// small native dialog – reached from Android's App info ("Additional settings in the app": the
// APPLICATION_PREFERENCES action of the manifest) and from the bubble's quick area (TodoButton). The choice goes into
// SharedPreferences "todo_button" (BubbleLock.KEY); the bubble hears the change at once. While the phone is locked the
// dialog changes nothing (whoever holds a locked phone must not turn the bubble on for it) and says so.
// Never: a choice without the person's tap, or a change while the keyguard shows.
package com.teydralab.autark.android.phoneuse;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.widget.Toast;
import java.util.Locale;

public final class BubbleSettings extends Activity {
    /** Opens the dialog from outside an activity (the bubble's quick area). */
    static void open(Context context) {
        context.startActivity(new Intent(context, BubbleSettings.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private AlertDialog dialog;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        boolean german = UiLang.german(this);
        KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard != null && keyguard.isKeyguardLocked()) {
            Toast.makeText(this, german ? "Entsperre das Handy, um das zu ändern." : "Unlock the phone to change this.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        SharedPreferences place = getSharedPreferences("todo_button", Context.MODE_PRIVATE);
        String now = BubbleLock.mode(place.getString(BubbleLock.KEY, null));
        CharSequence[] items = new CharSequence[BubbleLock.ORDER.length];
        int checked = 0;
        for (int i = 0; i < items.length; i++) {
            String value = BubbleLock.ORDER[i];
            items[i] = BubbleLock.label(value, german) + "\n" + BubbleLock.explain(value, german);
            if (value.equals(now)) checked = i;
        }
        dialog = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle(BubbleLock.title(german))
                .setSingleChoiceItems(items, checked, (shown, which) -> {
                    place.edit().putString(BubbleLock.KEY, BubbleLock.ORDER[which]).putBoolean(BubbleLock.ASKED, true).apply();
                    shown.dismiss();
                })
                .setNegativeButton(german ? "Schließen" : "Close", (shown, which) -> shown.dismiss())
                .setOnDismissListener((shown) -> finish())
                .create();
        dialog.show();
    }

    @Override protected void onDestroy() {
        if (dialog != null && dialog.isShowing()) dialog.setOnDismissListener(null);
        if (dialog != null) dialog.dismiss();
        super.onDestroy();
    }
}
