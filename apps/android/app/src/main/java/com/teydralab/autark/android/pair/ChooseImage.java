// Owns: the fixed bar under the scanner with one button, "Choose QR image" (26.11.2026, Stanislaus: no photo strip): it opens the
// system's own image chooser (ACTION_GET_CONTENT, request 46 – no photo permission, nothing is listed by the app), reads the
// chosen picture (long side <= 1600 px) through QrDecode on its one background thread and hands the QR text on. Never: asks for a
// permission, lists, uploads or keeps a picture.
package com.teydralab.autark.android.pair;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.InputStream;
import java.util.function.Consumer;

final class ChooseImage extends FrameLayout {
    static final int PICK_REQUEST = 46;
    private final Activity activity;
    private final Consumer<String> picked;
    private HandlerThread thread;
    private Handler worker;
    private int generation;

    /** picked runs on the UI thread with the QR text of the chosen picture, or null when the picture has none. */
    ChooseImage(Activity activity, PairLook look, Consumer<String> picked) {
        super(activity);
        this.activity = activity;
        this.picked = picked;
        setBackgroundColor(PairLook.CAMERA);
        TextView button = look.text("Choose QR image", 16, 0xFFFFFFFF, true);
        button.setGravity(Gravity.CENTER);
        button.setBackground(look.round(0xFF1E2522, 14, 0));
        button.setForeground(look.touch(null, 0x40FFFFFF));
        button.setOnClickListener(clicked -> choose());
        LayoutParams at = new LayoutParams(-1, look.dp(48), Gravity.CENTER);
        at.setMargins(look.dp(16), look.dp(12), look.dp(16), look.dp(12));
        addView(button, at);
    }

    static int height(PairLook look) { return look.dp(72); }

    void start() {
        if (thread == null) { thread = new HandlerThread("autark-qr-image"); thread.start(); worker = new Handler(thread.getLooper()); }
    }

    void stop() {
        generation++;
        if (thread != null) { thread.quitSafely(); thread = null; worker = null; }
    }

    /** The chooser's answer (request 46): read the chosen picture. */
    void result(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null || worker == null) return;
        read(data.getData());
    }

    private void choose() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
        try { activity.startActivityForResult(intent, PICK_REQUEST); }
        catch (ActivityNotFoundException none) { picked.accept(null); }
    }

    /** On the worker: the picture at most 1600 px on its long side, its QR text to picked (UI thread). */
    private void read(Uri uri) {
        Handler handler = worker;
        if (handler == null) return;
        int run = generation;
        handler.post(() -> {
            String text = null;
            try {
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                try (InputStream in = activity.getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
                int side = Math.max(bounds.outWidth, bounds.outHeight), sample = 1;
                while (side / (sample * 2) >= 1600) sample *= 2;
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inSampleSize = sample;
                Bitmap bitmap;
                try (InputStream in = activity.getContentResolver().openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(in, null, options); }
                if (bitmap != null) {
                    int longSide = Math.max(bitmap.getWidth(), bitmap.getHeight());
                    if (longSide > 1600) {
                        Bitmap smaller = Bitmap.createScaledBitmap(bitmap, bitmap.getWidth() * 1600 / longSide, bitmap.getHeight() * 1600 / longSide, true);
                        if (smaller != bitmap) bitmap.recycle();
                        bitmap = smaller;
                    }
                    int w = bitmap.getWidth(), h = bitmap.getHeight();
                    int[] px = new int[w * h];
                    bitmap.getPixels(px, 0, w, 0, 0, w, h);
                    bitmap.recycle();
                    text = QrDecode.fromArgb(px, w, h);
                }
            } catch (Exception | OutOfMemoryError unreadable) { text = null; }
            String found = text;
            post(() -> { if (run == generation) picked.accept(found); });
        });
    }
}
