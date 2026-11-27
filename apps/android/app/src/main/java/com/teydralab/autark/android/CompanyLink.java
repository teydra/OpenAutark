// Owns: the one live link of the current company for the whole app process (B-084, decisions 7 and 8): its connection
// (relay/PhoneConnection) behind the company's own local port (its own origin), the phone-use socket (phoneuse/UseLink),
// the network callback pointed at it (relay/NetworkWake), and which PC the page is on and how many are linked – the page
// takes whichever PC of the company answers (owner 27.11.2026: no PC picker). A PC that refused the page's token (the
// page's 'refused', 16.11.2026) gives the page to the next PC of the company that has not refused in this link.
// Also where the company list and the entrance's gate secret are kept (SharedPreferences under Companies).
// Events go to the activity on screen (MainActivity forwards them); the connection's state shows in the page's status
// line only (the KeepAlive notice is fixed). stop() ends the sockets on a thread of its own – Android refuses network
// writes on the main thread (16.11.2026 crash on a company switch). W (19.11.2026): wake() wakes a PC whose app is closed
// through the connection's own meeting-server link, on a thread of its own. Never: decides a pairing's record (Companies does),
// touches the WebView, or keeps two companies' links at once.
package com.teydralab.autark.android;

import android.content.Context;
import android.content.SharedPreferences;
import com.teydralab.autark.android.phoneuse.UseLink;
import com.teydralab.autark.android.relay.Crypto;
import com.teydralab.autark.android.relay.NetworkWake;
import com.teydralab.autark.android.relay.PhoneConnection;
import com.teydralab.autark.android.relay.WebRtc;
import java.io.IOException;
import java.util.List;

final class CompanyLink {
    /** What the link reports (any thread). */
    interface Events {
        void status(String text, boolean connected);
        /** A new channel to a PC is up (after a pause, a network change or a PC switch): the page refreshes. */
        void linked();
        /** The company's PCs changed (phoneUse.attach): the caller stores them for `company`. */
        void pcs(String company, List<PhoneConnection.Pc> pcs);
    }

    final String company;
    final String origin;
    final PhoneConnection connection;
    private final UseLink use;

    private CompanyLink(String company, String origin, PhoneConnection connection, UseLink use) {
        this.company = company; this.origin = origin; this.connection = connection; this.use = use;
    }

    /** The company list on SharedPreferences ('companies'; 'pairing' holds 0.3.x's single record to move and the gate). */
    static Companies companies(Context context, SharedPreferences pairing) {
        return new Companies(store(context.getSharedPreferences("companies", Context.MODE_PRIVATE)), store(pairing));
    }

    /** The local entrance's secret cookie value (one for all companies' origins), made once. */
    static String gate(SharedPreferences pairing) {
        String gate = pairing.getString("gate", "");
        if (gate.isEmpty()) { gate = Crypto.b64url(Crypto.random(24)); pairing.edit().putString("gate", gate).apply(); }
        return gate;
    }

    private static Companies.Store store(SharedPreferences prefs) {
        return new Companies.Store() {
            @Override public String get(String key) { return prefs.getString(key, null); }
            @Override public void put(String key, String value) { if (value == null) prefs.edit().remove(key).apply(); else prefs.edit().putString(key, value).apply(); }
        };
    }

    /** Starts the company's connection on its port (any free one when taken) and its phone-use socket. */
    static CompanyLink open(Context context, String company, PhoneConnection.Paired paired, int port, String gate, Events events) throws IOException {
        Context app = context.getApplicationContext();
        PhoneConnection connection = new PhoneConnection(paired, events::status, new WebRtc(app)); // F25: WebRTC way
        connection.onLinked(events::linked);
        String origin = connection.start(port, gate);
        UseLink use = new UseLink(app, origin, gate, paired.token, paired.deviceId, Crypto.fromB64url(paired.seed), (pcs) -> {
            connection.updatePcs(pcs);
            events.pcs(company, connection.paired().pcs);
        });
        use.start();
        NetworkWake.register(app, connection);
        return new CompanyLink(company, origin, connection, use);
    }

    /** Ends the network callback's target and the local entrance at once (its port is free for the same company opened
     *  again, e.g. after "Pair again"), the connection and phone-use socket on their own thread – nothing waits for it. */
    void stop(Context context) {
        NetworkWake.register(context, null);
        connection.closeEntrance();
        Thread closer = new Thread(() -> {
            try { use.stop(); connection.stop(); }
            catch (RuntimeException error) { android.util.Log.w("Autark", "link stop failed: " + error.getClass().getName()); }
        }, "autark-link-stop");
        closer.setDaemon(true);
        closer.start();
    }

    /** The page's PC refused its token: the page goes to the next PC of the company that has not refused in this link. */
    void refused() { connection.refused(); }

    /** W (19.11.2026): wakes a PC of this company whose app is closed (its wake helper key) on a thread of its own –
     *  network never on the main thread; `done` hears null (woken) or the sentence why not. */
    void wake(String key, String name, java.util.function.Consumer<String> done) {
        Thread waker = new Thread(() -> {
            try { connection.wake(key, name == null ? "Your PC" : name); done.accept(null); }
            catch (IOException | RuntimeException error) { done.accept(error.getMessage() == null ? "The wake did not go through." : error.getMessage()); }
        }, "autark-wake");
        waker.setDaemon(true);
        waker.start();
    }

    /** The name of the PC the link goes to now, or null. */
    String pcName() { return connection.pcName(); }

    /** How many of the company's PCs have a channel now, and how many are paired. */
    int online() { return connection.linkedCount(); }
    int total() { return connection.pcs().size(); }
}
