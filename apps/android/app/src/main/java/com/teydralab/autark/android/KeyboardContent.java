// Owns: pictures the keyboard hands over (FCMWSZNH, 24.11.2026: Gboard's or Samsung's clipboard row, a sticker, a GIF).
// A keyboard offers a picture only to a field that names image types in EditorInfo.contentMimeTypes; Chromium's
// WebView names none, so the keyboard struck the picture through. The app's WebView names image/* here and takes the
// keyboard's commitContent: it reads the picture (with the keyboard's one-time read grant, released right after) on a
// thread of its own and hands {name, mime, data} to the page (NativePort 'paste'), which pastes it into the focused field
// like a picture from the PC's clipboard. Never: a picture over MAX_BYTES, a type other than an image, a file:// URI,
// or the picture kept on the phone.
package com.teydralab.autark.android;

import android.content.ClipDescription;
import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputContentInfo;
import android.webkit.WebView;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

final class KeyboardContent {
    /** Where a picture goes: its file name, its type and its bytes as base64. Any thread. */
    interface Sink { void picture(String name, String mime, String base64); }

    /** The largest picture taken (a phone screenshot is a few MB; base64 makes it a third bigger on the port). */
    static final int MAX_BYTES = 15 * 1024 * 1024;

    private KeyboardContent() {}

    /** The app's WebView, which takes pictures from the keyboard into `sink`. */
    static WebView webView(Context context, Sink sink) {
        return new WebView(context) {
            @Override public InputConnection onCreateInputConnection(EditorInfo out) {
                InputConnection base = super.onCreateInputConnection(out);
                if (base == null) return null;
                out.contentMimeTypes = PastedPicture.withImages(out.contentMimeTypes);
                ContentResolver resolver = context.getContentResolver();
                return new InputConnectionWrapper(base, false) {
                    @Override public boolean commitContent(InputContentInfo info, int flags, Bundle options) {
                        if (!isImage(info.getDescription()) || !"content".equals(info.getContentUri().getScheme()))
                            return super.commitContent(info, flags, options);
                        if ((flags & InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
                            try { info.requestPermission(); } catch (RuntimeException refused) { return false; }
                        }
                        new Thread(() -> deliver(resolver, info, sink), "keyboard-picture").start();
                        return true;
                    }
                };
            }
        };
    }

    private static void deliver(ContentResolver resolver, InputContentInfo info, Sink sink) {
        try {
            Uri uri = info.getContentUri();
            String mime = mime(resolver, uri, info.getDescription());
            byte[] bytes = read(resolver, uri);
            if (bytes == null) return;
            sink.picture(PastedPicture.fileName(displayName(resolver, uri), mime, System.currentTimeMillis()), mime, Base64.encodeToString(bytes, Base64.NO_WRAP));
        } catch (IOException | RuntimeException failed) {
            // the keyboard's content went away or was too big: nothing lands, as before
        } finally {
            try { info.releasePermission(); } catch (RuntimeException ignored) { /* no grant was asked for */ }
        }
    }

    private static boolean isImage(ClipDescription description) {
        for (int i = 0; i < description.getMimeTypeCount(); i++) if (PastedPicture.isImage(description.getMimeType(i))) return true;
        return false;
    }

    private static String mime(ContentResolver resolver, Uri uri, ClipDescription description) {
        String type = resolver.getType(uri);
        if (PastedPicture.isImage(type)) return type.toLowerCase(Locale.ROOT);
        for (int i = 0; i < description.getMimeTypeCount(); i++) if (PastedPicture.isImage(description.getMimeType(i))) return description.getMimeType(i).toLowerCase(Locale.ROOT);
        return "image/png";
    }

    private static byte[] read(ContentResolver resolver, Uri uri) throws IOException {
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) {
                if (out.size() + n > MAX_BYTES) return null;
                out.write(buffer, 0, n);
            }
            return out.size() == 0 ? null : out.toByteArray();
        }
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (RuntimeException ignored) { /* a keyboard's provider may not answer queries */ }
        return null;
    }
}
