// Owns: the native shell – the companies this phone is paired with (Companies; each its own local port and origin) and
// the switch between them, pairing by the PC's Remote ID through the native screens (pair/PairScreens: scanner, photo
// strip, code; the same screens for "Add a company", where Back returns), the one live link of the current company
// (CompanyLink; linked to every PC of the company, the page on one of them – a move to a PC with another Autark version
// reloads the page, B-084 M1), the WebView (PhoneWeb) that shows the PC's unchanged phone UI and its one page↔app channel (NativePort),
// the system bar strips (SystemBars), places opened from notifications, shortcuts and a recreation (PhoneRoutes), shares
// into Autark (ShareIn), the foreground service while paired (KeepAlive), the phone-use upgrade's dialog and a crashed
// renderer's recovery. Back goes back layer by layer in the web UI (window.autarkBack) and, with nothing left, puts the
// app in the background – it never closes itself. Its own screen besides pairing: "can't reach" (OfflineScreen: Try again,
// Choose PC – no Forget there since 19.11.2026), which
// opens the page again by itself once a PC of the company is linked.
// Above them all, the update line (UpdateBar, UpdateCheck) when a newer Autark is there. Before everything, the last
// start's crash report when there is one (CrashReport; its Report hands the trace to the page through NativePort); a
// failing optional part (bar colours, the foreground service, the notification question, the update line) never keeps
// the app from showing its screen. A PC that refused the page's token (the page's 'refused') hands the page to the
// company's next PC (CompanyLink). The old company's link closes off the main thread. Feedback 16.11.2026 (F15): the
// feedback video over the pairing screens on the first start and from their "How feedback works" (IntroTour), and on
// the page volume up and volume down pressed together as the feedback cell's press (VolumePair → the page's
// {t:'feedback', down}); one key alone stays the volume. W (19.11.2026): the page's 'wake' goes to CompanyLink.wake.
// Owner 19.11.2026: with the page's voice live ('voice.live') a pause leaves the WebView running, KeepAlive the microphone.
// Owner/Konrad 24.11.2026 (#821): the AI's request to use the phone is an ongoing notification until tapped (PhoneUseAsk)
// and, while this screen is open in front (inFront), the large native card (PhoneUseCard); the Lite build's tap or button
// goes through PhoneUseUpgrade.begin, and resumed() continues it after Android's "install unknown apps" switch.
// Today the page is the PC's own phone UI, loaded through the tunnel from the PC the page is on (one PC per page; the app is linked to every PC of the company and no PC outranks another); target 0.3.21: the app brings its own UI and talks to any PC.
// Never: needs a VPN or a reachable PC address, reads the UI's storage, or runs agents; it holds no copy of the UI until that bundled UI exists.
package com.teydralab.autark.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import com.teydralab.autark.android.pair.PairRun;
import com.teydralab.autark.android.pair.PairScreens;
import com.teydralab.autark.android.usage.UsageCount;
import com.teydralab.autark.android.relay.PhoneConnection;
import java.io.IOException;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;

public final class MainActivity extends Activity implements PhoneNavigation.Host, NativePort.Listener {
    /** The current company's live link for the whole process (it outlives a recreated activity). */
    private static CompanyLink link;
    /** The activity on screen: the process-wide link reports there. */
    private static volatile MainActivity current;
    private static final CompanyLink.Events EVENTS = new CompanyLink.Events() {
        @Override public void status(String text, boolean connected) { on(shown -> shown.linkStatus(text, connected)); }
        @Override public void linked() { on(MainActivity::moved); }
        @Override public void pcs(String company, List<PhoneConnection.Pc> pcs) { on(shown -> { shown.companies.setPcs(company, pcs); shown.sendCompanies(); }); }
    };

