// Owns: the one question for Android's battery exemption (25.11.2026): with phone use on, Android and Samsung may put
// the app to sleep behind a dark screen and the AI cannot reach the phone. Asked once, when the app is opened, as
// Android's own dialog (one tap "Allow"). Only the website APK declares the permission; the Play builds never ask.
// Never: asks without phone use, or a second time.
package com.teydralab.autark.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import com.teydralab.autark.android.phoneuse.UseConsent;
import com.teydralab.autark.android.phoneuse.UseService;

final class BatteryExempt {
    private static final String ASKED = "batteryExemptionAsked";

    private BatteryExempt() {}

    @SuppressLint("BatteryLife") // phone use is the app reaching the phone on the person's own order
    static void ask(Activity activity, SharedPreferences preferences) {
        if (UseService.current() == null || !UseConsent.agreed(activity) || preferences.getBoolean(ASKED, false)) return;
        if (activity.checkSelfPermission(Manifest.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) != PackageManager.PERMISSION_GRANTED) return;
        PowerManager power = activity.getSystemService(PowerManager.class);
        if (power == null || power.isIgnoringBatteryOptimizations(activity.getPackageName())) return;
        preferences.edit().putBoolean(ASKED, true).apply();
        activity.startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + activity.getPackageName())));
    }
}
