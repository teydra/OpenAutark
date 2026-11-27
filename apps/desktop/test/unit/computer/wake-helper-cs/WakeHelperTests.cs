// Unit tests for the pure parts of resources/broker/WakeHelper.cs (the slim wake helper): JSON, Ed25519/X25519/HKDF/AES-GCM against
// the RFC and NIST vectors, the wake file, the wake check (signature, freshness, replay, wrong session), the throttle, the helper's
// decision for every frame it can get (a real wake is taken and answered, everything else is dropped WITHOUT an answer), and the
// small life rules. Compiled in memory by test/unit/computer/wake-helper.test.ts through run.ps1. Prints "PASS <name>" or
// "FAIL <name>: <why>" per case and exits 1 on any failure. Never opens a socket, starts a process or touches a file.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using AutarkWake;

namespace AutarkWakeTests
{
    public static class WakeHelperTests
    {
        static int failed;
        const long Now = 1800000000000L;

        static void Case(string name, Func<string> body)
        {
            string why;
            try { why = body(); } catch (Exception e) { why = e.GetType().Name + ": " + e.Message; }
            if (why == null) Console.WriteLine("PASS " + name);
            else { failed++; Console.WriteLine("FAIL " + name + ": " + why); }
        }

        static string Expect(object actual, object expected, string what)
        {
            return Equals(actual, expected) ? null : what + ": expected " + (expected ?? "null") + ", got " + (actual ?? "null");
        }

        static string Ok(bool condition, string what) { return condition ? null : what; }

