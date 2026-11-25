#!/usr/bin/env python3
"""CI proof of the Autark runner (Punkt 17) in the iOS Simulator: drives the real runner through every operation of protocol v1
with the reference client (runner-probe.py, beside this file) and writes what came back.

  runner-proof.py --port 51873 --token <64 hex> --out DIR [--sim-udid UDID]

Settings opens, its tree is read, "General" is tapped, the page is swiped up, the way back is a tap on the back button, text goes
into Settings' search field, home, a link opens, every error code the Simulator can show, busy, a second connection replacing the
first, end, and the port closing. Which app is in front is checked after open, home and a link; the runner's name on the home
screen ("Autark Control"). With --sim-udid (macOS host with the Simulator app): the Simulator is locked (Cmd-L by UI scripting),
state.locked and the `locked` refusals are checked against the Simulator's own lock state (notifyutil), the home button on the
lock screen, the unlock (Cmd-Shift-H), and the notification center pulled down while unlocked (must not count as locked). Each answer lands in DIR as NN-<name>.json, pictures as NN-<name>.png/.jpg; DIR/summary.json and
the printed table list the checks. Exit code 0 when every required check passed. Python standard library only; the token is
never printed.
"""
import argparse, importlib.util, json, os, secrets, socket, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("runner_probe", os.path.join(HERE, "runner-probe.py"))
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

APPS = ["com.apple.Preferences", "com.apple.mobilesafari", "com.apple.Maps", "com.apple.mobileslideshow"]
SPRINGBOARD = "com.apple.springboard"
RUNNER_NAME = "Autark Control"


