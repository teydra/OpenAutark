// Owns: the plain rules for a picture the keyboard hands over (KeyboardContent): the field's types with image/* added,
// what counts as an image type, and the file name the page gets. Pure Java, so the host tests run it.
// Never: Android classes.
package com.teydralab.autark.android;

import java.util.Locale;

final class PastedPicture {
    private PastedPicture() {}

    /** The field's own types with image/* added once. */
    static String[] withImages(String[] own) {
        if (own == null || own.length == 0) return new String[] { "image/*" };
        for (String type : own) if ("image/*".equals(type)) return own;
        String[] out = new String[own.length + 1];
        System.arraycopy(own, 0, out, 0, own.length);
        out[own.length] = "image/*";
        return out;
    }

    /** An image type with its subtype (image/png, image/gif …), not a pattern. */
    static boolean isImage(String mime) {
        return mime != null && mime.toLowerCase(Locale.ROOT).startsWith("image/") && !mime.contains("*");
    }

    /** The name the page gets: the provider's, without a path, else "pasted-<time>.<ext>" from the type. */
    static String fileName(String display, String mime, long now) {
        String name = display == null ? "" : display.replaceAll(".*[/\\\\]", "").replaceAll("[\\x00-\\x1f]", "").trim();
        if (name.length() > 120) name = name.substring(name.length() - 120);
        if (!name.isEmpty() && name.contains(".")) return name;
        String extension = mime.substring(mime.indexOf('/') + 1).replaceAll("\\+.*", "").replaceAll("[^a-z0-9]", "");
        if (extension.equals("jpeg")) extension = "jpg";
        return (name.isEmpty() ? "pasted-" + now : name) + "." + (extension.isEmpty() ? "png" : extension);
    }
}
