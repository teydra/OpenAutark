#!/usr/bin/env python3
"""Reference client for the Autark runner protocol, version 1 (PROTOKOLL-RUNNER.md).

Python standard library only. Runs on the macOS CI runner (against the runner in the Simulator, which
listens on the Mac's 127.0.0.1) and on Windows (against a port `ios forward` opened).

  runner-probe.py --port 51873 --token <64 hex> [--host 127.0.0.1] [--out DIR] [--wait 90] STEP...
  runner-probe.py --selftest

STEP is one of:
  state | tree | screenshot | end | ping
  tap:X,Y | swipe:X1,Y1,X2,Y2[,MS] | text:STRING | button:NAME | open:URL-or-bundle-id | sleep:MS
  raw:{"op":"..."}                       (any request as JSON, without id)

Every request and answer is printed as one JSON line (a binary attachment as its size); with --out the
answers are also written as NN-<op>.json and screenshots as NN-screenshot.<format>.
Exit code 0: every step answered ok. 1: a step answered an error. 2: connection or handshake failed.
The token is never printed.
"""
import argparse, hashlib, hmac, json, os, secrets, socket, struct, sys, threading, time

PREAMBLE = b"ATKRUN1\n"
REQ_JSON_MAX = 262_144
RES_JSON_MAX = 4_194_304
RES_BIN_MAX = 25_165_824


class ProtocolError(Exception):
    pass


def read_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(min(65536, n - len(buf)))
        if not chunk:
            raise ProtocolError("connection closed after %d of %d bytes" % (len(buf), n))
        buf += chunk
    return bytes(buf)


def write_frame(sock, obj, binary=b""):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sock.sendall(struct.pack(">II", len(data), len(binary)) + data + binary)


def read_frame(sock, json_max, bin_max):
    json_len, bin_len = struct.unpack(">II", read_exact(sock, 8))
    if json_len == 0 or json_len > json_max or bin_len > bin_max:
        raise ProtocolError("frame outside the limits: json %d, bin %d" % (json_len, bin_len))
    obj = json.loads(read_exact(sock, json_len).decode("utf-8"))
    if not isinstance(obj, dict):
        raise ProtocolError("frame is not a JSON object")
    return obj, (read_exact(sock, bin_len) if bin_len else b"")


def proof(token, label, pc_nonce, runner_nonce):
    return hmac.new(token, label + pc_nonce + runner_nonce, hashlib.sha256).hexdigest()


class Client:
    def __init__(self, host, port, token_hex, timeout=40.0):
        self.token = bytes.fromhex(token_hex)
        if len(self.token) != 32:
            raise ProtocolError("the token must be 64 hex characters")
        self.sock = socket.create_connection((host, port), timeout=5.0)
        self.sock.settimeout(timeout)
        self.next_id = 0
        self.info = None

    def call(self, op, **fields):
        self.next_id += 1
        request = {"id": self.next_id, "op": op}
        request.update(fields)
        write_frame(self.sock, request)
        answer, binary = read_frame(self.sock, RES_JSON_MAX, RES_BIN_MAX)
        if answer.get("id") != self.next_id:
            raise ProtocolError("answer id %r for request %d" % (answer.get("id"), self.next_id))
        return request, answer, binary

    def handshake(self, apps=None):
        self.sock.sendall(PREAMBLE)
        if read_exact(self.sock, len(PREAMBLE)) != PREAMBLE:
            raise ProtocolError("the other side did not answer the preamble")
        pc_nonce = secrets.token_bytes(16)
        _, hello, _ = self.call("hello", v=1, nonce=pc_nonce.hex())
        if not hello.get("ok"):
            raise ProtocolError("hello refused: %s" % json.dumps(hello.get("error")))
        runner_nonce = bytes.fromhex(hello["nonce"])
        expected = proof(self.token, b"ATKRUN1 runner", pc_nonce, runner_nonce)
        if not hmac.compare_digest(expected, str(hello.get("proof", ""))):
            raise ProtocolError("the runner's proof is wrong: another service answers on this port")
        fields = {"proof": proof(self.token, b"ATKRUN1 pc", pc_nonce, runner_nonce)}
        if apps:
            fields["apps"] = apps
        _, auth, _ = self.call("auth", **fields)
        if not auth.get("ok"):
            raise ProtocolError("auth refused: %s" % json.dumps(auth.get("error")))
        self.info = auth
        return auth

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def parse_step(step):
    name, _, arg = step.partition(":")
    if name in ("state", "tree", "screenshot", "end", "ping") and not arg:
        return name, {}
    if name == "tap":
        x, y = (float(v) for v in arg.split(","))
        return "tap", {"x": x, "y": y}
    if name == "swipe":
        parts = [float(v) for v in arg.split(",")]
        ms = int(parts[4]) if len(parts) > 4 else 400
        (x1, y1, x2, y2) = parts[:4]
        # A straight path with an eased speed, 12 points – enough for a proof; the PC driver sends the real curve.
        points = []
        for i in range(12):
            f = i / 11.0
            e = f * f * (3 - 2 * f)
            points.append({"x": round(x1 + (x2 - x1) * e, 1), "y": round(y1 + (y2 - y1) * e, 1), "t": int(round(ms * f))})
        for i in range(1, len(points)):
            points[i]["t"] = max(points[i]["t"], points[i - 1]["t"] + 1)
        return "swipe", {"points": points}
    if name == "text":
        return "text", {"text": arg}
    if name == "button":
        return "button", {"name": arg}
    if name == "open":
        return "open", ({"url": arg} if "://" in arg else {"bundle": arg})
    if name == "raw":
        fields = json.loads(arg)
        return fields.pop("op"), fields
    raise ValueError("unknown step: %s" % step)


