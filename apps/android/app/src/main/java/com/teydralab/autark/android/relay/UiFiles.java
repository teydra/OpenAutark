// Owns: the app's own interface on the company's origin (owner 27.11.2026: the phone carries its interface, nothing of
// it comes from a PC) – which requests are the interface's (a GET or HEAD outside the PC's data paths, DATA) and their
// answer from the APK's copy of apps/desktop/app/ui (assets/ui, build.ps1), at once and without a channel: the type by
// extension (the table of shared/files/mime.ts), the page's content security policy on HTML (APP_CSP of
// runtime/http/static.ts), no-cache for the shell and immutable for esbuild's content-hashed files, index.html for a
// navigation path without an extension, 404 for any other missing file. /sw.js is the one piece for what an older
// version left on the phone: the PC-served page registered a service worker that keeps answering its cached interface;
// this one deletes every cache, unregisters itself and loads the open pages once more (only when it found a cache).
// It goes in the release after 0.3.22 – by then every phone has run it once. A document request tells the source that a
// page starts (UiUpdate then gives that page the newest ready interface list; the running page keeps its own).
// Never: reads outside its source (no dotfiles, no '..'), answers a data path, or waits for a PC.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

public final class UiFiles {
    /** The interface's files by path below it ("index.html", "chunks/x-ABCDEFGH.js"); null when there is no such file. */
    public interface Source {
        byte[] read(String path) throws IOException;
        /** A page starts (a document request): UiUpdate gives it the newest ready list from here on. */
        default void pageStarts() {}
    }

