// Owns: the files the phone's camera app writes for a capture the page asked for (16.11.2026, F23: <input capture>,
// PhoneChrome) or the bubble's plus menu asked for (phoneuse/BubblePick, its photo) – one new file per capture in cache/capture/, handed to the camera app as content://<package>.capture/<name>
// with a one-time write grant (the app has no AndroidX FileProvider), read back by the WebView for the upload. Files
// older than KEEP_MS go at the next capture. Never: exported, a name with a path in it, or any file outside cache/capture/.
package com.teydralab.autark.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

public final class CaptureFiles extends ContentProvider {
    /** A capture the page has not uploaded within this long is gone (an upload reads it within minutes). */
    private static final long KEEP_MS = 24 * 60 * 60_000L;

    /** A new empty file for one capture ("jpg" or "mp4") and its address for the camera app. */
    public static Uri create(Context context, String extension) throws IOException {
        File dir = dir(context);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no capture folder");
        File[] old = dir.listFiles();
        long now = System.currentTimeMillis();
        if (old != null) for (File file : old) if (now - file.lastModified() > KEEP_MS) file.delete();
        File file = new File(dir, "capture-" + now + "." + extension);
        if (!file.createNewFile()) throw new IOException("capture file exists");
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".capture").appendPath(file.getName()).build();
    }

    /** The bytes the camera app wrote under `uri` (0: nothing, the capture was cancelled or went elsewhere). */
    static long size(Context context, Uri uri) {
        File file = file(context, uri);
        return file == null ? 0 : file.length();
    }

    /** The file behind one of my addresses (the bubble's photo reads what the camera app wrote), or null. */
    public static File fileOf(Context context, Uri uri) { return file(context, uri); }

    private static File dir(Context context) { return new File(context.getCacheDir(), "capture"); }

    /** The file behind one of my addresses, or null for anything else. */
    private static File file(Context context, Uri uri) {
        if (context == null || uri == null || !(context.getPackageName() + ".capture").equals(uri.getAuthority())) return null;
        String name = uri.getLastPathSegment();
        if (name == null || uri.getPathSegments().size() != 1 || !name.matches("capture-\\d+\\.(jpg|mp4)")) return null;
        return new File(dir(context), name);
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = file(getContext(), uri);
        if (file == null || !file.exists()) throw new FileNotFoundException("not a capture");
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode));
    }

    @Override public String getType(Uri uri) {
        File file = file(getContext(), uri);
        return file == null ? null : file.getName().endsWith(".mp4") ? "video/mp4" : "image/jpeg";
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        File file = file(getContext(), uri);
        if (file == null) return null;
        String[] columns = projection == null ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE } : projection;
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = file.getName();
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
        }
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        cursor.addRow(row);
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