def connect(host, port, token, wait):
    deadline = time.time() + wait
    last = None
    while True:
        try:
            client = Client(host, port, token)
            client.handshake()
            return client
        except (OSError, ProtocolError, ValueError, KeyError) as error:
            last = error
            if time.time() >= deadline:
                raise ProtocolError("no runner on %s:%d after %d s: %s" % (host, port, wait, last))
            time.sleep(1.0)


def run(args):
    try:
        client = connect(args.host, args.port, args.token, args.wait)
    except ProtocolError as error:
        print(json.dumps({"probe": "failed", "why": str(error)}))
        return 2
    print(json.dumps({"probe": "connected", "answer": client.info}, ensure_ascii=False))
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "00-auth.json"), "w", encoding="utf-8") as handle:
            json.dump(client.info, handle, ensure_ascii=False, indent=1)
    failed = False
    try:
        for number, step in enumerate(args.steps, start=1):
            name, _, arg = step.partition(":")
            if name == "sleep":
                time.sleep(int(arg) / 1000.0)
                continue
            op, fields = parse_step(step)
            started = time.time()
            request, answer, binary = client.call(op, **fields)
            shown = dict(answer)
            if op == "tree" and isinstance(shown.get("nodes"), list) and len(shown["nodes"]) > 6:
                shown["nodes"] = shown["nodes"][:6] + ["… %d more" % (len(answer["nodes"]) - 6)]
            print(json.dumps({"request": request, "ms": int((time.time() - started) * 1000), "answer": shown, "binBytes": len(binary)}, ensure_ascii=False))
            if args.out:
                with open(os.path.join(args.out, "%02d-%s.json" % (number, op)), "w", encoding="utf-8") as handle:
                    json.dump({"request": request, "answer": answer, "binBytes": len(binary)}, handle, ensure_ascii=False, indent=1)
                if binary:
                    with open(os.path.join(args.out, "%02d-%s.%s" % (number, op, answer.get("format", "bin"))), "wb") as handle:
                        handle.write(binary)
            if not answer.get("ok"):
                failed = True
            if op == "end":
                break
    except (OSError, ProtocolError, ValueError) as error:
        print(json.dumps({"probe": "failed", "why": str(error)}))
        return 2
    finally:
        client.close()
    return 1 if failed else 0


# ---------------------------------------------------------------------------------------------- self-test

PNG_1X1 = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082")