    private WebView web;
    private PhoneChrome chrome;
    private FrameLayout content;
    private UpdateBar updates;
    private TextView status;
    private SharedPreferences preferences;
    private Companies companies;
    private NativePort port;
    private String origin;
    private boolean setup;
    private boolean pageUp;
    private boolean resetHistory;
    private PhoneConnection.Pairing pairing;
    private String pendingRoute;
    private ShareIn.Shared pendingShare;
    /** The Autark version of the PC that served the page on screen (null: unknown). */
    private String pageVersion;
    /** The feedback video over the pairing screens while it shows (null: none). */
    private IntroTour tour;
    /** Volume up + down together on the page: the feedback cell's press; its wait runs on `keys`. */
    private final VolumePair volume = new VolumePair();
    private final Handler keys = new Handler(Looper.getMainLooper());
    private boolean voiceLive, paused; // the page's voice is live (it runs on while paused); the activity is paused

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String crash = CrashReport.last(this); // the last start's crash comes first, before anything that could crash again
        if (crash != null) {
            CrashReport.show(this, crash, () -> { start(state); resumed(); }, () -> { start(state); resumed(); port.crash(crash); });
            return;
        }
        start(state);
    }

    /** The app itself; until it ran (port == null) the lifecycle methods below leave everything alone. */
    private void start(Bundle state) {
        current = this;
        preferences = getSharedPreferences("pairing", MODE_PRIVATE);
        getSharedPreferences("connection", MODE_PRIVATE).edit().clear().apply(); // 0.1.0's https origin is no longer used
        companies = CompanyLink.companies(this, preferences);
        port = new NativePort(this, () -> origin, this);
        content = new FrameLayout(this);
        updates = new UpdateBar(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.addView(updates.view, new LinearLayout.LayoutParams(-1, -2));
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root); // first: the window's decor exists before SystemBars asks it for the insets controller
        optional(() -> { SystemBars.install(this, root, content); PairScreens.bars(SystemBars::apply); });
        PairScreens.tour(IntroTour.carried(this) ? this::showTour : null); // "How feedback works" on the first level
        PairScreens.usage(() -> UsageCount.on(this), on -> UsageCount.set(this, on)); // the first level's tick of the anonymous usage count (owner 25.11.2026)
        createWebView();
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        pendingRoute = state == null ? null : PhoneRoutes.place(state.getString("route"));
        PhoneConnection.Paired paired = companies.current();
        if (paired != null) open(paired); // onResume shows the update line (UpdateCheck)
        else { showPair(null, false); if (IntroTour.due(this, preferences)) showTour(); } // the first start: the video over the pairing
        if (state == null) arrive(getIntent()); // a recreated activity already handled its intent
    }

    /** A part the screen does without (bar colours, the notification question, the update line): its failure never stops the app. */
    private static void optional(Runnable step) {
        try { step.run(); } catch (RuntimeException error) { Log.w("Autark", "optional start step failed", error); }
    }

    /** The activity on screen, or null (where UpdateCheck delivers a background answer, and "Try again"). */
    static MainActivity shown() { return current; }

    /** This screen's update line. */
    UpdateBar updates() { return updates; }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (port != null) arrive(intent);
    }

    /** A pair link, a place (notification, shortcut), a share or the phone-use upgrade's tap. */
    private void arrive(Intent intent) {
        if (intent == null) return;
        String linked = ConnectionAddress.fromLink(intent.getDataString());
        if (linked != null) showPair(linked, companies.size() > 0);
        String route = AppNotices.route(intent);
        if (route != null) { if (pageUp) web.evaluateJavascript("location.hash='" + route + "'", null); else pendingRoute = route; }
        ShareIn.Shared shared = ShareIn.accept(intent);
        if (shared != null) { if (pageUp) port.share(shared.text, shared.files); else pendingShare = shared; }
        if (PhoneUseUpgrade.wanted(intent)) { intent.removeExtra(PhoneUseUpgrade.EXTRA); PhoneUseUpgrade.begin(this, updates::step); }
    }

    /** True while this screen is open in front of the person (the large phone-use card shows only then). */
    boolean inFront() { return port != null && !paused && !isFinishing() && !isDestroyed(); }

    private void createWebView() {
        web = PhoneWeb.create(this, () -> origin, this);
        chrome = new PhoneChrome(this, web, () -> origin);
        web.setWebChromeClient(chrome);
    }

    // ------------------------------------------------------------------ companies and the link

    /** Starts (or reuses) the current company's link, lets only this WebView through its local entrance, opens the PC's UI. */
    private void open(PhoneConnection.Paired paired) {
        PairScreens.stop();
        closeTour();
        String gate = CompanyLink.gate(preferences);
        if (link == null || !link.company.equals(companies.currentId())) {
            teardown();
            try { link = CompanyLink.open(this, companies.currentId(), paired, companies.port(), gate, EVENTS); }
            catch (IOException error) { showPair(null, false); PairScreens.status("The app could not open its local entrance: " + error.getMessage()); return; }
            catch (IllegalArgumentException error) { showPair(null, false); PairScreens.status("This phone's stored pairing could not be read; pair it once more."); return; }
        }
        optional(() -> KeepAlive.start(this));
        origin = link.origin;
        linkStatus(null, link.pcName() != null);
        PhoneWeb.admit(origin, gate);
        chrome.cancelMedia();
        setup = false;
        pageUp = false;
        content.removeAllViews();
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.onResume();
        resetHistory = true;
        // The phone UI keeps the token itself (lib/rpc-token.ts reads #token=, stores it and clears the address); a place follows in pageReady.
        web.loadUrl(origin + "/#token=" + Uri.encode(paired.token));
        optional(() -> AppNotices.askOnce(this, preferences));
    }

    /** The old company's page and link go; the link's sockets close on a thread of their own (CompanyLink.stop: the main
     *  thread may not write to the network – the 16.11.2026 crash on a company switch). */
    private void teardown() {
        port.dispose(); // the old company's page (a late 'card' or 'switch') never reaches the next company
        if (link != null) link.stop(this);
        link = null;
    }

    /** Another company (or the one just paired again): its own link and origin. */
    private void switchTo(String id) {
        if (!companies.setCurrent(id)) return;
        teardown();
        open(companies.current());
    }

    /** The pairing levels; adding: Back on the first level returns to the current company. */
    private void showPair(String remoteId, boolean adding) {
        closeTour();
        leaveWeb();
        status = null;
        if (pairing != null) { pairing.cancel(); pairing = null; } // a new pair link replaces a running pairing
        PairScreens.show(this, content, remoteId, adding, this::pairOrCancel, adding ? () -> { PhoneConnection.Paired p = companies.current(); if (p != null) open(p); else showPair(null, false); } : null);
    }

    /** The feedback video over the pairing screens (the first start, their "How feedback works"); closing it leaves them as they were. */
    private void showTour() {
        if (tour == null || !tour.shown()) tour = IntroTour.show(this, content, preferences);
    }

    private void closeTour() {
        if (tour != null) tour.close();
        tour = null;
    }

    /** An ID from the levels starts the pairing (its success adds the company); null cancels the wait. */
    private void pairOrCancel(String id) {
        if (pairing != null) { pairing.cancel(); pairing = null; }
        if (id == null) return;
        PhoneConnection.Pairing[] running = new PhoneConnection.Pairing[1];
        running[0] = pairing = PairRun.start(this, id, (paired) -> {
            if (pairing != running[0]) return;
            pairing = null;
            if (paired != null) { PairScreens.stop(); switchTo(companies.add(paired)); }
        });
    }

    /** The web UI could not load (no page of it on this phone yet): the reason, Try again and Choose PC – no Forget (19.11.2026). */
    @Override public void offline(String reason) {
        if (setup) return;
        leaveWeb();
        PairScreens.stop();
        status = OfflineScreen.show(this, content, reason, () -> {
            PhoneConnection.Paired paired = companies.current();
            if (link != null) link.connection.check();
            if (paired != null) open(paired);
        }, this::pickPc);
    }

    /** "Forget this phone" (the profile menu: autark-app:forget or the port's 'forget') – the current company only. */
    @Override public void confirmForget() {
        new AlertDialog.Builder(this)
                .setMessage("Sign this phone out of this company and remove its pairing here? On the PC, remove it under Settings › Devices too.")
                .setNegativeButton("Cancel", null).setPositiveButton("Forget", (dialog, which) -> forgetCurrent()).show();
    }

    private void forgetCurrent() {
        String gone = origin;
        teardown();
        leaveWeb();
        port.dispose();
        PhoneWeb.forgetOrigin(web, gone);
        origin = null;
        ShareIn.clear();
        pendingShare = null;
        PhoneConnection.Paired next = companies.remove(companies.currentId()) == null ? null : companies.current();
        if (next != null) { open(next); return; }
        KeepAlive.stop(this);
        preferences.edit().remove("gate").apply();
        showPair(null, false);
    }

    private void leaveWeb() {
        setup = true;
        pageUp = false;
        chrome.cancelMedia();
        web.stopLoading();
        web.loadUrl("about:blank"); port.close(); // Leaving the app page releases its live camera/microphone streams, port and voice.
        web.onPause();
        SystemBars.apply(null, null);
    }

    /** The link's line: the "can't reach" screen's text and the page's 'status' and 'companies'. */
    private void linkStatus(String text, boolean connected) {
        if (status != null && text != null) status.setText(text);
        port.status(connected && link != null ? link.pcName() : null, connected, link == null ? 0 : link.online(), link == null ? 0 : link.total());
        sendCompanies();
    }

    private void sendCompanies() { port.companies(companies.listJson(link == null ? null : link.pcName())); }

    /** The page moved to another channel (B-084 M1): a PC with another Autark version shows its own UI, else the page reconnects. */
    private void moved() {
        if (setup && status != null && pairing == null) { PhoneConnection.Paired paired = companies.current(); if (paired != null) open(paired); return; } // the "can't reach" screen: the page opens again on the PC now linked
        String now = link == null ? null : link.connection.version();
        if (pageUp && now != null && pageVersion != null && !now.equals(pageVersion)) { pageUp = false; web.reload(); }
        else port.resume();
    }

    private static void on(Consumer<MainActivity> step) {
        MainActivity shown = current;
        if (shown != null) shown.runOnUiThread(() -> { if (current == shown && !shown.isDestroyed()) step.accept(shown); });
    }

    // ------------------------------------------------------------------ the page (PhoneNavigation.Host, NativePort.Listener)

    @Override public boolean sameOrigin(String url) { return origin != null && ConnectionAddress.sameOrigin(origin, url); }

    @Override public void openExternal(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!(scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto") || scheme.equals("tel"))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { Toast.makeText(this, "No app is installed to open this link.", Toast.LENGTH_SHORT).show(); }
    }

    @Override public void pageReady(WebView view, String url, boolean newDocument) {
        if (view != web || setup) return;
        if (resetHistory) { web.clearHistory(); resetHistory = false; }
        if (!newDocument) return;
        port.pageLoaded(view, url);
        pageUp = true;
        pageVersion = link == null ? null : link.connection.version();
        if (pendingShare != null) { port.share(pendingShare.text, pendingShare.files); pendingShare = null; }
        if (pendingRoute != null) { web.evaluateJavascript("location.hash='" + pendingRoute + "'", null); pendingRoute = null; }
    }

    /** The renderer crashed or was killed: a new WebView on the same place. */
    @Override public void rendererGone(WebView view) {
        if (view != web) return;
        String place = PhoneRoutes.place(view.getUrl());
        port.dispose();
        chrome.dispose();
        content.removeView(view);
        view.destroy();
        createWebView();
        pageUp = false;
        if (setup) return;
        pendingRoute = place;
        PhoneConnection.Paired paired = companies.current();
        if (paired != null) open(paired); else showPair(null, false);
    }

    @Override public void card(String name, String avatar) { companies.setCard(name, avatar); sendCompanies(); }

    @Override public void switchCompany(String id) { if (!id.equals(companies.currentId())) switchTo(id); }

    @Override public void addCompany() { showPair(null, true); }

    @Override public void forget() { confirmForget(); }

    @Override public void pickPc() { if (link != null) link.pick(this, EVENTS); }

    @Override public void refused() { if (link != null) link.refused(); }

    /** W (19.11.2026): the page's Wake while no PC answers – through this company's own meeting-server link. */
    @Override public void wake(String id, String key, String name) {
        if (link == null) port.woken(id, "This phone is not connected to a company yet.");
        else link.wake(key, name, (error) -> port.woken(id, error));
    }

    /** The page's voice went live or ended: KeepAlive holds the microphone meanwhile; ended in the background, the page pauses now. */
    @Override public void voiceLive(boolean on, String kind) {
        voiceLive = on;
        optional(() -> KeepAlive.voice(this, on, kind));
        if (!on && paused && web != null) web.onPause();
    }

    /** The voice notice's End (KeepAlive): the page ends its voice; false without a page to ask. */
    boolean voiceStop() { return !isDestroyed() && port != null && port.voiceStop(); }

    // ------------------------------------------------------------------ Back and the lifecycle

    /** Back: the pairing levels walk back; a native screen returns to the app; the web UI goes back one layer; with none left the app goes to the background. */
    private void goBack() {
        if (port == null) { moveTaskToBack(true); return; } // the crash report's screen
        if (tour != null && tour.shown()) { closeTour(); return; } // Back skips the feedback video
        if (setup && PairScreens.back()) return;
        PhoneConnection.Paired paired = companies.current();
        if (setup && paired != null && pairing == null) { open(paired); return; }
        if (setup) { moveTaskToBack(true); return; }
        web.evaluateJavascript("(function(){try{return window.autarkBack?window.autarkBack():false}catch(e){return false}})()",
                (value) -> { if (!"true".equals(value)) moveTaskToBack(true); });
    }

    // API 33+ uses the OnBackInvokedDispatcher above; this callback covers Android 8–12.
    @SuppressLint("GestureBackNavigation") @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { goBack(); }
    @Override protected void onResume() {
        super.onResume();
        optional(() -> UsageCount.resumed(this)); // owner 25.11.2026: the app in front is "in use" – the anonymous usage count (usage/UsageCount)
        if (port != null) resumed();
    }
    private void resumed() {
        current = this;
        paused = false;
        AppNotices.resumed(true);
        optional(() -> AppNotices.clear(this));
        if (link != null) { link.connection.check(); optional(() -> KeepAlive.start(this)); }
        if (web != null && !setup) web.onResume();
        optional(() -> SelfUpdate.resumed(this, updates::step));
        optional(() -> PhoneUseUpgrade.resumed(this, updates::step)); // back from Android's "install unknown apps" switch
        optional(() -> PhoneUseAsk.settle(this)); // phone use there and agreed (or the full build after the upgrade): the request goes
        optional(() -> UpdateCheck.start(this, updates));
    }
    @Override protected void onPause() { paused = true; UsageCount.paused(); AppNotices.resumed(false); if (web != null) { if (!voiceLive) web.onPause(); CookieManager.getInstance().flush(); } super.onPause(); }
    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        String place = web == null || setup ? null : PhoneRoutes.place(web.getUrl());
        if (place != null) out.putString("route", place);
    }
    /** Volume up and down pressed together on the app's page are the feedback cell's press (VolumePair: short opens, held
     *  talks; the page's native-port.ts {t:'feedback', down}); one key alone stays the volume, as Android's own. */
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode(), action = event.getAction();
        if ((code != KeyEvent.KEYCODE_VOLUME_UP && code != KeyEvent.KEYCODE_VOLUME_DOWN) || (action != KeyEvent.ACTION_DOWN && action != KeyEvent.ACTION_UP)) return super.dispatchKeyEvent(event);
        if (port == null || !pageUp || setup) { volumeStep(volume.reset()); return super.dispatchKeyEvent(event); }
        VolumePair.Step step = volume.key(code == KeyEvent.KEYCODE_VOLUME_UP ? VolumePair.UP : VolumePair.DOWN,
                action == KeyEvent.ACTION_DOWN, event.getRepeatCount(), event.getEventTime());
        volumeStep(step);
        return step.consumed || super.dispatchKeyEvent(event);
    }

    private void volumeStep(VolumePair.Step step) {
        if (step.volume != 0) {
            AudioManager audio = getSystemService(AudioManager.class);
            if (audio != null) audio.adjustSuggestedStreamVolume(step.volume > 0 ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI);
        }
        if (step.feedback != 0 && port != null) port.feedback(step.feedback > 0);
        if (step.waitMs > 0) keys.postDelayed(() -> volumeStep(volume.expired(SystemClock.uptimeMillis())), step.waitMs);
    }

    /** The keyboard went elsewhere (a dialog, another app): a held pair is let go. */
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (!focused) volumeStep(volume.reset());
    }

    @Override protected void onDestroy() {
        if (current == this) current = null;
        if (pairing != null) { pairing.cancel(); pairing = null; } // a recreated activity shows the first level again
        keys.removeCallbacksAndMessages(null);
        PhoneUseCard.close();
        closeTour();
        PairScreens.stop();
        if (port != null) port.dispose();
        if (chrome != null) chrome.dispose();
        if (web != null) { content.removeAllViews(); web.destroy(); }
        super.onDestroy();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (!PairScreens.onPermissionResult(code, results) && chrome != null) chrome.permissionResult(code);
    }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (!PairScreens.onActivityResult(code, result, data) && chrome != null) chrome.activityResult(code, result, data);
    }
}