        static byte[] H(string hex)
        {
            byte[] data = new byte[hex.Length / 2];
            for (int i = 0; i < data.Length; i++) data[i] = byte.Parse(hex.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return data;
        }

        static string X(byte[] data) { return B64.Hex(data); }
        static byte[] Utf8(string s) { return Encoding.UTF8.GetBytes(s); }

        static byte[] Random32()
        {
            byte[] data = new byte[32];
            using (System.Security.Cryptography.RandomNumberGenerator rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(data);
            return data;
        }

        static readonly byte[] Pkcs8Prefix = H("302e020100300506032b657004220420");

        // ---- a helper file and a waking PC -----------------------------------------------------------------------------------
        sealed class Waker { public byte[] Seed = Random32(); public byte[] Pub; public string Fp; public Waker() { Pub = Ed25519.PublicKey(Seed); Fp = WakeRules.FingerprintOf(Pub); } }

        static string FileText(byte[] helperSeed, params Waker[] pins)
        {
            byte[] der = new byte[48];
            Buffer.BlockCopy(Pkcs8Prefix, 0, der, 0, 16);
            Buffer.BlockCopy(helperSeed, 0, der, 16, 32);
            StringBuilder list = new StringBuilder();
            foreach (Waker pin in pins) list.Append(list.Length > 0 ? "," : "").Append("{\"fp\":\"" + pin.Fp + "\",\"pub\":\"" + B64.Enc(pin.Pub) + "\"}");
            return "{\"v\":1,\"relay\":\"wss://meeting.example/autark\",\"key\":{\"pub\":\"" + B64.Enc(Ed25519.PublicKey(helperSeed)) + "\",\"pkcs8\":\"" + Convert.ToBase64String(der) + "\"},\"pins\":[" + list + "]}";
        }

        /// The sending side of seal.ts toBox: a fresh ephemeral key and the cipher towards the helper's box.
        static string ToBox(string box, out PairCipher cipher)
        {
            byte[] boxRaw = B64.Dec(box);
            byte[] priv = Random32();
            byte[] e = X25519.Public(priv);
            byte[] salt = new byte[64];
            Buffer.BlockCopy(e, 0, salt, 0, 32);
            Buffer.BlockCopy(boxRaw, 0, salt, 32, 32);
            byte[] okm = Kdf.Hkdf(X25519.Scalar(priv, boxRaw), salt, Utf8(PairBox.PairInfo), 64);
            byte[] toOwner = new byte[32], toOpener = new byte[32];
            Buffer.BlockCopy(okm, 0, toOwner, 0, 32);
            Buffer.BlockCopy(okm, 32, toOpener, 0, 32);
            cipher = new PairCipher(toOwner, toOpener);
            return B64.Enc(e);
        }

        static string WakeBody(Waker from, string helperFp, string box, long at, string nonce, string extra = "")
        {
            string sig = B64.Enc(Ed25519.Sign(from.Seed, Utf8(WakeRules.WakeText(helperFp, box, at.ToString(CultureInfo.InvariantCulture), nonce))));
            return "{\"op\":\"wake\",\"at\":" + at + ",\"nonce\":\"" + nonce + "\",\"sig\":\"" + sig + "\"" + extra + "}";
        }

        static int nonceCounter;
        static string NewNonce() { return "nonce-" + (++nonceCounter).ToString("D12", CultureInfo.InvariantCulture); }

        sealed class World
        {
            public byte[] HelperSeed = Random32();
            public Waker Phone = new Waker();
            public Waker Stranger = new Waker();
            public long Clock = Now;
            public WakeFile File;
            public WakeCore Core;
            public string HelperFp;
            public World()
            {
                File = WakeRules.Parse(FileText(HelperSeed, Phone));
                Core = new WakeCore(File, () => Clock, s => { });
                HelperFp = File.Fp;
                Core.NewSession();
            }

            /// A pair frame as the meeting server forwards it; `cipher` opens the answer.
            public string Pair(string from, string body, out PairCipher cipher, int @ref = 7)
            {
                string e = ToBox(Core.BoxText, out cipher);
                return "{\"t\":\"pair\",\"ref\":" + @ref + ",\"from\":\"" + from + "\",\"e\":\"" + e + "\",\"c\":\"" + cipher.SealText(body) + "\"}";
            }

            public string Valid(out PairCipher cipher, string extra = "") { return Pair(Phone.Fp, WakeBody(Phone, HelperFp, Core.BoxText, Clock, NewNonce(), extra), out cipher); }
        }

        static string Drop(World w, string frame)
        {
            bool woke;
            string reply = w.Core.OnFrame(frame, out woke);
            return reply == null && !woke ? null : "expected a silent drop, got " + (woke ? "a wake" : "") + (reply ?? "");
        }

        public static int Main()
        {
            // ---- JSON ------------------------------------------------------------------------------------------------------------
            Case("json: objects, arrays, numbers, escapes and unicode", () =>
            {
                Dictionary<string, object> map = MiniJson.Parse("{\"a\":[1,2.5,-3e2,true,false,null],\"s\":\"x\\n\\u00e4\\\"\\\\\",\"o\":{}}") as Dictionary<string, object>;
                List<object> list = (List<object>)map["a"];
                return Expect(list.Count, 6, "count") ?? Expect(list[2], -300.0, "exp") ?? Expect(map["s"], "x\n\u00e4\"\\", "string") ?? Expect(list[5], null, "null");
            });
            Case("json: broken text is refused", () =>
            {
                foreach (string bad in new string[] { "", "{", "{\"a\":}", "[1,]", "{\"a\":1} x", "'a'", "{\"a\":\"\u0001\"}", "nul", "{1:2}" })
                {
                    try { MiniJson.Parse(bad); return "accepted: " + bad; } catch (FormatException) { }
                }
                return null;
            });
            Case("json: nesting is bounded", () =>
            {
                string deep = new string('[', 200) + new string(']', 200);
                try { MiniJson.Parse(deep); return "accepted"; } catch (FormatException) { return null; }
            });
            Case("json: numbers print like JavaScript for integers; strings are quoted", () =>
                Expect(MiniJson.Number(1800000000000.0), "1800000000000", "int") ?? Expect(MiniJson.Number(1.5), "1.5", "fraction") ?? Expect(MiniJson.Quote("a\"b\\c\n"), "\"a\\\"b\\\\c\\u000a\"", "quote"));

            // ---- Ed25519 (RFC 8032) ----------------------------------------------------------------------------------------------
            Case("ed25519: RFC 8032 test 1 (empty message)", () =>
            {
                byte[] seed = H("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
                byte[] pub = Ed25519.PublicKey(seed);
                byte[] sig = Ed25519.Sign(seed, new byte[0]);
                return Expect(X(pub), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "public key")
                    ?? Expect(X(sig), "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", "signature")
                    ?? Ok(Ed25519.Verify(pub, new byte[0], sig), "verify");
            });
            Case("ed25519: RFC 8032 test 2 (one byte)", () =>
            {
                byte[] seed = H("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
                byte[] pub = Ed25519.PublicKey(seed);
                byte[] sig = Ed25519.Sign(seed, H("72"));
                return Expect(X(pub), "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "public key")
                    ?? Expect(X(sig), "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00", "signature")
                    ?? Ok(Ed25519.Verify(pub, H("72"), sig), "verify");
            });
            Case("ed25519: a changed message, signature or key does not verify; S >= L and short input are refused", () =>
            {
                byte[] seed = Random32();
                byte[] pub = Ed25519.PublicKey(seed);
                byte[] msg = Utf8("wake me");
                byte[] sig = Ed25519.Sign(seed, msg);
                if (!Ed25519.Verify(pub, msg, sig)) return "own signature";
                if (Ed25519.Verify(pub, Utf8("wake you"), sig)) return "other message";
                byte[] flipped = (byte[])sig.Clone(); flipped[5] ^= 1;
                if (Ed25519.Verify(pub, msg, flipped)) return "flipped R";
                flipped = (byte[])sig.Clone(); flipped[40] ^= 1;
                if (Ed25519.Verify(pub, msg, flipped)) return "flipped S";
                if (Ed25519.Verify(Ed25519.PublicKey(Random32()), msg, sig)) return "other key";
                byte[] big = (byte[])sig.Clone();
                for (int i = 32; i < 64; i++) big[i] = 0xff;
                if (Ed25519.Verify(pub, msg, big)) return "S >= L";
                if (Ed25519.Verify(pub, msg, new byte[63])) return "short";
                if (Ed25519.Verify(new byte[31], msg, sig)) return "short key";
                byte[] notOnCurve = new byte[32];
                notOnCurve[0] = 2; // y = 2 is no point
                if (Ed25519.Verify(notOnCurve, msg, sig)) return "off-curve key";
                return null;
            });

            // ---- X25519 (RFC 7748), HKDF (RFC 5869), AES-256-GCM -----------------------------------------------------------------
            Case("x25519: RFC 7748 vector and Diffie-Hellman", () =>
            {
                byte[] a = X25519.Scalar(H("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), H("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"));
                byte[] alice = H("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
                byte[] bob = H("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
                byte[] alicePub = X25519.Public(alice), bobPub = X25519.Public(bob);
                return Expect(X(a), "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552", "scalar mult")
                    ?? Expect(X(alicePub), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "alice public")
                    ?? Expect(X(bobPub), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", "bob public")
                    ?? Expect(X(X25519.Scalar(alice, bobPub)), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742", "shared (alice)")
                    ?? Expect(X(X25519.Scalar(bob, alicePub)), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742", "shared (bob)");
            });
            Case("x25519: a low-order point gives an all-zero secret, which the helper refuses", () =>
            {
                byte[] zero = new byte[32];
                return Ok(X25519.AllZero(X25519.Scalar(Random32(), zero)), "zero point");
            });
            Case("hkdf-sha256: RFC 5869 test case 1", () =>
            {
                byte[] ikm = new byte[22];
                for (int i = 0; i < ikm.Length; i++) ikm[i] = 0x0b;
                return Expect(X(Kdf.Hkdf(ikm, H("000102030405060708090a0b0c"), H("f0f1f2f3f4f5f6f7f8f9"), 42)),
                    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", "okm");
            });
            Case("aes-256-gcm: NIST test cases 13 and 14, round trip and tamper", () =>
            {
                byte[] key = new byte[32], nonce = new byte[12];
                byte[] empty = Gcm.Seal(key, nonce, new byte[0]);
                byte[] one = Gcm.Seal(key, nonce, new byte[16]);
                string a = Expect(X(empty), "530f8afbc74536b9a963b4f1c4cb738b", "tc13") ?? Expect(X(one), "cea7403d4d606b6e074ec5d3baf39d18" + "d0d1c8a799996bf0265b98b5d48ab919", "tc14");
                if (a != null) return a;
                byte[] sealedText = Gcm.Seal(Random32(), nonce, Utf8("{\"ok\":true}"));
                byte[] k2 = Random32();
                byte[] boxed = Gcm.Seal(k2, nonce, Utf8("hello"));
                if (Encoding.UTF8.GetString(Gcm.Open(k2, nonce, boxed)) != "hello") return "round trip";
                boxed[0] ^= 1;
                if (Gcm.Open(k2, nonce, boxed) != null) return "tampered ciphertext opened";
                boxed[0] ^= 1; boxed[boxed.Length - 1] ^= 1;
                if (Gcm.Open(k2, nonce, boxed) != null) return "tampered tag opened";
                if (Gcm.Open(k2, nonce, new byte[5]) != null) return "short frame opened";
                return sealedText.Length == 11 + 16 ? null : "length";
            });
            Case("pair cipher: one message each way with counters; a replay of the same frame does not open twice", () =>
            {
                PairBox box = new PairBox();
                PairCipher sender;
                string e = ToBox(box.PubText, out sender);
                PairCipher owner = box.FromSender(e, PairBox.PairInfo);
                if (owner == null) return "no cipher";
                string text = sender.SealText("{\"x\":1}");
                if (owner.OpenJson(text) == null) return "first";
                if (owner.OpenJson(text) != null) return "the same frame opened twice (counter)";
                string reply = owner.SealText("{\"ok\":true}");
                return sender.OpenJson(reply) == null ? "reply" : null;
            });
            Case("pair cipher: a malformed ephemeral key gives no cipher", () =>
            {
                PairBox box = new PairBox();
                return Ok(box.FromSender(null, PairBox.PairInfo) == null && box.FromSender("abc", PairBox.PairInfo) == null && box.FromSender(new string('A', 100), PairBox.PairInfo) == null
                    && box.FromSender(B64.Enc(new byte[32]), PairBox.PairInfo) == null, "malformed e");
            });

            // ---- the helper's file ------------------------------------------------------------------------------------------------
            Case("wake file: a valid file parses; the key must match its public half", () =>
            {
                Waker phone = new Waker();
                byte[] seed = Random32();
                WakeFile ok = WakeRules.Parse(FileText(seed, phone));
                if (ok == null) return "valid file refused";
                if (ok.Pins.Count != 1 || ok.Pins[0].Fp != phone.Fp) return "pins";
                if (ok.Fp != WakeRules.FingerprintOf(Ed25519.PublicKey(seed))) return "fingerprint";
                string other = FileText(seed, phone).Replace(B64.Enc(Ed25519.PublicKey(seed)), B64.Enc(Ed25519.PublicKey(Random32())));
                return Ok(WakeRules.Parse(other) == null, "foreign public key accepted");
            });
            Case("wake file: wrong version, address, key, pins and size are refused", () =>
            {
                Waker phone = new Waker();
                string good = FileText(Random32(), phone);
                string[] bad =
                {
                    good.Replace("\"v\":1", "\"v\":2"), good.Replace("wss://meeting.example/autark", "https://meeting.example"), good.Replace("wss://meeting.example/autark", "wss://a b"),
                    good.Replace("wss://meeting.example/autark", "wss://"), good.Replace("\"pkcs8\":\"", "\"pkcs8\":\"AA"), FileText(Random32()), "{}", "[]", "nope",
                    good.Replace(phone.Fp, new string('0', 64)), good.Replace("\"pins\":[", "\"pins\":{\"x\":["), good + new string(' ', 70000),
                };
                foreach (string text in bad) if (WakeRules.Parse(text) != null) return "accepted: " + text.Substring(0, Math.Min(60, text.Length));
                return null;
            });

            // ---- the wake check -------------------------------------------------------------------------------------------------
            Case("wake check: a signed, fresh wake from a pin passes once; its nonce is then used up", () =>
            {
                World w = new World();
                object body = MiniJson.Parse(WakeBody(w.Phone, w.HelperFp, w.Core.BoxText, Now, "abcdefghijklmnop"));
                Dictionary<string, long> seen = new Dictionary<string, long>();
                return Ok(WakeRules.Check(body, w.Phone.Fp, w.File.Pins, w.HelperFp, w.Core.BoxText, Now, seen), "first")
                    ?? Ok(!WakeRules.Check(body, w.Phone.Fp, w.File.Pins, w.HelperFp, w.Core.BoxText, Now, seen), "replay");
            });
            Case("wake check: wrong sender, stale, future, other session, other helper, bad nonce and bad signature are refused", () =>
            {
                World w = new World();
                Dictionary<string, long> seen = new Dictionary<string, long>();
                Func<string, string, long, string, bool> check = (from, body, now, box) => WakeRules.Check(MiniJson.Parse(body), from, w.File.Pins, w.HelperFp, box, now, seen);
                string box0 = w.Core.BoxText;
                if (check(w.Stranger.Fp, WakeBody(w.Stranger, w.HelperFp, box0, Now, "strangerstrangerstranger"), Now, box0)) return "a key that is no pin";
                if (check(w.Phone.Fp, WakeBody(w.Stranger, w.HelperFp, box0, Now, "foreignsigforeignsig1"), Now, box0)) return "a pin's name with another key's signature";
                if (check(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, box0, Now - 61000, "stalestalestalestale"), Now, box0)) return "61 s old";
                if (check(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, box0, Now + 61000, "futurefuturefuture12"), Now, box0)) return "61 s in the future";
                if (check(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, new PairBox().PubText, Now, "otherboxotherbox1234"), Now, box0)) return "another session's box";
                if (check(w.Phone.Fp, WakeBody(w.Phone, WakeRules.FingerprintOf(Random32()), box0, Now, "otherhelperotherhelp"), Now, box0)) return "another helper's key";
                if (check(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, box0, Now, "short"), Now, box0)) return "a short nonce";
                if (check(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, box0, Now, "bad nonce with spaces!"), Now, box0)) return "a nonce with other characters";
                string noSig = "{\"op\":\"wake\",\"at\":" + Now + ",\"nonce\":\"nosignaturenosignature\"}";
                if (check(w.Phone.Fp, noSig, Now, box0)) return "unsigned";
                string junkSig = "{\"op\":\"wake\",\"at\":" + Now + ",\"nonce\":\"junksigjunksigjunksig\",\"sig\":\"AAAA\"}";
                if (check(w.Phone.Fp, junkSig, Now, box0)) return "junk signature";
                string noOp = WakeBody(w.Phone, w.HelperFp, box0, Now, "noopnoopnoopnoopnoop").Replace("\"op\":\"wake\"", "\"op\":\"run\"");
                if (check(w.Phone.Fp, noOp, Now, box0)) return "another op";
                if (check(null, WakeBody(w.Phone, w.HelperFp, box0, Now, "nullfromnullfromnull"), Now, box0)) return "no sender";
                if (!check(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, box0, Now - 59000, "justinsidethewindow1"), Now, box0)) return "59 s old must pass";
                return null;
            });
            Case("wake check: the signed time must be a number that prints the way the sender printed it", () =>
            {
                World w = new World();
                Dictionary<string, long> seen = new Dictionary<string, long>();
                string body = WakeBody(w.Phone, w.HelperFp, w.Core.BoxText, Now, "texttexttexttexttext").Replace("\"at\":" + Now, "\"at\":\"" + Now + "\"");
                return Ok(!WakeRules.Check(MiniJson.Parse(body), w.Phone.Fp, w.File.Pins, w.HelperFp, w.Core.BoxText, Now, seen), "a time as text");
            });
            Case("wake check: the nonce memory is bounded", () =>
            {
                World w = new World();
                Dictionary<string, long> seen = new Dictionary<string, long>();
                for (int i = 0; i < 1000; i++)
                {
                    string nonce = "bounded-" + i.ToString("D10", CultureInfo.InvariantCulture);
                    WakeRules.Check(MiniJson.Parse(WakeBody(w.Phone, w.HelperFp, w.Core.BoxText, Now, nonce)), w.Phone.Fp, w.File.Pins, w.HelperFp, w.Core.BoxText, Now, seen);
                }
                return Ok(seen.Count <= 256, "grew to " + seen.Count);
            });

            // ---- throttle ------------------------------------------------------------------------------------------------------
            Case("throttle: a burst of 6, then one per 5 s", () =>
            {
                Throttle t = new Throttle(6, 5000);
                for (int i = 0; i < 6; i++) if (!t.Take(Now)) return "burst " + i;
                if (t.Take(Now)) return "7th at once";
                if (t.Take(Now + 4000)) return "after 4 s";
                if (!t.Take(Now + 5000)) return "after 5 s";
                if (t.Take(Now + 5001)) return "again at once";
                return t.Take(Now + 60000) ? null : "after a minute";
            });

            // ---- the helper's decision per frame ------------------------------------------------------------------------------------
            Case("core: a challenge is answered with hello – signed with the helper key, findable, no peers, box signed", () =>
            {
                World w = new World();
                bool woke;
                string reply = w.Core.OnFrame("{\"t\":\"challenge\",\"n\":\"c0ffee\"}", out woke);
                if (reply == null || woke) return "no hello";
                Dictionary<string, object> hello = (Dictionary<string, object>)MiniJson.Parse(reply);
                byte[] pub = B64.Dec((string)hello["pub"]);
                return Expect(hello["t"], "hello", "t") ?? Expect(hello["v"], 1.0, "v") ?? Expect(hello["findable"], true, "findable") ?? Expect(((List<object>)hello["peers"]).Count, 0, "peers")
                    ?? Expect(hello["box"], w.Core.BoxText, "box")
                    ?? Ok(WakeRules.SameBytes(pub, w.File.Pub), "pub")
                    ?? Ok(Ed25519.Verify(pub, Utf8("wf-relay-v1|hello|c0ffee"), B64.Dec((string)hello["sig"])), "hello signature")
                    ?? Ok(Ed25519.Verify(pub, Utf8("wf-relay-v1|box|" + w.Core.BoxText), B64.Dec((string)hello["boxSig"])), "box signature");
            });
            Case("core: a challenge without a nonce or with a long one is not answered; ready sets ready", () =>
            {
                World w = new World();
                bool woke;
                if (w.Core.OnFrame("{\"t\":\"challenge\"}", out woke) != null) return "no nonce";
                if (w.Core.OnFrame("{\"t\":\"challenge\",\"n\":\"" + new string('a', 65) + "\"}", out woke) != null) return "long nonce";
                if (w.Core.Ready) return "ready too early";
                w.Core.OnFrame("{\"t\":\"ready\"}", out woke);
                return Ok(w.Core.Ready, "ready");
            });
            Case("core: a real wake is taken, answered with {ok:true} sealed under the relay's ref, and asks for the app start", () =>
            {
                World w = new World();
                PairCipher sender;
                bool woke;
                string reply = w.Core.OnFrame(w.Valid(out sender), out woke);
                if (!woke || reply == null) return "not taken";
                Dictionary<string, object> frame = (Dictionary<string, object>)MiniJson.Parse(reply);
                object answer = sender.OpenJson((string)frame["c"]);
                return Expect(frame["t"], "pairReply", "t") ?? Expect(frame["ref"], 7.0, "ref") ?? Ok(!frame.ContainsKey("error"), "no error")
                    ?? Expect(MiniJson.Write(((Dictionary<string, object>)answer)["ok"]), "true", "ok");
            });
            Case("core: a wake carrying a command, a path or parameters is taken like a plain one – nothing of it is read", () =>
            {
                World w = new World();
                PairCipher sender;
                bool woke;
                string reply = w.Core.OnFrame(w.Valid(out sender, ",\"exe\":\"C:\\\\Windows\\\\System32\\\\cmd.exe\",\"args\":[\"/c\",\"calc\"],\"cmd\":\"calc.exe\",\"company\":\"company-1\""), out woke);
                return Ok(woke && reply != null, "taken (its signature covers only time and nonce)");
            });
            Case("core: a repeated wake (same frame again, or the same nonce in a new seal) is dropped without an answer", () =>
            {
                World w = new World();
                PairCipher sender;
                string frame = w.Valid(out sender);
                bool woke;
                if (w.Core.OnFrame(frame, out woke) == null || !woke) return "first";
                w.Clock += 40000; // past the 30 s hold, inside the freshness window, before the throttle matters
                string again = Drop(w, frame);
                if (again != null) return "same frame: " + again;
                // the same signed body sealed again by the sender (same nonce)
                string nonce = "replayreplayreplay1";
                World w2 = new World();
                PairCipher c1, c2;
                string body = WakeBody(w2.Phone, w2.HelperFp, w2.Core.BoxText, Now, nonce);
                bool woke2;
                if (w2.Core.OnFrame(w2.Pair(w2.Phone.Fp, body, out c1), out woke2) == null || !woke2) return "first of the pair";
                w2.Clock += 40000;
                body = WakeBody(w2.Phone, w2.HelperFp, w2.Core.BoxText, Now, nonce); // fresh enough? at = Now, clock = Now+40 s
                return Drop(w2, w2.Pair(w2.Phone.Fp, body, out c2));
            });
            Case("core: after one accepted wake nothing else is taken for 30 s (throttle of repeated wakes)", () =>
            {
                World w = new World();
                PairCipher sender;
                bool woke;
                if (w.Core.OnFrame(w.Valid(out sender), out woke) == null || !woke) return "first";
                w.Clock += 10000;
                string held = Drop(w, w.Valid(out sender));
                if (held != null) return "within 30 s: " + held;
                w.Clock += 25000;
                return w.Core.OnFrame(w.Valid(out sender), out woke) != null && woke ? null : "after 30 s a new wake must be taken";
            });
            Case("core: everything that is no real wake is dropped without any answer", () =>
            {
                World w = new World();
                PairCipher c;
                string[] frames =
                {
                    // no pin
                    w.Pair(w.Stranger.Fp, WakeBody(w.Stranger, w.HelperFp, w.Core.BoxText, Now, NewNonce()), out c),
                    // pin's fingerprint but another key's signature
                    w.Pair(w.Phone.Fp, WakeBody(w.Stranger, w.HelperFp, w.Core.BoxText, Now, NewNonce()), out c),
                    // unsigned
                    w.Pair(w.Phone.Fp, "{\"op\":\"wake\",\"at\":" + Now + ",\"nonce\":\"" + NewNonce() + "\"}", out c),
                    // stale
                    w.Pair(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, w.Core.BoxText, Now - 120000, NewNonce()), out c),
                    // signed for another session's box
                    w.Pair(w.Phone.Fp, WakeBody(w.Phone, w.HelperFp, new PairBox().PubText, Now, NewNonce()), out c),
                    // not JSON, not an object, not a wake
                    w.Pair(w.Phone.Fp, "\"wake\"", out c), w.Pair(w.Phone.Fp, "{\"op\":\"run\",\"cmd\":\"calc\"}", out c),
                    // no sender, no e, no c, undecryptable c, a c that is not base64url
                    "{\"t\":\"pair\",\"ref\":1,\"e\":\"" + B64.Enc(Random32()) + "\",\"c\":\"AAAA\"}",
                    "{\"t\":\"pair\",\"ref\":1,\"from\":\"" + w.Phone.Fp + "\",\"c\":\"AAAA\"}",
                    "{\"t\":\"pair\",\"ref\":1,\"from\":\"" + w.Phone.Fp + "\",\"e\":\"" + B64.Enc(Random32()) + "\"}",
                    "{\"t\":\"pair\",\"ref\":1,\"from\":\"" + w.Phone.Fp + "\",\"e\":\"" + B64.Enc(Random32()) + "\",\"c\":\"" + B64.Enc(new byte[40]) + "\"}",
                    "{\"t\":\"pair\",\"ref\":1,\"from\":\"" + w.Phone.Fp + "\",\"e\":\"!!!\",\"c\":\"%%%\"}",
                    // other frame kinds and noise
                    "{\"t\":\"presence\",\"fp\":\"x\"}", "{\"t\":\"open\",\"tid\":1}", "{\"t\":\"incoming\",\"tid\":1,\"from\":\"" + w.Phone.Fp + "\"}", "{}", "[]", "nonsense", "",
                };
                foreach (string frame in frames)
                {
                    string result = Drop(w, frame);
                    if (result != null) return result + " for " + frame.Substring(0, Math.Min(70, frame.Length));
                }
                return null;
            });
            Case("core: a tampered sealed body and a wake sealed to another session are dropped", () =>
            {
                World w = new World();
                PairCipher c;
                string frame = w.Valid(out c);
                int at = frame.LastIndexOf("\"c\":\"", StringComparison.Ordinal) + 5;
                char flip = frame[at + 4] == 'A' ? 'B' : 'A';
                string tampered = frame.Substring(0, at + 4) + flip + frame.Substring(at + 5);
                string a = Drop(w, tampered);
                if (a != null) return "tampered: " + a;
                World other = new World();
                PairCipher c2;
                string foreign = other.Pair(other.Phone.Fp, WakeBody(other.Phone, other.HelperFp, other.Core.BoxText, Now, NewNonce()), out c2);
                return Drop(w, foreign);
            });
            Case("core: a flood from a pin is throttled before any crypto (burst 6, no answer), a flood from a stranger costs no token", () =>
            {
                World w = new World();
                PairCipher c;
                for (int i = 0; i < 50; i++)
                {
                    string noise = Drop(w, w.Pair(w.Stranger.Fp, WakeBody(w.Stranger, w.HelperFp, w.Core.BoxText, Now, NewNonce()), out c));
                    if (noise != null) return noise;
                }
                bool woke;
                // the pin's tokens are intact: a real wake still passes
                if (w.Core.OnFrame(w.Valid(out c), out woke) == null || !woke) return "stranger flood used the pin's tokens";
                World f = new World();
                for (int i = 0; i < 30; i++) Drop(f, f.Pair(f.Phone.Fp, WakeBody(f.Stranger, f.HelperFp, f.Core.BoxText, Now, NewNonce()), out c));
                // after the burst, even a real wake waits for the next token
                string late = Drop(f, f.Valid(out c));
                if (late != null) return "a real wake right after a flood of fakes must wait: " + late;
                f.Clock += 5000;
                return f.Core.OnFrame(f.Valid(out c), out woke) != null && woke ? null : "a token later it passes";
            });
            Case("core: a new session (reconnect) gets a new box key; the old session's wake no longer verifies", () =>
            {
                World w = new World();
                PairCipher c;
                string old = w.Valid(out c);
                w.Core.NewSession();
                return Drop(w, old);
            });

            // ---- life rules (sleeper-life.ts) ---------------------------------------------------------------------------------------
            Case("life: the app runs when run-state says running with a live pid (or without a pid)", () =>
            {
                Func<long, bool> alive = pid => pid == 42;
                return Ok(Life.AppRunning(RunStateFile.Parse("{\"state\":\"running\",\"pid\":42}"), alive), "live")
                    ?? Ok(!Life.AppRunning(RunStateFile.Parse("{\"state\":\"running\",\"pid\":43}"), alive), "dead pid after a Task Manager kill")
                    ?? Ok(Life.AppRunning(RunStateFile.Parse("{\"state\":\"running\"}"), alive), "no pid")
                    ?? Ok(!Life.AppRunning(RunStateFile.Parse("{\"state\":\"quit\",\"pid\":42}"), alive), "quit")
                    ?? Ok(!Life.AppRunning(null, alive), "no file") ?? Ok(!Life.AppRunning(RunStateFile.Parse("junk"), alive), "junk");
            });
            Case("life: another helper only counts when it lives and is not this process", () =>
                Ok(!Life.OtherHelper(null, 1, p => true), "no mark") ?? Ok(!Life.OtherHelper(5, 5, p => true), "own mark") ?? Ok(!Life.OtherHelper(6, 5, p => false), "dead") ?? Ok(Life.OtherHelper(6, 5, p => true), "live"));
            Case("life: due work – a future time waits at least 5 min after the start, a quit by the person keeps its settle time, a Task Manager kill recovers a due time", () =>
            {
                long start = Now;
                if (Life.DueStartAt(null, start, null) != null) return "no time";
                if (Life.DueStartAt(start - 1000.0, start, null) != null) return "past without state";
                if (Life.DueStartAt(start + 1000.0, start, null) != start + 300000.0) return "soon is pushed to the settle time";
                if (Life.DueStartAt(start + 3600000.0, start, null) != start + 3600000.0) return "far";
                RunStateFile quit = RunStateFile.Parse("{\"state\":\"quit\",\"by\":\"person\",\"at\":" + (start - 60000) + "}");
                if (Life.DueStartAt(start - 30000.0, start, quit) != (start - 60000) + 300000.0) return "a time between quit and start: " + Life.DueStartAt(start - 30000.0, start, quit);
                RunStateFile killed = RunStateFile.Parse("{\"state\":\"running\",\"at\":" + (start - 600000) + ",\"pid\":9}");
                if (Life.DueStartAt(start - 60000.0, start, killed) != start) return "recovery after a kill: " + Life.DueStartAt(start - 60000.0, start, killed);
                if (Life.DueStartAt(start - 300000.0, start, killed) != null) return "too old for the recovery window";
                if (Life.DueStartAt(start - 700000.0, start, killed) != null) return "before the run-state";
                return Expect(Life.DueDelay(start + 3600000.0, start), 900000L, "the longest single timer") ?? Expect(Life.DueDelay(start - 5.0, start), 0L, "never negative");
            });
            Case("life: command-line quoting follows CommandLineToArgvW", () =>
                Expect(Life.Quote("--company=company-2"), "--company=company-2", "plain") ?? Expect(Life.Quote("a b"), "\"a b\"", "space") ?? Expect(Life.Quote("a\"b"), "\"a\\\"b\"", "quote")
                    ?? Expect(Life.Quote("a b\\"), "\"a b\\\\\"", "trailing backslash") ?? Expect(Life.Quote(""), "\"\"", "empty"));

            Console.WriteLine(failed == 0 ? "ALL PASS" : failed + " FAILED");
            return failed == 0 ? 0 : 1;
        }
    }
}