    /** First path segments that are the PC's (runtime/http/server.ts and static.ts's /turn/): they go through a channel. */
    static final Pattern DATA = Pattern.compile("^/(?:ws|rpc|events|mcp|files|sandbox|turn|peer|\\.well-known)(?:/|$)");
    /** The page's policy, as the PC sent it for index.html (runtime/http/static.ts APP_CSP). */
    static final String APP_CSP = String.join("; ",
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "connect-src 'self' ws: wss: blob: https://firestore.googleapis.com",
            "frame-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'none'");
    /** esbuild content hashes: chunks/name-ABCDEFGH.js, font-ABCDEFGH.woff2. */
    private static final Pattern HASHED = Pattern.compile("-[A-Z0-9]{8}\\.[a-z0-9]+$");
    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        String[] pairs = { "html", "text/html; charset=utf-8", "js", "text/javascript; charset=utf-8", "mjs", "text/javascript; charset=utf-8",
                "css", "text/css; charset=utf-8", "json", "application/json; charset=utf-8", "webmanifest", "application/manifest+json",
                "svg", "image/svg+xml", "png", "image/png", "jpg", "image/jpeg", "jpeg", "image/jpeg", "webp", "image/webp",
                "gif", "image/gif", "ico", "image/x-icon", "woff2", "font/woff2", "woff", "font/woff", "ttf", "font/ttf",
                "map", "application/json; charset=utf-8", "txt", "text/plain; charset=utf-8", "wasm", "application/wasm",
                "mp3", "audio/mpeg", "wav", "audio/wav" };
        for (int i = 0; i < pairs.length; i += 2) TYPES.put(pairs[i], pairs[i + 1]);
    }
    /** Ends the PC-served page's service worker on a phone that still has it (see the header). */
    static final String RETIRE_WORKER = String.join("\n",
            "// Autark for Android: the interface is in the app now; this ends the service worker an older version left here.",
            "self.addEventListener('install', () => self.skipWaiting());",
            "self.addEventListener('activate', (event) => event.waitUntil((async () => {",
            "  await self.clients.claim();",
            "  const names = await caches.keys();",
            "  await Promise.all(names.map((name) => caches.delete(name)));",
            "  await self.registration.unregister();",
            "  if (names.length) for (const page of await self.clients.matchAll({ type: 'window' })) page.navigate(page.url);",
            "})()));",
            "");

    private final Source source;

    public UiFiles(Source source) { this.source = source; }

    /** True when `head` (a request head) is the interface's: GET or HEAD, no socket, outside the data paths. */
    static boolean ours(String head) {
        String[] line = head.substring(0, Math.max(0, head.indexOf("\r\n"))).split(" ");
        if (line.length != 3 || !(line[0].equals("GET") || line[0].equals("HEAD")) || StreamProxy.upgrade(head)) return false;
        return !DATA.matcher(path(line[1])).find();
    }

    /** Answers the interface request `head` on `out` (Connection: close – each request of the interface is its own). */
    void answer(String head, OutputStream out) throws IOException {
        String[] line = head.substring(0, head.indexOf("\r\n")).split(" ");
        String path = path(line[1]);
        String file = path.equals("/") ? "index.html" : path.startsWith("/") ? path.substring(1) : "";
        // A page starts with its document request (Sec-Fetch-Dest: document; without that header, a request for the shell).
        String dest = header(head, "sec-fetch-dest");
        if (dest == null ? file.equals("index.html") : dest.equalsIgnoreCase("document")) source.pageStarts();
        byte[] body = file.equals("sw.js") ? RETIRE_WORKER.getBytes(StandardCharsets.UTF_8) : safe(file) ? source.read(file) : null;
        if (body == null && safe(file) && !file.substring(file.lastIndexOf('/') + 1).contains(".")) {
            if (dest == null) source.pageStarts();
            file = "index.html";
            body = source.read(file);
        }
        StringBuilder reply = new StringBuilder();
        if (body == null) {
            body = "Not found.".getBytes(StandardCharsets.UTF_8);
            reply.append("HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n");
        } else {
            reply.append("HTTP/1.1 200 OK\r\nContent-Type: ").append(type(file)).append("\r\nCache-Control: ").append(cacheControl(file)).append("\r\n");
            if (file.endsWith(".html")) reply.append("Content-Security-Policy: ").append(APP_CSP).append("\r\n");
        }
        reply.append("X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Length: ").append(body.length).append("\r\nConnection: close\r\n\r\n");
        out.write(reply.toString().getBytes(StandardCharsets.US_ASCII));
        if (line[0].equals("GET")) out.write(body);
        out.flush();
    }

    /** The value of header `name` (lower case) in a request head, or null. */
    static String header(String head, String name) {
        for (String line : head.split("\r\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && line.substring(0, colon).trim().toLowerCase(Locale.ROOT).equals(name)) return line.substring(colon + 1).trim();
        }
        return null;
    }

    /** The decoded path of a request target, without query or fragment; "" when it cannot be decoded. */
    static String path(String target) {
        int end = target.length();
        for (char stop : new char[] { '?', '#' }) { int at = target.indexOf(stop); if (at >= 0) end = Math.min(end, at); }
        try { return URLDecoder.decode(target.substring(0, end).replace("+", "%2B"), "UTF-8"); }
        catch (IllegalArgumentException | java.io.UnsupportedEncodingException error) { return ""; }
    }

    /** A file path below the interface: no empty, dot-led ('..', dotfiles) or backslashed segment. */
    static boolean safe(String file) {
        if (file.isEmpty() || file.indexOf('\0') >= 0 || file.indexOf('\\') >= 0) return false;
        for (String segment : file.split("/", -1)) if (segment.isEmpty() || segment.startsWith(".")) return false;
        return true;
    }

    static String type(String file) {
        int dot = file.lastIndexOf('.');
        String type = dot < 0 ? null : TYPES.get(file.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    /** runtime/http/static.ts cacheControlFor: shell files revalidate every time, content-hashed ones never change. */
    static String cacheControl(String file) {
        if (file.equals("index.html") || file.equals("sw.js")) return "no-cache";
        return file.startsWith("chunks/") || HASHED.matcher(file).find() ? "public, max-age=31536000, immutable" : "no-cache";
    }
}
