// Owns: the app's WebView as MainActivity uses it – its settings (JavaScript and DOM storage on, no file access, content://
// for the document picker, no mixed content, media without a second tap for a call's voice – B-084 decision 5, the
// AutarkAndroid/<version> (Android <release>; <maker> <model>) user agent, first-party cookies only), pictures the keyboard hands over (KeyboardContent), its navigation (PhoneNavigation), downloads of the PC's
// /files/ links to the phone (PhoneDownloads), and wiping one company's origin when the phone forgets it (its web storage
// and gate cookie; other companies' origins stay). Never: a JavaScript interface, debugging in release, or another origin's data.
package com.teydralab.autark.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Build;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.widget.Toast;
import com.teydralab.autark.android.relay.StreamProxy;
import java.util.function.Supplier;

final class PhoneWeb {
    private PhoneWeb() {}

    @SuppressLint("SetJavaScriptEnabled")
    static WebView create(Activity activity, Supplier<String> origin, PhoneNavigation.Host host, KeyboardContent.Sink pictures) {
        WebView web = KeyboardContent.webView(activity, pictures); // a picture from the keyboard's clipboard row lands (FCMWSZNH)
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Android document picker supplies content:// URIs.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false); // a call's voice plays without a second tap
        settings.setUserAgentString(settings.getUserAgentString() + " AutarkAndroid/" + UpdateCheck.installedName(activity) + device());
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new PhoneNavigation(host));
        web.setDownloadListener((url, agent, disposition, mime, length) -> {
            if (!PhoneDownloads.fetch(activity, origin.get(), url, disposition, mime, (name) -> {}))
                Toast.makeText(activity, "This file opens on the PC; Save in the app puts it on the phone.", Toast.LENGTH_LONG).show();
        });
        return web;
    }

    /** " (Android 16; samsung SM-S918B)": Chrome's reduced user agent hides the model, a feedback report names it
     *  (ui/feedback/client.ts on the PC reads it). Brackets and semicolons in a maker's name would break the group. */
    static String device() {
        String model = (Build.MANUFACTURER + " " + Build.MODEL).replaceAll("[();]", " ").replaceAll("\\s+", " ").trim();
        String release = Build.VERSION.RELEASE == null ? "" : Build.VERSION.RELEASE.replaceAll("[();\\s]", "");
        return " (Android " + release + (model.isEmpty() ? "" : "; " + model) + ")";
    }

    /** Lets only this WebView through the company's local entrance (the gate cookie on its origin). */
    static void admit(String origin, String gate) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(origin, StreamProxy.GATE_COOKIE + "=" + gate + "; Path=/; HttpOnly; SameSite=Strict");
        cookies.flush();
    }

    /** "Forget this phone" for one company: its origin's web storage and gate cookie go, and the WebView's cache and history. */
    static void forgetOrigin(WebView web, String origin) {
        web.clearCache(true);
        web.clearHistory();
        if (origin == null) return;
        WebStorage.getInstance().deleteOrigin(origin);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(origin, StreamProxy.GATE_COOKIE + "=; Max-Age=0; Path=/");
        cookies.flush();
    }
}