class Proof:
    def __init__(self, host, port, token, out, udid=None):
        self.host, self.port, self.token, self.out = host, port, token, out
        self.udid = udid
        self.caps = []
        self.number = 0
        self.checks = []
        self.client = None
        self.screen = None
        os.makedirs(out, exist_ok=True)

    # ---- bookkeeping

    def check(self, name, ok, detail="", required=True):
        self.checks.append({"name": name, "ok": bool(ok), "required": required, "detail": detail})
        print("%-4s %s%s" % ("ok" if ok else ("FAIL" if required else "no"), name, (" – " + detail) if detail else ""), flush=True)
        return bool(ok)

    def save(self, name, request, answer, binary=b"", ms=0):
        self.number += 1
        base = os.path.join(self.out, "%02d-%s" % (self.number, name))
        with open(base + ".json", "w", encoding="utf-8") as handle:
            json.dump({"request": request, "ms": ms, "answer": answer, "binBytes": len(binary)}, handle, ensure_ascii=False, indent=1)
        if binary:
            ext = {"png": "png", "jpeg": "jpg"}.get(answer.get("format"), "bin")
            with open(base + "." + ext, "wb") as handle:
                handle.write(binary)
        return base

    def connect(self, apps=None, wait=90):
        deadline = time.time() + wait
        last = None
        while True:
            try:
                client = probe.Client(self.host, self.port, self.token)
                client.handshake(apps=apps)
                return client
            except (OSError, probe.ProtocolError, ValueError, KeyError) as error:
                last = error
                if time.time() >= deadline:
                    raise probe.ProtocolError("no runner after %d s: %s" % (wait, last))
                time.sleep(1.0)

    def call(self, name, op, /, **fields):
        started = time.time()
        try:
            request, answer, binary = self.client.call(op, **fields)
        except (OSError, probe.ProtocolError, ValueError) as error:
            print("     connection lost during %s: %s – reconnecting" % (name, error), flush=True)
            self.client.close()
            self.client = self.connect(apps=APPS, wait=30)
            request, answer, binary = self.client.call(op, **fields)
        ms = int((time.time() - started) * 1000)
        self.save(name, request, answer, binary, ms)
        if not answer.get("ok"):
            print("     %s answered %s" % (name, json.dumps(answer.get("error"))), flush=True)
        return answer, binary, ms

    # ---- tree helpers

    @staticmethod
    def find(nodes, label=None, types=None, parent_type=None, contains=None):
        by_index = {n["i"]: n for n in nodes}
        hits = []
        for node in nodes:
            if label is not None and node.get("label") != label:
                continue
            if contains is not None and contains not in (node.get("label", "") + " " + node.get("value", "")):
                continue
            if types is not None and node.get("type") not in types:
                continue
            if parent_type is not None and by_index.get(node.get("p"), {}).get("type") != parent_type:
                continue
            if "frame" not in node:
                continue
            hits.append(node)
        return hits

    @staticmethod
    def center(node):
        x, y, w, h = node["frame"]
        return round(x + w / 2, 1), round(y + h / 2, 1)

    @staticmethod
    def front_of(answer):
        return (answer.get("front") or {}).get("bundle")

    # ---- the Simulator from outside (macOS host only)

    def run(self, args, timeout=30):
        try:
            done = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
            return done.returncode, (done.stdout + done.stderr).strip()
        except (OSError, subprocess.SubprocessError) as error:
            return -1, str(error)

    def truth(self):
        """The Simulator's own lock state (SpringBoard's Darwin notification read inside the Simulator): 1 locked, 0 not, None unknown."""
        rc, out = self.run(["xcrun", "simctl", "spawn", self.udid, "notifyutil", "-g", "com.apple.springboard.lockstate"])
        try:
            return int(out.split()[-1]) if rc == 0 else None
        except (ValueError, IndexError):
            return None

    def sim_shot(self, name):
        path = os.path.join(self.out, "%02d-sim-%s.png" % (self.number, name))
        rc, out = self.run(["xcrun", "simctl", "io", self.udid, "screenshot", path])
        if rc != 0:
            print("     simctl screenshot failed: %s" % out, flush=True)

    def keys(self, key, modifiers):
        rc, out = self.run(["osascript", "-e", 'tell application "Simulator" to activate', "-e", "delay 1",
                            "-e", 'tell application "System Events" to keystroke "%s" using {%s}' % (key, modifiers)])
        if rc != 0:
            print("     UI scripting refused: %s" % out, flush=True)
        return rc == 0

    def sim_lock(self):
        return self.keys("l", "command down")

    def sim_home(self):
        return self.keys("h", "command down, shift down")

    # ---- the walk

    def raw_session(self):
        sock = socket.create_connection((self.host, self.port), timeout=5)
        sock.settimeout(5)
        return sock

    def negatives_before_auth(self):
        # A stray HTTP client is closed without an answer.
        sock = self.raw_session()
        sock.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        try:
            got = sock.recv(64)
        except OSError:
            got = b""
        sock.close()
        self.check("stray HTTP client is closed without a byte", got == b"", "got %d bytes" % len(got))
        # An operation before auth: unauthorized, connection closed.
        sock = self.raw_session()
        sock.sendall(probe.PREAMBLE)
        pre = probe.read_exact(sock, 8)
        probe.write_frame(sock, {"id": 1, "op": "state"})
        answer, _ = probe.read_frame(sock, probe.RES_JSON_MAX, probe.RES_BIN_MAX)
        try:
            closed = sock.recv(1) == b""
        except OSError:
            closed = True
        sock.close()
        self.save("before-auth", {"id": 1, "op": "state"}, answer)
        self.check("preamble answered with the same 8 bytes", pre == probe.PREAMBLE)
        self.check("an operation before auth answers unauthorized and closes", answer.get("error", {}).get("code") == "unauthorized" and closed)
        # A client with a wrong token: the runner's proof does not verify, nothing is sent after hello.
        try:
            probe.Client(self.host, self.port, secrets.token_bytes(32).hex()).handshake()
            self.check("a client with another token refuses the runner's proof", False)
        except probe.ProtocolError as error:
            self.check("a client with another token refuses the runner's proof", "proof is wrong" in str(error))
        # A wrong PC proof: auth_failed, closed (1 of the 5 the runner tolerates).
        sock = self.raw_session()
        sock.sendall(probe.PREAMBLE)
        probe.read_exact(sock, 8)
        probe.write_frame(sock, {"id": 1, "op": "hello", "v": 1, "nonce": secrets.token_bytes(16).hex()})
        hello, _ = probe.read_frame(sock, probe.RES_JSON_MAX, probe.RES_BIN_MAX)
        probe.write_frame(sock, {"id": 2, "op": "auth", "proof": secrets.token_bytes(32).hex()})
        auth, _ = probe.read_frame(sock, probe.RES_JSON_MAX, probe.RES_BIN_MAX)
        sock.close()
        self.save("wrong-proof", {"id": 2, "op": "auth", "proof": "<random>"}, auth)
        self.check("hello answers v 1, a nonce and a proof", hello.get("ok") and hello.get("v") == 1 and len(hello.get("nonce", "")) == 32 and len(hello.get("proof", "")) == 64)
        self.check("a wrong PC proof answers auth_failed", auth.get("error", {}).get("code") == "auth_failed")
        # An old protocol version.
        sock = self.raw_session()
        sock.sendall(probe.PREAMBLE)
        probe.read_exact(sock, 8)
        probe.write_frame(sock, {"id": 1, "op": "hello", "v": 0, "nonce": secrets.token_bytes(16).hex()})
        old, _ = probe.read_frame(sock, probe.RES_JSON_MAX, probe.RES_BIN_MAX)
        sock.close()
        self.check("hello with v 0 answers unsupported_version [1]", old.get("error", {}).get("code") == "unsupported_version" and old["error"].get("detail", {}).get("supported") == [1])

    def walk(self):
        self.client = self.connect(apps=APPS)
        info = self.client.info
        self.save("auth", {"op": "auth", "apps": APPS}, info)
        self.screen = info.get("screen", {})
        w, h = self.screen.get("width", 0), self.screen.get("height", 0)
        self.check("auth answers runner, device, screen, caps, limits",
                   info.get("runner", {}).get("protocol") == 1 and w > 0 and h > 0 and "limits" in info,
                   "runner %s, device %s, screen %s, caps %s" % (json.dumps(info.get("runner")), json.dumps(info.get("device")), json.dumps(self.screen), info.get("caps")))
        caps = info.get("caps", [])
        self.caps = caps

        state, _, ms = self.call("state", "state")
        expected = False if "lock_state" in caps else None
        self.check("state (locked %s, caps %s)" % (json.dumps(expected), "with lock_state" if "lock_state" in caps else "without lock_state"),
                   state.get("ok") and state.get("locked") is expected and "keyboard" in state,
                   "front %s, locked %s in %d ms" % (json.dumps(state.get("front")), json.dumps(state.get("locked")), ms))
        if self.udid:
            self.check("the runner offers lock_state in the Simulator", "lock_state" in caps, "caps %s" % caps)

        shot, png, ms = self.call("screenshot-png", "screenshot")
        ok = shot.get("ok") and png[:8] == b"\x89PNG\r\n\x1a\n"
        rx = shot.get("width", 0) / w if w else 0
        ry = shot.get("height", 0) / h if h else 0
        self.check("screenshot PNG as raw attachment", ok, "%dx%d px for %sx%s pt (%.3f / %.3f px per pt, scale %s), %d bytes in %d ms"
                   % (shot.get("width", 0), shot.get("height", 0), w, h, rx, ry, self.screen.get("scale"), len(png), ms))
        scale = self.screen.get("scale", 0)
        self.check("screen points match the picture (pixels per point = scale on both axes)", scale and abs(rx - scale) < 0.02 and abs(ry - scale) < 0.02,
                   "%.3f / %.3f against %s" % (rx, ry, scale))

        opened, _, ms = self.call("open-settings", "open", bundle="com.apple.Preferences")
        self.check("open bundle com.apple.Preferences", opened.get("ok") and opened.get("front", {}).get("bundle") == "com.apple.Preferences", "%d ms" % ms)
        time.sleep(1.5)
        st, _, ms = self.call("state-settings", "state")
        self.check("after open, state says Settings is in front", self.front_of(st) == "com.apple.Preferences", "%s in %d ms" % (json.dumps(st.get("front")), ms))

        tree, _, ms = self.call("tree-settings", "tree")
        nodes = tree.get("nodes", []) if tree.get("ok") else []
        flat = all(n["i"] == k for k, n in enumerate(nodes)) and all(n["p"] < n["i"] for n in nodes)
        self.check("tree of Settings: flat list, parents first", tree.get("ok") and flat and tree.get("front", {}).get("bundle") == "com.apple.Preferences",
                   "%d nodes, truncated %s, %d ms" % (len(nodes), tree.get("truncated"), ms))
        general = self.find(nodes, label="General", types=["Cell", "Button"]) or self.find(nodes, label="General")
        if not self.check("tree holds 'General' with a frame", bool(general)):
            return
        gx, gy = self.center(general[0])

        tap, _, ms = self.call("tap-general", "tap", x=gx, y=gy)
        self.check("tap on General", tap.get("ok"), "at %s,%s (%s), %d ms" % (gx, gy, general[0].get("type"), ms))
        time.sleep(1.5)
        self.call("screenshot-general", "screenshot", **self.jpeg())
        page, _, _ = self.call("tree-general", "tree")
        about = self.find(page.get("nodes", []), label="About")
        self.check("the tap opened General (its tree holds 'About')", bool(about))

        # Swipe up on the General page: a node further down moves up.
        before = {n.get("label"): n["frame"][1] for n in page.get("nodes", []) if n.get("label") and "frame" in n and n.get("type") in ("Cell", "Button", "StaticText")}
        op, fields = probe.parse_step("swipe:%s,%s,%s,%s,400" % (round(w / 2, 1), round(h * 0.75, 1), round(w / 2, 1), round(h * 0.3, 1)))
        swipe, _, ms = self.call("swipe-up", op, **fields)
        self.check("swipe with %d points" % len(fields["points"]), swipe.get("ok"), "mode %s, %d ms" % (swipe.get("mode"), ms))
        self.check("the swipe went along the pointer path (caps has path, mode path)", "path" in caps and swipe.get("mode") == "path",
                   "caps %s, mode %s" % (caps, swipe.get("mode")), required=False)
        time.sleep(1.2)
        self.call("screenshot-swiped", "screenshot", **self.jpeg())
        moved, _, _ = self.call("tree-swiped", "tree")
        after = {n.get("label"): n["frame"][1] for n in moved.get("nodes", []) if n.get("label") and "frame" in n and n.get("type") in ("Cell", "Button", "StaticText")}
        shifts = [before[k] - after[k] for k in before if k in after and before[k] != after[k]]
        shift = max(shifts) if shifts else 0
        self.check("the page scrolled (nodes moved up)", shift > 50, "largest move %.1f pt over %d shared labels" % (shift, len([k for k in before if k in after])))

        # Back to the Settings list with the back button from the tree (else a swipe from the left edge).
        back = self.find(moved.get("nodes", []), types=["Button"], parent_type="NavigationBar")
        if back:
            bx, by = self.center(back[0])
            answer, _, _ = self.call("tap-back", "tap", x=bx, y=by)
            self.check("tap on the back button (%s)" % back[0].get("label", "?"), answer.get("ok"))
        else:
            op, fields = probe.parse_step("swipe:2,%s,%s,%s,300" % (round(h / 2, 1), round(w * 0.8, 1), round(h / 2, 1)))
            answer, _, _ = self.call("swipe-back", op, **fields)
            self.check("back by a swipe from the left edge (no back button in the tree)", answer.get("ok"))
        time.sleep(1.5)

        # Text into Settings' search field.
        root, _, _ = self.call("tree-root", "tree")
        field = self.find(root.get("nodes", []), types=["SearchField"])
        if not field:
            op, fields = probe.parse_step("swipe:%s,%s,%s,%s,300" % (round(w / 2, 1), round(h * 0.3, 1), round(w / 2, 1), round(h * 0.6, 1)))
            self.call("swipe-down-for-search", op, **fields)
            time.sleep(1.0)
            root, _, _ = self.call("tree-root-again", "tree")
            field = self.find(root.get("nodes", []), types=["SearchField"])
        if self.check("Settings shows a search field", bool(field)):
            fx, fy = self.center(field[0])
            self.call("tap-search", "tap", x=fx, y=fy)
            time.sleep(1.2)
            st, _, _ = self.call("state-keyboard", "state")
            self.check("state says the keyboard is up", st.get("keyboard") is True, json.dumps({k: st.get(k) for k in ("front", "keyboard", "alert")}))
            typed, _, ms = self.call("text-umlauts", "text", text="Grüße")
            self.check("text with umlauts", typed.get("ok") and typed.get("typed") == 5, "%d ms" % ms)
            emoji, _, _ = self.call("text-emoji", "text", text=" 👋")
            self.check("text with an emoji", emoji.get("ok"), json.dumps(emoji.get("error")) if not emoji.get("ok") else "", required=False)
            time.sleep(0.8)
            self.call("screenshot-typed", "screenshot", **self.jpeg())
            after_typing, _, _ = self.call("tree-typed", "tree")
            values = [n.get("value", "") for n in after_typing.get("nodes", []) if n.get("type") == "SearchField"]
            self.check("the search field holds the typed text", any(v.startswith("Grüße") for v in values), "values %s" % values)
            focused = [n.get("type") for n in after_typing.get("nodes", []) if n.get("focused")]
            self.check("a node is marked focused (hasFocus at run time)", bool(focused), "focused %s" % focused, required=False)
            erased, _, _ = self.call("text-delete", "text", text="\b")
            self.check("text \\u0008 deletes (one character processed)", erased.get("ok") and erased.get("typed") == 1)

        # Busy: a second request while the first runs.
        sock = self.client.sock
        nid = self.client.next_id
        probe.write_frame(sock, {"id": nid + 1, "op": "tree"})
        probe.write_frame(sock, {"id": nid + 2, "op": "ping"})
        answers = {}
        for _ in range(2):
            a, _ = probe.read_frame(sock, probe.RES_JSON_MAX, probe.RES_BIN_MAX)
            answers[a.get("id")] = a
        self.client.next_id = nid + 2
        self.check("a request while another runs answers busy", answers.get(nid + 2, {}).get("error", {}).get("code") == "busy" and answers.get(nid + 1, {}).get("ok"))

        home, _, _ = self.call("button-home", "button", name="home")
        self.check("button home", home.get("ok"))
        time.sleep(1.5)
        st, _, ms = self.call("state-home", "state")
        self.check("after home the front app is SpringBoard", st.get("front", {}) and st["front"].get("bundle") == "com.apple.springboard", "%s in %d ms" % (json.dumps(st.get("front")), ms))
        self.call("screenshot-home", "screenshot", **self.jpeg())
        nofocus, _, _ = self.call("text-no-focus", "text", text="x")
        self.check("text without a focused field answers no_focus", nofocus.get("error", {}).get("code") == "no_focus", json.dumps(nofocus.get("error")))
        self.guarded("the runner's name on the home screen", self.runner_name, w, h)

        link, _, ms = self.call("open-url", "open", url="https://example.com")
        self.check("open https link", link.get("ok"), "front %s, %d ms" % (json.dumps(link.get("front")), ms))
        time.sleep(3)
        self.call("screenshot-link", "screenshot", **self.jpeg())
        st, _, _ = self.call("state-link", "state")
        self.check("after the link the front is unknown or Safari, never the app behind it", self.front_of(st) in (None, "com.apple.mobilesafari"), json.dumps(st.get("front")))
        self.check("after the link Safari is in front", self.front_of(st) == "com.apple.mobilesafari", json.dumps(st.get("front")), required=False)
        again, _, ms = self.call("open-settings-after-link", "open", bundle="com.apple.Preferences")
        time.sleep(1.2)
        st, _, _ = self.call("state-settings-after-link", "state")
        self.check("open after the link: Settings in front again", again.get("ok") and self.front_of(st) == "com.apple.Preferences", "%s, open %d ms" % (json.dumps(st.get("front")), ms))
        self.call("screenshot-settings-after-link", "screenshot", **self.jpeg())
        home, _, _ = self.call("button-home-2", "button", name="home")
        time.sleep(1.5)
        st, _, _ = self.call("state-home-2", "state")
        self.check("home again: SpringBoard in front", home.get("ok") and self.front_of(st) == SPRINGBOARD, json.dumps(st.get("front")))

        # Error codes the Simulator can show.
        def expect(name, code, op, /, **fields):
            answer, _, _ = self.call(name, op, **fields)
            got = answer.get("error", {}).get("code") if not answer.get("ok") else "ok"
            return self.check("%s answers %s" % (name, code), got == code, "got %s" % got)

        expect("tap-outside", "out_of_bounds", "tap", x=w + 100, y=10)
        expect("open-tel", "bad_request", "open", url="tel:112")
        expect("button-volume-simulator", "unsupported", "button", name="volume_up")
        expect("screenshot-bad-quality", "bad_request", "screenshot", format="jpeg", quality=2)
        expect("unknown-op", "unknown_op", "frobnicate")
        expect("tree-unknown-app", "app_not_found", "tree", bundle="com.example.none")
        small, _, _ = self.call("tree-small", "tree", maxNodes=5)
        self.check("tree with maxNodes 5 is cut (truncated)", small.get("ok") and small.get("count") == 5 and small.get("truncated") is True)
        action, _, _ = self.call("button-action", "button", name="action")
        self.check("button action", action.get("ok") or action.get("error", {}).get("code") == "unsupported",
                   "ok" if action.get("ok") else json.dumps(action.get("error")), required=False)
        ping, _, _ = self.call("ping", "ping")
        self.check("ping", ping.get("ok") and ping.get("uptimeMs", 0) > 0, "uptime %s ms" % ping.get("uptimeMs"))
        missing, _, ms = self.call("open-unknown-app", "open", bundle="com.example.none")
        got = missing.get("error", {}).get("code") if not missing.get("ok") else "ok"
        self.check("open unknown bundle answers app_not_found", got == "app_not_found", "got %s in %d ms" % (got, ms), required=False)

        if self.udid:
            self.guarded("the lock walk", self.lock_walk, w, h)

        # A second connection replaces the first.
        second = self.connect(apps=APPS, wait=15)
        try:
            self.client.sock.settimeout(5)
            self.client.call("ping")
            replaced = False
        except (OSError, probe.ProtocolError, ValueError):
            replaced = True
        self.check("a newer authenticated connection closes the older one", replaced)
        self.client.close()
        self.client = second

        end, _, _ = self.call("end", "end")
        self.check("end", end.get("ok"))
        self.client.close()
        time.sleep(2)
        try:
            socket.create_connection((self.host, self.port), timeout=3).close()
            gone = False
        except OSError:
            gone = True
        self.check("after end the port is closed", gone)

    def guarded(self, what, step, *args):
        # A Python error inside a part of the walk is that part's failure; the rest of the walk still runs.
        try:
            step(*args)
        except (OSError, probe.ProtocolError, ValueError, KeyError, TypeError, IndexError) as error:
            self.check("%s ran to its end" % what, False, "%s: %s" % (type(error).__name__, error))
            try:
                self.client.close()
            except OSError:
                pass
            self.client = self.connect(apps=APPS, wait=30)

    def runner_name(self, w, h):
        """Konrad #53: the runner's host app shows as "Autark Control" on the home screen (CFBundleDisplayName set after the build)."""
        sb, _, ms = self.call("tree-home-all", "tree", bundle=SPRINGBOARD, all=True, maxNodes=3000)
        nodes = sb.get("nodes", [])
        icons = self.find(nodes, label=RUNNER_NAME)
        old = self.find(nodes, label="AutarkRunnerUITests-Runner")
        self.check("the home screen shows the runner as '%s'" % RUNNER_NAME, bool(icons) and not old,
                   "%s, old name %s, %d nodes in %d ms" % ([(n.get("type"), n.get("frame")) for n in icons], bool(old), len(nodes), ms), required=False)
        if not icons:
            return
        pages = int(icons[0]["frame"][0] // w) if w else 0
        for page in range(min(max(pages, 0), 4)):
            op, fields = probe.parse_step("swipe:%s,%s,%s,%s,250" % (round(w * 0.85, 1), round(h * 0.5, 1), round(w * 0.15, 1), round(h * 0.5, 1)))
            self.call("swipe-home-page-%d" % (page + 2), op, **fields)
            time.sleep(1.0)
        self.call("screenshot-home-autark-control", "screenshot", format="jpeg", maxEdge=1300, quality=0.8)
        if pages:
            self.call("button-home-first-page", "button", name="home")
            time.sleep(1.0)

    def lock_walk(self, w, h):
        """Konrad #53: locked -> state.locked true, inputs answer `locked`, nothing typed; home allowed; unlocked again -> false."""
        self.call("lock-open-settings", "open", bundle="com.apple.Preferences")
        time.sleep(1.5)
        st, _, ms = self.call("lock-state-before", "state")
        truth = self.truth()
        self.check("unlocked: state.locked is false", st.get("locked") is False, "simulator lockstate %s, front %s, %d ms" % (truth, json.dumps(st.get("front")), ms))
        attempt = 0
        for attempt in (1, 2):
            self.sim_lock()
            time.sleep(3)
            truth = self.truth()
            self.sim_shot("locked-%d" % attempt)
            st, _, ms = self.call("lock-state-locked-%d" % attempt, "state")
            print("     lock attempt %d: simulator lockstate %s, runner locked %s" % (attempt, truth, json.dumps(st.get("locked"))), flush=True)
            if st.get("locked") is True or truth == 1:
                break
            self.sim_home()  # Siri instead of the lock (seen once in run 44942711486): away with it, then again
            time.sleep(2)
        self.check("after Cmd-L state.locked is true", st.get("locked") is True, "simulator lockstate %s, front %s, %d ms, attempt %d" % (truth, json.dumps(st.get("front")), ms, attempt))
        self.check("the Simulator itself says locked (notifyutil)", truth == 1, "lockstate %s" % truth, required=False)
        self.check("while locked the front is SpringBoard (the lock screen)", self.front_of(st) == SPRINGBOARD, json.dumps(st.get("front")), required=False)
        shot, _, ms = self.call("lock-screenshot", "screenshot", format="jpeg", maxEdge=1300, quality=0.8)
        self.check("a screenshot works while locked", shot.get("ok"), "%d ms" % ms)
        tree, _, ms = self.call("lock-tree", "tree", all=True, maxNodes=3000)
        self.check("the tree while locked is SpringBoard's", tree.get("ok") and self.front_of(tree) == SPRINGBOARD, "%d nodes, %d ms" % (tree.get("count", 0), ms), required=False)

        def refused(name, op, required=True, /, **fields):
            answer, _, took = self.call(name, op, **fields)
            got = answer.get("error", {}).get("code") if not answer.get("ok") else "ok"
            return self.check("while locked %s answers locked" % name, got == "locked", "got %s in %d ms" % (got, took), required=required)

        refused("lock-tap", "tap", x=round(w / 2, 1), y=round(h / 2, 1))
        refused("lock-text", "text", text="1")
        op, fields = probe.parse_step("swipe:%s,%s,%s,%s,300" % (round(w / 2, 1), round(h * 0.9, 1), round(w / 2, 1), round(h * 0.3, 1)))
        refused("lock-swipe", op, **fields)
        refused("lock-open-bundle", "open", bundle="com.apple.Preferences")
        refused("lock-open-url", "open", url="https://example.com")
        refused("lock-button-action", "button", False, name="action")
        st, _, _ = self.call("lock-state-after-refusals", "state")
        truth = self.truth()
        self.check("the refused inputs left the Simulator locked", st.get("locked") is True and truth in (1, None), "runner %s, simulator %s" % (json.dumps(st.get("locked")), truth))

        home, _, ms = self.call("lock-button-home", "button", name="home")
        self.check("home is carried out while locked", home.get("ok"), "%d ms" % ms)
        time.sleep(2.5)
        truth = self.truth()
        self.sim_shot("after-home-on-lock-screen")
        self.call("lock-screenshot-after-home", "screenshot", **self.jpeg())
        st, _, _ = self.call("lock-state-after-home", "state")
        agrees = ((st.get("locked") is True) == (truth == 1)) if truth is not None else st.get("locked") is not None
        self.check("home on the lock screen (Simulator without a code): runner locked %s, simulator %s" % (json.dumps(st.get("locked")), truth), agrees, required=False)
        if st.get("locked") is not False:
            self.sim_home()
            time.sleep(3)
        st, _, ms = self.call("lock-state-unlocked", "state")
        truth = self.truth()
        self.check("after unlocking state.locked is false", st.get("locked") is False, "simulator lockstate %s, front %s, %d ms" % (truth, json.dumps(st.get("front")), ms))
        again, _, ms = self.call("lock-open-after-unlock", "open", bundle="com.apple.Preferences")
        self.check("input works again after unlocking (open Settings)", again.get("ok"), "%d ms" % ms)
        time.sleep(1.2)

        # The notification center (the same cover sheet, but unlocked) must not count as locked.
        op, fields = probe.parse_step("swipe:%s,1,%s,%s,450" % (round(w * 0.25, 1), round(w * 0.25, 1), round(h * 0.75, 1)))
        pulled, _, _ = self.call("nc-swipe-down", op, **fields)
        time.sleep(1.5)
        truth = self.truth()
        self.sim_shot("notification-center")
        self.call("nc-screenshot", "screenshot", format="jpeg", maxEdge=1300, quality=0.8)
        st, _, ms = self.call("nc-state", "state")
        self.call("nc-tree", "tree", bundle=SPRINGBOARD, all=True, maxNodes=3000)
        self.check("the notification center pulled down is not taken for the lock", pulled.get("ok") and st.get("locked") is False,
                   "runner %s, simulator lockstate %s, %d ms" % (json.dumps(st.get("locked")), truth, ms))
        self.call("nc-button-home", "button", name="home")
        time.sleep(1.5)
        st, _, _ = self.call("lock-state-end", "state")
        self.check("after the lock walk: unlocked, SpringBoard in front", st.get("locked") is False and self.front_of(st) == SPRINGBOARD,
                   json.dumps({k: st.get(k) for k in ("front", "locked")}), required=False)

    @staticmethod
    def jpeg():
        return {"format": "jpeg", "maxEdge": 800, "quality": 0.6}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", default=os.environ.get("AUTARK_RUNNER_TOKEN", ""))
    parser.add_argument("--out", required=True)
    parser.add_argument("--sim-udid", help="the booted Simulator (macOS host): adds the lock walk")
    args = parser.parse_args()
    proof = Proof(args.host, args.port, args.token, args.out, udid=args.sim_udid)
    started = time.time()
    try:
        proof.client = None
        first = proof.connect(apps=APPS)  # wait until the runner serves, then measure the negatives on a living runner
        first.close()
        proof.negatives_before_auth()
        proof.walk()
    except Exception as error:  # the summary still gets written
        proof.check("the walk ran to its end", False, "%s: %s" % (type(error).__name__, error))
    required = [c for c in proof.checks if c["required"]]
    passed = [c for c in required if c["ok"]]
    summary = {"seconds": int(time.time() - started), "required": len(required), "passed": len(passed),
               "optional": [c for c in proof.checks if not c["required"]], "checks": proof.checks}
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "summary.md"), "w", encoding="utf-8") as handle:
        handle.write("%d of %d required checks passed in %d s\n\n" % (len(passed), len(required), summary["seconds"]))
        for c in proof.checks:
            handle.write("- %s %s%s\n" % ("✅" if c["ok"] else ("❌" if c["required"] else "➖"), c["name"], (": " + c["detail"]) if c["detail"] else ""))
    print("%d of %d required checks passed (%d s)" % (len(passed), len(required), summary["seconds"]))
    return 0 if len(passed) == len(required) else 1


if __name__ == "__main__":
    sys.exit(main())
