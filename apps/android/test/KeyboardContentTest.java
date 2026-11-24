// Owns: FCMWSZNH (a picture from the keyboard's clipboard row): PastedPicture's rules run here, and the wiring is read
// from the sources – the app's WebView is KeyboardContent's, which names image/* and takes commitContent off the main
// thread with the keyboard's grant released, and the picture reaches the page as 'paste'.
// Never: a device test (Gboard and the Samsung keyboard are checked on the phone).
package com.teydralab.autark.android;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public final class KeyboardContentTest {
    private static int assertions;

    public static void main(String[] args) throws Exception {
        equal("image/*", String.join(",", PastedPicture.withImages(null)));
        equal("text/plain,image/*", String.join(",", PastedPicture.withImages(new String[] { "text/plain" })));
        equal("image/*", String.join(",", PastedPicture.withImages(new String[] { "image/*" })));
        check(PastedPicture.isImage("image/png") && PastedPicture.isImage("IMAGE/GIF"), "image types count");
        check(!PastedPicture.isImage("image/*") && !PastedPicture.isImage("video/mp4") && !PastedPicture.isImage(null), "patterns and other types do not");
        equal("Screenshot.png", PastedPicture.fileName("Screenshot.png", "image/png", 7));
        equal("clip.jpg", PastedPicture.fileName("/storage/../clip.jpg", "image/jpeg", 7));
        equal("pasted-7.jpg", PastedPicture.fileName(null, "image/jpeg", 7));
        equal("pasted-7.svg", PastedPicture.fileName("", "image/svg+xml", 7));
        equal("sticker.webp", PastedPicture.fileName("sticker", "image/webp", 7));

        String keyboard = source("KeyboardContent.java");
        check(keyboard.contains("out.contentMimeTypes = PastedPicture.withImages(out.contentMimeTypes)"), "the field names image/* to the keyboard");
        check(keyboard.contains("public boolean commitContent(") && keyboard.contains("info.requestPermission()"), "commitContent asks for the keyboard's grant");
        check(keyboard.contains("new Thread(() -> deliver(") && keyboard.contains("info.releasePermission()"), "the picture is read off the main thread and the grant released");
        check(keyboard.contains("MAX_BYTES"), "an oversized picture is dropped");
        check(source("PhoneWeb.java").contains("KeyboardContent.webView(activity, pictures)"), "the app's WebView is KeyboardContent's");
        check(source("MainActivity.java").contains("port.paste(name, mime, data)"), "the picture goes to the page");
        check(source("NativePort.java").contains(".put(\"t\", \"paste\")"), "as a 'paste' message");
        System.out.println(assertions + " keyboard picture assertions passed.");
    }

    private static String source(String name) throws Exception {
        return new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/src/main/java/com/teydralab/autark/android", name)), StandardCharsets.UTF_8);
    }

    private static void equal(String expected, String actual) {
        assertions++;
        if (!expected.equals(actual)) throw new AssertionError("expected " + expected + " but got " + actual);
    }

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }
}
