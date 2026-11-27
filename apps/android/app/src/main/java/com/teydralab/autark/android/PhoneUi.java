// Owns: the app's one interface store for the whole process (relay/UiUpdate over files/ui and the APK's assets/ui, which
// build.ps1 fills with apps/desktop's app/ui and its ui.json) and its look for a newer list when the person returns to
// the app – on a thread of its own, over HTTPS from UiUpdate.BASE (owner 27.11.2026: an update of the interface fetches
// only the files that changed). In every build flavour; with no UiUpdate.PUBLIC_KEY yet it never looks.
// Never: decides whether a list counts (UiUpdate does), or reloads the page (MainActivity does, voice permitting).
package com.teydralab.autark.android;

import android.content.Context;
import android.content.res.AssetManager;
import com.teydralab.autark.android.relay.UiUpdate;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

final class PhoneUi {
    private static UiUpdate store;

    private PhoneUi() {}

    /** The store, made on first use: the APK's list, the ready lists in files/ui, the running page's choice. */
    static synchronized UiUpdate store(Context context) {
        if (store == null) {
            Context app = context.getApplicationContext();
            AssetManager assets = app.getAssets();
            store = new UiUpdate(new File(app.getFilesDir(), "ui"), path -> {
                try (InputStream in = assets.open("ui/" + path)) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buffer = new byte[64 * 1024];
                    for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
                    return out.toByteArray();
                } catch (FileNotFoundException missing) { return null; }
            }, UiUpdate.publicKey());
        }
        return store;
    }

    /** On return to the app: a look for a newer list when one is due (at most once a minute), off the main thread. */
    static void resumed(Context context) {
        UiUpdate ui = store(context);
        if (!ui.due(System.currentTimeMillis())) return;
        Thread look = new Thread(() -> ui.check(PhoneUi::open, System.currentTimeMillis()), "autark-ui");
        look.setDaemon(true);
        look.start();
    }

    /** One published file; anything but a 200 is an IOException (the store then keeps what it has). */
    private static InputStream open(String name) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(UiUpdate.BASE + name).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        connection.setInstanceFollowRedirects(true);
        if (connection.getResponseCode() != 200) { connection.disconnect(); throw new IOException("HTTP " + connection.getResponseCode() + " for " + name); }
        return connection.getInputStream();
    }
}