def fake_runner(server, token, log):
    """A stand-in runner speaking protocol version 1: enough to check framing, handshake and the error forms."""
    failures = 0
    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            return
        conn.settimeout(5.0)
        try:
            if read_exact(conn, 8) != PREAMBLE:
                conn.close()
                continue
            conn.sendall(PREAMBLE)
            authed = False
            pc_nonce = runner_nonce = b""
            while True:
                request, _ = read_frame(conn, REQ_JSON_MAX, 0)
                rid, op = request.get("id"), request.get("op")
                log.append(op)

                def answer(ok=True, binary=b"", **fields):
                    body = {"id": rid, "ok": ok}
                    body.update(fields)
                    write_frame(conn, body, binary)

                def error(code, message, **detail):
                    answer(False, error=dict({"code": code, "message": message}, **({"detail": detail} if detail else {})))

                if op == "hello":
                    if request.get("v") != 1:
                        error("unsupported_version", "This runner speaks version 1.", supported=[1])
                        break
                    pc_nonce = bytes.fromhex(request["nonce"])
                    runner_nonce = secrets.token_bytes(16)
                    answer(v=1, nonce=runner_nonce.hex(), proof=proof(token, b"ATKRUN1 runner", pc_nonce, runner_nonce))
                elif op == "auth":
                    if not hmac.compare_digest(proof(token, b"ATKRUN1 pc", pc_nonce, runner_nonce), str(request.get("proof", ""))):
                        failures += 1
                        error("auth_failed", "Wrong proof.")
                        break
                    authed = True
                    answer(runner={"version": "0.0.0-selftest", "build": "0", "protocol": 1, "bundle": "selftest"},
                           device={"name": "Fake", "model": "iPhone16,1", "system": "iOS", "version": "18.6", "simulator": True},
                           screen={"width": 402, "height": 874, "scale": 3, "orientation": "portrait"},
                           caps=["path", "open.url"], limits={"textMax": 400, "swipePointsMax": 32, "treeNodesMax": 3000})
                elif not authed:
                    error("unauthorized", "Authenticate first.")
                    break
                elif op == "ping":
                    answer(uptimeMs=1)
                elif op == "state":
                    answer(front={"bundle": "com.apple.springboard"}, screen={"width": 402, "height": 874, "scale": 3, "orientation": "portrait"}, locked=False, keyboard=False, alert=False)
                elif op == "screenshot":
                    answer(binary=PNG_1X1, format="png", width=1, height=1, screen={"width": 402, "height": 874, "scale": 3, "orientation": "portrait"})
                elif op == "tree":
                    answer(front={"bundle": "com.apple.springboard"}, screen={"width": 402, "height": 874, "scale": 3, "orientation": "portrait"}, count=2, truncated=False,
                           nodes=[{"i": 0, "p": -1, "d": 0, "type": "Application", "frame": [0, 0, 402, 874], "app": "com.apple.springboard"},
                                  {"i": 1, "p": 0, "d": 1, "type": "Icon", "label": "Einstellungen", "frame": [30, 90, 64, 64]}])
                elif op == "tap":
                    x, y = request.get("x"), request.get("y")
                    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                        error("bad_request", "tap needs x and y.")
                    elif not (0 <= x < 402 and 0 <= y < 874):
                        error("out_of_bounds", "The point is outside the screen.", screen={"width": 402, "height": 874})
                    else:
                        answer()
                elif op == "swipe":
                    points = request.get("points")
                    times = [p.get("t") for p in points] if isinstance(points, list) else []
                    if not (2 <= len(times) <= 32) or times[0] != 0 or any(b <= a for a, b in zip(times, times[1:])) or times[-1] > 10000:
                        error("bad_request", "swipe needs 2 to 32 points with ascending t from 0.")
                    else:
                        answer(mode="path")
                elif op == "text":
                    text = request.get("text")
                    if not isinstance(text, str) or not (1 <= len(text) <= 400):
                        error("bad_request", "text needs 1 to 400 characters.")
                    elif text == "nofocus":
                        error("no_focus", "No field has the keyboard focus.")
                    else:
                        answer(typed=len(text))
                elif op == "button":
                    answer() if request.get("name") == "home" else error("unsupported", "This device has no such button.")
                elif op == "open":
                    if ("url" in request) == ("bundle" in request):
                        error("bad_request", "open needs exactly one of url and bundle.")
                    elif "url" in request and not str(request["url"]).startswith(("http://", "https://")):
                        error("bad_request", "Only http and https links.")
                    elif request.get("bundle") == "com.example.none":
                        error("app_not_found", "No app with this bundle id is installed.")
                    else:
                        answer(front={"bundle": request.get("bundle") or "com.apple.mobilesafari"})
                elif op == "end":
                    answer()
                    conn.close()
                    server.close()
                    return
                else:
                    error("unknown_op", "Unknown operation.")
        except (ProtocolError, OSError, ValueError, KeyError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass


def selftest():
    token = secrets.token_bytes(32)
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    port = server.getsockname()[1]
    log = []
    thread = threading.Thread(target=fake_runner, args=(server, token, log), daemon=True)
    thread.start()
    checks = []

    def check(name, condition):
        checks.append((name, bool(condition)))

    # 1. A stray client (HTTP) gets nothing back.
    stray = socket.create_connection(("127.0.0.1", port), timeout=3)
    stray.sendall(b"GET / HTTP/1.1\r\n\r\n")
    try:
        check("stray HTTP client is closed without an answer", stray.recv(16) == b"")
    except OSError:
        check("stray HTTP client is closed without an answer", True)
    stray.close()

    # 2. A wrong token: the runner's proof does not verify.
    try:
        Client("127.0.0.1", port, secrets.token_bytes(32).hex()).handshake()
        check("wrong token is refused", False)
    except ProtocolError as error:
        check("wrong token is refused", "proof is wrong" in str(error))

    # 3. An operation before auth.
    early = Client("127.0.0.1", port, token.hex())
    early.sock.sendall(PREAMBLE)
    read_exact(early.sock, 8)
    _, answer, _ = early.call("state")
    check("operation before auth answers unauthorized", answer.get("ok") is False and answer["error"]["code"] == "unauthorized")
    early.close()

    # 4. The whole walk.
    client = Client("127.0.0.1", port, token.hex())
    info = client.handshake(apps=["com.apple.Preferences"])
    check("auth answers device, screen, caps", info["screen"]["width"] == 402 and "path" in info["caps"] and info["runner"]["protocol"] == 1)
    _, answer, _ = client.call("state")
    check("state", answer["ok"] and answer["front"]["bundle"] == "com.apple.springboard" and answer["locked"] is False)
    _, answer, binary = client.call("screenshot")
    check("screenshot carries the PNG as binary attachment", answer["ok"] and binary[:8] == b"\x89PNG\r\n\x1a\n" and answer["format"] == "png")
    _, answer, _ = client.call("tree", maxNodes=1500)
    check("tree is a flat list with i/p/d", answer["ok"] and [n["p"] for n in answer["nodes"]] == [-1, 0] and answer["nodes"][1]["frame"] == [30, 90, 64, 64])
    _, answer, _ = client.call("tap", x=62, y=122)
    check("tap", answer["ok"])
    _, answer, _ = client.call("tap", x=5000, y=10)
    check("tap outside answers out_of_bounds", answer["error"]["code"] == "out_of_bounds")
    op, fields = parse_step("swipe:201,611,201,262,300")
    _, answer, _ = client.call(op, **fields)
    check("swipe with 12 ascending points", answer["ok"] and answer["mode"] == "path" and fields["points"][0]["t"] == 0 and fields["points"][-1] == {"x": 201.0, "y": 262.0, "t": 300})
    _, answer, _ = client.call("text", text="Grüße 👋\n")
    check("text with umlauts and emoji survives the JSON frame", answer["ok"] and answer["typed"] == len("Grüße 👋\n"))
    _, answer, _ = client.call("text", text="nofocus")
    check("text without focus answers no_focus", answer["error"]["code"] == "no_focus")
    _, answer, _ = client.call("button", name="volume_up")
    check("missing button answers unsupported", answer["error"]["code"] == "unsupported")
    _, answer, _ = client.call("open", url="tel:112")
    check("open refuses other schemes", answer["error"]["code"] == "bad_request")
    _, answer, _ = client.call("open", bundle="com.example.none")
    check("open unknown bundle answers app_not_found", answer["error"]["code"] == "app_not_found")
    _, answer, _ = client.call("frobnicate")
    check("unknown operation answers unknown_op and keeps the connection", answer["error"]["code"] == "unknown_op")
    _, answer, _ = client.call("end")
    check("end", answer["ok"])
    client.close()
    thread.join(timeout=3)
    check("the fake runner ended after end", not thread.is_alive())

    width = max(len(name) for name, _ in checks)
    for name, passed in checks:
        print("%s  %s" % (name.ljust(width), "ok" if passed else "FAILED"))
    bad = [name for name, passed in checks if not passed]
    print("%d of %d checks passed" % (len(checks) - len(bad), len(checks)))
    return 1 if bad else 0


def main():
    parser = argparse.ArgumentParser(description="Reference client for the Autark runner protocol v1.")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int)
    parser.add_argument("--token", default=os.environ.get("AUTARK_RUNNER_TOKEN", ""))
    parser.add_argument("--out")
    parser.add_argument("--wait", type=int, default=90, help="seconds to wait for the runner to accept the handshake")
    parser.add_argument("steps", nargs="*")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.port or not args.token:
        parser.error("--port and --token (or AUTARK_RUNNER_TOKEN) are needed")
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
