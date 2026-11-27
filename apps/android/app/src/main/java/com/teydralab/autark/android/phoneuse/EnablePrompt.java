// Owns: the notification that asks the person to turn phone use on – "Let the AI use this phone": one tap opens the
// in-app disclosure (UseDisclosure) first and, once the person agreed, Android's Accessibility settings (Autark › Use this
// phone). A sideloaded app on Android 13+ first needs Settings › Apps › Autark › ⋮ › Allow restricted settings – the notification says so
// and has App info as its second button (not for an install from Google Play). Owner/Konrad 24.11.2026 (#821; the AI asked
// three times on the S9 and the person saw nothing): the notification is ongoing (PhoneUseAsk, ID 4107, own heads-up
// channel) – a swipe does not remove it, a tap does, or phone use being on and agreed – and posted on every AI request (no
// ten-minute throttle); with Autark open in front the large card (PhoneUseCard) comes besides. Not at all in the build
// without phone use. Never: turns anything on itself, or sends the person to the settings before the disclosure.
package com.teydralab.autark.android.phoneuse;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.teydralab.autark.android.PhoneUseAsk;
import com.teydralab.autark.android.PhoneUseAskRule;

public final class EnablePrompt {
    private static final int ID = PhoneUseAsk.ID_FULL;

    private EnablePrompt() {}

    /** The text of the prompt: it says where the tap goes – the disclosure first, or (agreed before, only the switch off)
     * Accessibility right away, as UseDisclosure skips itself then. */
    public static String text(Context context) {
        return PhoneUseAskRule.prompt(UseConsent.agreed(context), Build.VERSION.SDK_INT >= 33);
    }

    /** Every AI request while phone use is off or not agreed (any thread): the ongoing notification – the same id again
     * changes nothing and alerts once – and, with Autark open in front, the large card. */
    public static void show(Context context) {
        if (!UseConsent.available(context)) return;
        Context app = context.getApplicationContext();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // The disclosure comes first; once agreed it passes on to the settings itself.
        PendingIntent settings = PendingIntent.getActivity(context, 1, new Intent(context, UseDisclosure.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags);
        PendingIntent appInfo = PendingIntent.getActivity(context, 2, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", context.getPackageName(), null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags);
        String text = text(app);
        Notification notification = PhoneUseAsk.builder(app).setContentTitle(PhoneUseAskRule.TITLE).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(settings)
                .addAction(new Notification.Action.Builder(null, "App info", appInfo).build()).build();
        PhoneUseAsk.post(app, ID, notification); // not allowed to notify: the card shows in the open app
        PhoneUseAsk.card(app, PhoneUseAskRule.Kind.FULL);
    }
}
