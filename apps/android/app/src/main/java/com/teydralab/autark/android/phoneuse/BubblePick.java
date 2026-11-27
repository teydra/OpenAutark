// Owns: the bubble's way to the camera app and to the phone's file picker (owner 24.11.2026, task_r0y9wcex: "ein Foto
// aufnehmen kann, also in die Kamera-App kommt" – "Dateien vom Handy anhängen"). The bubble is an accessibility overlay
// and cannot wait for an activity's result, so this invisible activity (one pixel like BubbleTyping, so phone use reads
// the app under it; a task of its own, not in Recents) starts the camera app (ACTION_IMAGE_CAPTURE into a CaptureFiles
// file; the camera right is asked first, as Android refuses the capture to an app that declares it without having it)
// or Android's document picker (ACTION_OPEN_DOCUMENT, any type, several at once), and copies what came back into the
// app's cache (cache/bubble/) while the read grant still holds – a photo turned upright and at most PHOTO_PX on its
// longest side (JPEG 85), a file as it is, at most TodoPost.FILE_MAX_BYTES. Done hears once on the main thread: the
// files with a small picture for images, and one line for the person when something did not come (null when the person
// just went back). Files left in cache/bubble/ longer than KEEP_MS go at the next pick.
// Never: shows anything itself, reads a file the person did not pick, or keeps a picked file outside cache/bubble/.
package com.teydralab.autark.android.phoneuse;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.PixelFormat;
import android.graphics.drawable.ColorDrawable;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.Window;
import android.view.WindowManager;
import com.teydralab.autark.android.CaptureFiles;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public final class BubblePick extends Activity {
    /** What came back (main thread, once). */
    interface Done { void picked(List<Got> files, String problem); }

    /** One picked file in cache/bubble/: its kind (TodoPost.Item), the name it had, its type and size, a small picture or null. */
    static final class Got {
        final String kind;
        final File file;
        final String name;
        final String mime;
        final long bytes;
        final Bitmap thumb;
        Got(String kind, File file, String name, String mime, Bitmap thumb) {
            this.kind = kind;
            this.file = file;
            this.name = name;
            this.mime = mime;
            this.bytes = file.length();
            this.thumb = thumb;
        }
    }

    /** A photo's longest side (enough for an agent to read a sign or a screen, a tenth of a camera's file). */
    private static final int PHOTO_PX = 2048;
    private static final long KEEP_MS = 3L * 24 * 60 * 60_000;
    private static final int CAMERA = 61, FILES = 62, ASK = 63;
    private static Done waiting;
    private static boolean wantPhoto;
    private static int thumbPx = 96;
    private boolean german; // set in onCreate: the profile language, read once the activity has its context
    private final Handler main = new Handler(Looper.getMainLooper());
    private Done done;
    private boolean photo;
    private File captured;

    /** The camera app; the photo comes back to `to`. `thumb`: the small picture's height in px. */
    static void photo(Context context, int thumb, Done to) { start(context, thumb, to, true); }

    /** The phone's file picker; the files come back to `to`. */
    static void files(Context context, int thumb, Done to) { start(context, thumb, to, false); }

    private static void start(Context context, int thumb, Done to, boolean photo) {
        waiting = to;
        wantPhoto = photo;
        thumbPx = Math.max(16, thumb);
        Intent intent = new Intent(context, BubblePick.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        try { context.startActivity(intent); }
        catch (RuntimeException failed) {
            waiting = null;
            boolean de = UiLang.german(context);
            to.picked(Collections.emptyList(), de ? "Die Auswahl ging nicht auf." : "The picker did not open.");
        }
    }

    /** A new file in cache/bubble/ (`prefix-<time>.<extension>`); older files there go first. */
    static File newFile(Context context, String prefix, String extension) throws IOException {
        File dir = new File(context.getCacheDir(), "bubble");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no bubble folder");
        long now = System.currentTimeMillis();
        File[] old = dir.listFiles();
        if (old != null) for (File file : old) if (now - file.lastModified() > KEEP_MS) file.delete();
        for (int i = 0; ; i++) {
            File file = new File(dir, prefix + "-" + now + (i == 0 ? "" : "-" + i) + "." + extension);
            if (file.createNewFile()) return file;
            if (i > 100) throw new IOException("no free name");
        }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        german = UiLang.german(this);
        done = waiting;
        waiting = null;
        photo = wantPhoto;
        if (done == null) { finish(); return; } // recreated by Android without a bubble asking
        overridePendingTransition(0, 0);
        Window window = getWindow();
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.setFormat(PixelFormat.TRANSLUCENT);
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
        WindowManager.LayoutParams at = window.getAttributes();
        at.width = BubbleTyping.SIZE; // phone use takes a window this small for the bubble's own (UseService.front)
        at.height = BubbleTyping.SIZE;
        at.gravity = Gravity.TOP | Gravity.START;
        window.setAttributes(at);
        if (!photo) openFiles();
        else if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[] { Manifest.permission.CAMERA }, ASK);
        else openCamera();
    }

    private void openCamera() {
        try {
            Uri out = CaptureFiles.create(this, "jpg");
            captured = CaptureFiles.fileOf(this, out);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    .putExtra(MediaStore.EXTRA_OUTPUT, out)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("capture", out)); // the grant covers EXTRA_OUTPUT on every Android version
            startActivityForResult(intent, CAMERA);
        } catch (IOException | ActivityNotFoundException | SecurityException error) {
            end(Collections.emptyList(), german ? "Keine Kamera-App ging auf." : "No camera app opened.");
        }
    }

    private void openFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(intent, FILES); }
        catch (ActivityNotFoundException | SecurityException error) {
            end(Collections.emptyList(), german ? "Auf diesem Handy gibt es keine Dateiauswahl." : "No file picker is installed.");
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != ASK) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) openCamera();
        else end(Collections.emptyList(), german ? "Kamera nicht freigegeben – erlaube sie Autark in den Einstellungen des Handys." : "Camera not allowed – allow it for Autark in the phone's settings.");
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        if (code != CAMERA && code != FILES) return;
        if (result != Activity.RESULT_OK) { if (captured != null) captured.delete(); end(Collections.emptyList(), null); return; } // back: nothing, no line
        List<Uri> picked = new ArrayList<>();
        if (code == FILES && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) add(picked, clip.getItemAt(i).getUri());
            add(picked, data.getData());
        }
        File shot = captured;
        captured = null;
        Context app = getApplicationContext();
        Thread copy = new Thread(() -> {
            List<Got> got = new ArrayList<>();
            String[] problem = new String[1];
            if (code == CAMERA) {
                Got one = photoFrom(app, shot);
                if (one != null) got.add(one);
                else problem[0] = german ? "Die Kamera-App hat kein Foto gegeben." : "The camera app gave no photo.";
            } else {
                for (Uri uri : picked) {
                    if (got.size() >= TodoPost.FILES_MAX) break;
                    Got one = copy(app, uri, problem);
                    if (one != null) got.add(one);
                }
                if (got.isEmpty() && problem[0] == null) problem[0] = german ? "Keine Datei kam an." : "No file came through.";
            }
            main.post(() -> end(got, problem[0]));
        }, "autark-bubble-pick");
        copy.setDaemon(true);
        copy.start();
    }

    private static void add(List<Uri> into, Uri uri) {
        if (uri != null && "content".equals(uri.getScheme()) && !into.contains(uri)) into.add(uri);
    }

    /** The camera's file upright and at most PHOTO_PX, as JPEG 85 in cache/bubble/; the camera's own file goes. Null: nothing usable. */
    private static Got photoFrom(Context context, File shot) {
        if (shot == null || shot.length() == 0) { if (shot != null) shot.delete(); return null; }
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(shot.getPath(), bounds);
            int longest = Math.max(bounds.outWidth, bounds.outHeight);
            if (longest <= 0) return null;
            BitmapFactory.Options read = new BitmapFactory.Options();
            read.inSampleSize = 1;
            while (longest / (read.inSampleSize * 2) >= PHOTO_PX) read.inSampleSize *= 2;
            Bitmap bitmap = BitmapFactory.decodeFile(shot.getPath(), read);
            if (bitmap == null) return null;
            Matrix turn = new Matrix();
            int orientation = new ExifInterface(shot.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            if (orientation == ExifInterface.ORIENTATION_ROTATE_90) turn.postRotate(90);
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_180) turn.postRotate(180);
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_270) turn.postRotate(270);
            float scale = Math.min(1f, PHOTO_PX / (float) Math.max(bitmap.getWidth(), bitmap.getHeight()));
            if (scale < 1f) turn.postScale(scale, scale);
            Bitmap upright = turn.isIdentity() ? bitmap : Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), turn, true);
            File file = newFile(context, "photo", "jpg");
            try (OutputStream out = new FileOutputStream(file)) {
                if (!upright.compress(Bitmap.CompressFormat.JPEG, 85, out)) { file.delete(); return null; }
            }
            return new Got(TodoPost.Item.PHOTO, file, null, "image/jpeg", thumb(upright));
        } catch (IOException | RuntimeException failed) {
            return null;
        } finally {
            shot.delete();
        }
    }

    /** One picked file copied into cache/bubble/ (at most TodoPost.FILE_MAX_BYTES); null and a line in problem[0] when not. */
    private Got copy(Context context, Uri uri, String[] problem) {
        String name = null;
        long size = -1;
        try (Cursor row = context.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (row != null && row.moveToFirst()) {
                if (!row.isNull(0)) name = row.getString(0);
                if (!row.isNull(1)) size = row.getLong(1);
            }
        } catch (RuntimeException unreadable) { /* the name stays unknown */ }
        String shown = name == null ? (german ? "Eine Datei" : "A file") : name;
        String tooBig = german ? shown + " ist größer als 50 MB." : shown + " is larger than 50 MB.";
        if (size > TodoPost.FILE_MAX_BYTES) { problem[0] = tooBig; return null; }
        String mime = context.getContentResolver().getType(uri);
        File file = null;
        try {
            file = newFile(context, "file", "bin");
            long copied = 0;
            try (InputStream in = context.getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(file)) {
                if (in == null) throw new IOException("no stream");
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) {
                    copied += n;
                    if (copied > TodoPost.FILE_MAX_BYTES) { file.delete(); problem[0] = tooBig; return null; }
                    out.write(buffer, 0, n);
                }
            }
            Bitmap thumb = null;
            if (mime != null && mime.startsWith("image/")) thumb = imageThumb(file);
            return new Got(TodoPost.Item.FILE, file, name, mime, thumb);
        } catch (IOException | RuntimeException failed) {
            if (file != null) file.delete();
            problem[0] = german ? shown + " ließ sich nicht lesen." : shown + " could not be read.";
            return null;
        }
    }

    private static Bitmap imageThumb(File file) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        if (bounds.outHeight <= 0) return null;
        BitmapFactory.Options read = new BitmapFactory.Options();
        read.inSampleSize = 1;
        while (bounds.outHeight / (read.inSampleSize * 2) >= thumbPx) read.inSampleSize *= 2;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getPath(), read);
        return bitmap == null ? null : thumb(bitmap);
    }

    private static Bitmap thumb(Bitmap image) {
        int height = thumbPx;
        int width = Math.max(1, Math.round(image.getWidth() * height / (float) image.getHeight()));
        return Bitmap.createScaledBitmap(image, width, height, true);
    }

    /** Hands the result over once and goes. */
    private void end(List<Got> files, String problem) {
        Done to = done;
        done = null;
        if (!isFinishing()) finish();
        if (to != null) to.picked(files, problem);
    }

    @Override public void finish() {
        super.finish();
        overridePendingTransition(0, 0);
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (captured != null) captured.delete();
        Done to = done;
        done = null;
        if (to != null) to.picked(Collections.emptyList(), null); // Android closed it before a result: the bubble just comes back
    }
}
