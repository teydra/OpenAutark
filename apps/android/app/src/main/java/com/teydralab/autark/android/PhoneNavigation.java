// Owns: same-origin browsing, external links, the address autark-app:forget ("Forget this phone"; the app takes it over),
// telling the activity when a new document of its own origin is ready (NativePort hands it the port then), and recovery
// when the WebView's renderer crashed or was killed (the activity makes a new WebView instead of the app dying). The page
// is the app's own (relay/UiFiles) and shows its PCs' state itself; a failed load has no native screen.
// Never: bypasses TLS errors (WebView's default cancels them).
package com.teydralab.autark.android;

import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

final class PhoneNavigation extends WebViewClient {
    /** What the activity does for the WebView (MainActivity implements it). */
    interface Host {
        void confirmForget();
        boolean sameOrigin(String url);
        void openExternal(Uri uri);
        /** A main-frame page of the app's origin finished; newDocument is false for an in-page route change. */
        void pageReady(WebView view, String url, boolean newDocument);
        /** The renderer is gone: drop this WebView and open a new one on the same place. */
        void rendererGone(WebView view);
    }

    static final String FORGET = "autark-app:forget";
    private final Host host;
    private boolean newDocument;

    PhoneNavigation(Host host) { this.host = host; }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return false;
        String url = request.getUrl().toString();
        if (FORGET.equals(url)) { host.confirmForget(); return true; }
        if (host.sameOrigin(url)) return false;
        host.openExternal(request.getUrl());
        return true;
    }

    @Override public void onPageStarted(WebView view, String url, Bitmap favicon) { newDocument = true; }

    @Override public void onPageFinished(WebView view, String url) {
        if (!host.sameOrigin(url)) return;
        android.webkit.CookieManager.getInstance().flush();
        boolean fresh = newDocument;
        newDocument = false;
        host.pageReady(view, url, fresh);
    }

    @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        host.rendererGone(view);
        return true; // the app lives on; the activity has dropped this WebView
    }
}
