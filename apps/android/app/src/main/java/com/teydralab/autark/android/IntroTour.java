// Owns: the feedback video before pairing (owner 15.11.2026, F15: "wenn man das am Start der App, bevor man den QR-Code
// scannen kann oder Code eingeben kann … so ein Video kriegen würde, was einem zeigt, wie man da Feedback macht"):
// assets/tour.html – the PC tour's phone variant, built by build.ps1 from apps/desktop (scripts/tour-page.mjs) – in a
// WebView of its own laid over the pairing screens: only from their "How feedback
// works" (owner 26.11.2026: it never starts by itself). The page plays at once; its Skip and Continue open autark-tour:done, Back skips (MainActivity), and each
// closes it, so the pairing screen under it shows as it was. A build without the page (Gradle alone) shows none.
// Never: the network, the file system, a JavaScript interface, the PC's page or its port.
package com.teydralab.autark.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.IOException;
import java.util.Arrays;

final class IntroTour {
    static final String ASSET = "tour.html";
    static final String PAGE = "file:///android_asset/" + ASSET;
    /** The address the page opens for Skip and Continue (apps/desktop/src/ui/tour/phone-page.tsx DONE_ADDRESS). */
    static final String DONE = "autark-tour:done";
    private final FrameLayout host;
    private WebView view;

    private IntroTour(FrameLayout host) { this.host = host; }

    /** True when this build carries the page. */
    static boolean carried(Activity activity) {
        try {
            String[] names = activity.getAssets().list("");
            return names != null && Arrays.asList(names).contains(ASSET);
        } catch (IOException unreadable) {
            return false;
        }
    }

    /** Lays the video over `host` (the activity's content, the pairing screen under it). */
    @SuppressLint("SetJavaScriptEnabled")
    static IntroTour show(Activity activity, FrameLayout host) {
        IntroTour tour = new IntroTour(host);
        WebView web = new WebView(activity);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); // the video is code (the tour's player)
        settings.setAllowFileAccess(false); // file:///android_asset still loads; the file system does not
        settings.setAllowContentAccess(false);
        settings.setBlockNetworkLoads(true);
        web.setBackgroundColor(Color.TRANSPARENT); // until the page paints, the pairing screen shows through
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView from, WebResourceRequest request) {
                if (DONE.equals(request.getUrl().toString())) host.post(tour::close); // not inside the WebView's own call
                return true; // nothing else opens here
            }
        });
        host.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(PAGE);
        tour.view = web;
        return tour;
    }

    boolean shown() { return view != null; }

    /** Closes it (Skip, Continue, Back, or the screens under it changing): the WebView goes. */
    void close() {
        WebView web = view;
        if (web == null) return;
        view = null;
        host.removeView(web);
        web.destroy();
    }
}
