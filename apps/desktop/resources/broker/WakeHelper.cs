// Slim wake helper for Windows (Autark 0.3.22): the small program the desktop broker keeps alive for the signed-in person while
// the app is closed, instead of Autark.exe running as Node on app/sleeper.mjs (113 MB working set, 54 MB private bytes).
// It speaks exactly the protocol of runtime/devices/sleeper.ts + sleeper-main.ts and reads the same files:
//   <data>\wake.json      the meeting server's address, the helper's own Ed25519 key (low value: it can only stand at the meeting
//                         server and hear wakes) and the pins (the public keys of my own linked PCs and paired phones)
//   <data>\run-state.json the app's own mark ('running' + a live pid ends this helper; the app is up)
//   <data>\next-due.json  when scheduled work is due (the helper starts the app with --background then)
//   <data>\sleeper.json   this helper's pid while it runs (one helper per data folder; the broker reads it)
//   <data>\logs\sleeper.log  its few lines, never a key.
// One outbound WebSocket to the meeting server under the helper's key: signed challenge -> hello (findable, no peers) -> ready;
// then it takes one kind of message: a sealed 'pair' request from a pinned key that carries a wake – fresh (60 s), once per nonce,
// with the pin's Ed25519 signature over this helper's key, this session's box key, the time and the nonce (wf-wake-v1|...).
// Command line: AutarkWakeHelper.exe <data>\wake.json --app <path to Autark.exe> -- <the app's own start arguments>
//
// What a wake can do (Konrad's rules, 27.11.2026):
//  1. Exactly one thing: start THE registered app (--app, set by the broker from the registration) for the signed-in person,
//     with the registered arguments. The wake takes no parameter, path or command: only op, at, nonce and sig are read.
//  2. Only real wakes count: a sender that is no pin, a body that does not open, a bad or foreign signature, a stale or repeated
//     wake is dropped WITHOUT any answer (the old helper answered 'forbidden'/'stale'). Work for pinned senders is throttled
//     (a burst of 6, then one per 5 s), and after one accepted wake nothing else is taken for 30 s.
//  3. Windows only. Mac and Linux have no broker and keep the Node helper (launchd / systemd --user); the broker falls back to
//     the Node helper when this program is missing or does not start.
// Memory: no JSON/crypto package, no ClientWebSocket, no regex, no LINQ; one thread reads the socket (read timeout 90 s = the old
// watchdog: the server pings every 30 s), a timer for due work, a directory watch for run-state.json. Ed25519/X25519 are done with
// System.Numerics.BigInteger (the .NET Framework has neither), AES-256-GCM with CNG, the rest is the framework's SHA-2/HMAC.
// Ed25519 and X25519 here are not constant-time: the helper signs only its own hello at the meeting server and never a message
// chosen by someone else's timing.
//
// Owns: the helper process (its file reading, mark, relay connection, wake decision, app start and end).
// Never: runs elevated or as SYSTEM, opens a port, runs a command from a wake, starts anything but the registered app, writes
// outside <data>, or logs a key.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Security;
using System.Net.Sockets;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace AutarkWake
{
    // =============================================================== JSON (just enough)

    public static class MiniJson
    {
        const int MaxDepth = 24;

        /// Objects -> Dictionary&lt;string,object&gt;, arrays -> List&lt;object&gt;, numbers -> double, plus string, bool, null. Throws FormatException.
        public static object Parse(string text)
        {
            if (text == null) throw new FormatException("null");
            int i = 0;
            object value = Value(text, ref i, 0);
            Space(text, ref i);
            if (i != text.Length) throw new FormatException("trailing");
            return value;
        }

        static void Space(string s, ref int i) { while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; }

        static object Value(string s, ref int i, int depth)
        {
            if (depth > MaxDepth) throw new FormatException("deep");
            Space(s, ref i);
            if (i >= s.Length) throw new FormatException("end");
            char c = s[i];
            if (c == '{')
            {
                i++;
                Dictionary<string, object> map = new Dictionary<string, object>();
                Space(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return map; }
                while (true)
                {
                    Space(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new FormatException("key");
                    string key = Str(s, ref i);
                    Space(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("colon");
                    i++;
                    map[key] = Value(s, ref i, depth + 1);
                    Space(s, ref i);
                    if (i >= s.Length) throw new FormatException("end");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return map; }
                    throw new FormatException("object");
                }
            }
            if (c == '[')
            {
                i++;
                List<object> list = new List<object>();
                Space(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(Value(s, ref i, depth + 1));
                    Space(s, ref i);
                    if (i >= s.Length) throw new FormatException("end");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return list; }
                    throw new FormatException("array");
                }
            }
            if (c == '"') return Str(s, ref i);
            if (Word(s, ref i, "true")) return true;
            if (Word(s, ref i, "false")) return false;
            if (Word(s, ref i, "null")) return null;
            int start = i;
            if (i < s.Length && s[i] == '-') i++;
            while (i < s.Length && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) i++;
            double number;
            if (i == start || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out number)) throw new FormatException("value");
            return number;
        }

        static bool Word(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        static string Str(string s, ref int i)
        {
            i++; // the opening quote
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw new FormatException("string");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c < ' ') throw new FormatException("control");
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) throw new FormatException("escape");
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("unicode");
                        int code;
                        if (!int.TryParse(s.Substring(i, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw new FormatException("unicode");
                        sb.Append((char)code);
                        i += 4;
                        break;
                    default: throw new FormatException("escape");
                }
            }
        }

        public static string Quote(string s)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        /// A parsed value back to text (used to echo the relay's own `ref`).
        public static string Write(object value)
        {
            if (value == null) return "null";
            string text = value as string;
            if (text != null) return Quote(text);
            if (value is bool) return (bool)value ? "true" : "false";
            if (value is double) return Number((double)value);
            return "null";
        }

        /// A number the way JavaScript prints it for the integers that matter here (no exponent, no fraction).
        public static string Number(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
            if (d == Math.Floor(d) && Math.Abs(d) < 9e15) return ((long)d).ToString(CultureInfo.InvariantCulture);
            return d.ToString("R", CultureInfo.InvariantCulture);
        }

        public static string Str(Dictionary<string, object> map, string key)
        {
            object v;
            return map != null && map.TryGetValue(key, out v) ? v as string : null;
        }

        public static double? Num(Dictionary<string, object> map, string key)
        {
            object v;
            if (map != null && map.TryGetValue(key, out v) && v is double) return (double)v;
            return null;
        }
    }

    // =============================================================== base64url

    public static class B64
    {
        public static string Enc(byte[] data) { return Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }

        public static bool Charset(string s)
        {
            if (s == null || s.Length == 0) return false;
            foreach (char c in s) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
            return true;
        }

        /// Strict: only the base64url alphabet; throws FormatException otherwise.
        public static byte[] Dec(string s)
        {
            if (!Charset(s) || s.Length % 4 == 1) throw new FormatException("base64url");
            string t = s.Replace('-', '+').Replace('_', '/');
            while (t.Length % 4 != 0) t += "=";
            return Convert.FromBase64String(t);
        }

        public static string Hex(byte[] data)
        {
            StringBuilder sb = new StringBuilder(data.Length * 2);
            foreach (byte b in data) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }

    // =============================================================== Ed25519 (RFC 8032) and X25519 (RFC 7748)

    public static class Ed25519
    {
        static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
        static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493", CultureInfo.InvariantCulture);
        static readonly BigInteger D = Mod(-121665 * Inv(121666));
        static readonly BigInteger SqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);
        static readonly Pt G = Base();

        sealed class Pt
        {
            public BigInteger X, Y, Z, T;
            public Pt(BigInteger x, BigInteger y, BigInteger z, BigInteger t) { X = x; Y = y; Z = z; T = t; }
        }

        static BigInteger Mod(BigInteger a) { a = a % P; return a.Sign < 0 ? a + P : a; }
        static BigInteger Inv(BigInteger a) { return BigInteger.ModPow(Mod(a), P - 2, P); }

        static BigInteger Le(byte[] data, int offset, int count)
        {
            byte[] tmp = new byte[count + 1];
            Buffer.BlockCopy(data, offset, tmp, 0, count);
            return new BigInteger(tmp);
        }

        static byte[] Le32(BigInteger v)
        {
            byte[] raw = v.ToByteArray();
            byte[] outBytes = new byte[32];
            Buffer.BlockCopy(raw, 0, outBytes, 0, Math.Min(raw.Length, 32));
            return outBytes;
        }

        static BigInteger? RecoverX(BigInteger y, int sign)
        {
            if (y >= P) return null;
            BigInteger x2 = Mod((y * y - 1) * Inv(D * y * y + 1));
            if (x2.IsZero) return sign == 1 ? (BigInteger?)null : BigInteger.Zero;
            BigInteger x = BigInteger.ModPow(x2, (P + 3) / 8, P);
            if (!Mod(x * x - x2).IsZero) x = Mod(x * SqrtM1);
            if (!Mod(x * x - x2).IsZero) return null;
            if ((x.IsEven ? 0 : 1) != sign) x = P - x;
            return x;
        }

        static Pt Base()
        {
            BigInteger gy = Mod(4 * Inv(5));
            BigInteger gx = RecoverX(gy, 0).Value;
            return new Pt(gx, gy, 1, Mod(gx * gy));
        }

        static Pt Add(Pt p, Pt q)
        {
            BigInteger a = Mod((p.Y - p.X) * (q.Y - q.X));
            BigInteger b = Mod((p.Y + p.X) * (q.Y + q.X));
            BigInteger c = Mod(p.T * 2 * D * q.T);
            BigInteger d = Mod(p.Z * 2 * q.Z);
            BigInteger e = b - a, f = d - c, g = d + c, h = b + a;
            return new Pt(Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h));
        }

        static Pt Mul(BigInteger s, Pt p)
        {
            Pt q = new Pt(0, 1, 1, 0);
            while (s.Sign > 0)
            {
                if (!s.IsEven) q = Add(q, p);
                p = Add(p, p);
                s >>= 1;
            }
            return q;
        }

        static bool Equal(Pt p, Pt q)
        {
            return Mod(p.X * q.Z - q.X * p.Z).IsZero && Mod(p.Y * q.Z - q.Y * p.Z).IsZero;
        }

        static byte[] Compress(Pt p)
        {
            BigInteger zinv = Inv(p.Z);
            BigInteger x = Mod(p.X * zinv), y = Mod(p.Y * zinv);
            byte[] bytes = Le32(y);
            if (!x.IsEven) bytes[31] |= 0x80;
            return bytes;
        }

        static Pt Decompress(byte[] data)
        {
            if (data == null || data.Length != 32) return null;
            byte[] copy = (byte[])data.Clone();
            int sign = copy[31] >> 7;
            copy[31] &= 0x7f;
            BigInteger y = Le(copy, 0, 32);
            BigInteger? x = RecoverX(y, sign);
            if (x == null) return null;
            return new Pt(x.Value, y, 1, Mod(x.Value * y));
        }

        static byte[] Sha512(params byte[][] parts)
        {
            using (SHA512 sha = SHA512.Create())
            {
                MemoryStream all = new MemoryStream();
                foreach (byte[] part in parts) all.Write(part, 0, part.Length);
                return sha.ComputeHash(all.ToArray());
            }
        }

        static BigInteger Scalar(byte[] hash) { return Le(hash, 0, hash.Length) % L; }

        static BigInteger Secret(byte[] h)
        {
            byte[] a = new byte[32];
            Buffer.BlockCopy(h, 0, a, 0, 32);
            a[0] &= 248; a[31] &= 127; a[31] |= 64;
            return Le(a, 0, 32);
        }

        /// The public key (32 bytes) of a 32-byte seed.
        public static byte[] PublicKey(byte[] seed) { return Compress(Mul(Secret(Sha512(seed)), G)); }

        /// A signature (64 bytes, RFC 8032 pure Ed25519).
        public static byte[] Sign(byte[] seed, byte[] message)
        {
            byte[] h = Sha512(seed);
            BigInteger a = Secret(h);
            byte[] prefix = new byte[32];
            Buffer.BlockCopy(h, 32, prefix, 0, 32);
            byte[] pub = Compress(Mul(a, G));
            BigInteger r = Scalar(Sha512(prefix, message));
            byte[] rEnc = Compress(Mul(r, G));
            BigInteger k = Scalar(Sha512(rEnc, pub, message));
            BigInteger s = (r + k * a) % L;
            byte[] sig = new byte[64];
            Buffer.BlockCopy(rEnc, 0, sig, 0, 32);
            Buffer.BlockCopy(Le32(s), 0, sig, 32, 32);
            return sig;
        }

        /// True only for a valid signature by `pub` (canonical encodings, S below the group order).
        public static bool Verify(byte[] pub, byte[] message, byte[] sig)
        {
            try
            {
                if (pub == null || pub.Length != 32 || sig == null || sig.Length != 64) return false;
                Pt a = Decompress(pub);
                byte[] rBytes = new byte[32];
                Buffer.BlockCopy(sig, 0, rBytes, 0, 32);
                Pt r = Decompress(rBytes);
                if (a == null || r == null) return false;
                BigInteger s = Le(sig, 32, 32);
                if (s >= L) return false;
                BigInteger h = Scalar(Sha512(rBytes, pub, message));
                return Equal(Mul(s, G), Add(r, Mul(h, a)));
            }
            catch (Exception) { return false; }
        }
    }

    public static class X25519
    {
        static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;

        static BigInteger Mod(BigInteger a) { a = a % P; return a.Sign < 0 ? a + P : a; }

        /// k * u on Curve25519 (RFC 7748); 32 bytes in, 32 bytes out.
        public static byte[] Scalar(byte[] k, byte[] u)
        {
            byte[] kk = (byte[])k.Clone();
            kk[0] &= 248; kk[31] &= 127; kk[31] |= 64;
            byte[] ub = (byte[])u.Clone();
            ub[31] &= 127;
            BigInteger kn = new BigInteger(Concat0(kk));
            BigInteger x1 = Mod(new BigInteger(Concat0(ub)));
            BigInteger x2 = 1, z2 = 0, x3 = x1, z3 = 1;
            bool swap = false;
            BigInteger a24 = 121665;
            for (int t = 254; t >= 0; t--)
            {
                bool kt = !((kn >> t) & 1).IsZero;
                if (swap != kt) { BigInteger tmp = x2; x2 = x3; x3 = tmp; tmp = z2; z2 = z3; z3 = tmp; }
                swap = kt;
                BigInteger a = Mod(x2 + z2), aa = Mod(a * a), b = Mod(x2 - z2), bb = Mod(b * b), e = Mod(aa - bb);
                BigInteger c = Mod(x3 + z3), d = Mod(x3 - z3), da = Mod(d * a), cb = Mod(c * b);
                BigInteger s = Mod(da + cb), df = Mod(da - cb);
                x3 = Mod(s * s);
                z3 = Mod(x1 * Mod(df * df));
                x2 = Mod(aa * bb);
                z2 = Mod(e * Mod(aa + a24 * e));
            }
            if (swap) { BigInteger tmp = x2; x2 = x3; x3 = tmp; tmp = z2; z2 = z3; z3 = tmp; }
            BigInteger result = Mod(x2 * BigInteger.ModPow(Mod(z2), P - 2, P));
            byte[] raw = result.ToByteArray();
            byte[] outBytes = new byte[32];
            Buffer.BlockCopy(raw, 0, outBytes, 0, Math.Min(raw.Length, 32));
            return outBytes;
        }

        static byte[] Concat0(byte[] data)
        {
            byte[] tmp = new byte[data.Length + 1];
            Buffer.BlockCopy(data, 0, tmp, 0, data.Length);
            return tmp;
        }

        public static byte[] Public(byte[] priv)
        {
            byte[] nine = new byte[32];
            nine[0] = 9;
            return Scalar(priv, nine);
        }

        public static bool AllZero(byte[] data)
        {
            byte acc = 0;
            foreach (byte b in data) acc |= b;
            return acc == 0;
        }
    }

    // =============================================================== HKDF and AES-256-GCM

    public static class Kdf
    {
        /// HKDF-SHA256 (RFC 5869): `length` bytes.
        public static byte[] Hkdf(byte[] ikm, byte[] salt, byte[] info, int length)
        {
            byte[] prk;
            using (HMACSHA256 extract = new HMACSHA256(salt)) prk = extract.ComputeHash(ikm);
            byte[] okm = new byte[length];
            byte[] previous = new byte[0];
            int done = 0;
            byte counter = 1;
            using (HMACSHA256 expand = new HMACSHA256(prk))
            {
                while (done < length)
                {
                    MemoryStream block = new MemoryStream();
                    block.Write(previous, 0, previous.Length);
                    block.Write(info, 0, info.Length);
                    block.WriteByte(counter++);
                    previous = expand.ComputeHash(block.ToArray());
                    int take = Math.Min(previous.Length, length - done);
                    Buffer.BlockCopy(previous, 0, okm, done, take);
                    done += take;
                }
            }
            return okm;
        }
    }

    /// AES-256-GCM through CNG (bcrypt.dll): 12-byte nonce, 16-byte tag, no associated data.
    public static class Gcm
    {
        [StructLayout(LayoutKind.Sequential)]
        struct AuthInfo
        {
            public int cbSize, dwInfoVersion;
            public IntPtr pbNonce; public int cbNonce;
            public IntPtr pbAuthData; public int cbAuthData;
            public IntPtr pbTag; public int cbTag;
            public IntPtr pbMacContext; public int cbMacContext;
            public int cbAAD; public long cbData; public int dwFlags;
        }

        [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern uint BCryptOpenAlgorithmProvider(out IntPtr alg, string id, string impl, uint flags);
        [DllImport("bcrypt.dll")] static extern uint BCryptCloseAlgorithmProvider(IntPtr alg, uint flags);
        [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern uint BCryptSetProperty(IntPtr obj, string property, byte[] input, int size, uint flags);
        [DllImport("bcrypt.dll")] static extern uint BCryptGenerateSymmetricKey(IntPtr alg, out IntPtr key, IntPtr keyObject, int keyObjectSize, byte[] secret, int secretSize, uint flags);
        [DllImport("bcrypt.dll")] static extern uint BCryptDestroyKey(IntPtr key);
        [DllImport("bcrypt.dll")] static extern uint BCryptEncrypt(IntPtr key, byte[] input, int inputSize, ref AuthInfo info, byte[] iv, int ivSize, byte[] output, int outputSize, out int result, uint flags);
        [DllImport("bcrypt.dll")] static extern uint BCryptDecrypt(IntPtr key, byte[] input, int inputSize, ref AuthInfo info, byte[] iv, int ivSize, byte[] output, int outputSize, out int result, uint flags);

        static IntPtr Key(byte[] key, out IntPtr alg)
        {
            alg = IntPtr.Zero;
            IntPtr handle = IntPtr.Zero;
            if (BCryptOpenAlgorithmProvider(out alg, "AES", null, 0) != 0) throw new CryptographicException("aes");
            byte[] mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            if (BCryptSetProperty(alg, "ChainingMode", mode, mode.Length, 0) != 0 || BCryptGenerateSymmetricKey(alg, out handle, IntPtr.Zero, 0, key, key.Length, 0) != 0)
            {
                BCryptCloseAlgorithmProvider(alg, 0);
                throw new CryptographicException("gcm");
            }
            return handle;
        }

        /// ciphertext || tag.
        public static byte[] Seal(byte[] key, byte[] nonce, byte[] plain)
        {
            IntPtr alg, handle = Key(key, out alg);
            GCHandle n = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            byte[] tag = new byte[16];
            GCHandle t = GCHandle.Alloc(tag, GCHandleType.Pinned);
            try
            {
                AuthInfo info = new AuthInfo();
                info.cbSize = Marshal.SizeOf(typeof(AuthInfo)); info.dwInfoVersion = 1;
                info.pbNonce = n.AddrOfPinnedObject(); info.cbNonce = nonce.Length;
                info.pbTag = t.AddrOfPinnedObject(); info.cbTag = 16;
                byte[] cipher = new byte[plain.Length];
                int written;
                if (BCryptEncrypt(handle, plain, plain.Length, ref info, null, 0, cipher, cipher.Length, out written, 0) != 0) throw new CryptographicException("seal");
                byte[] all = new byte[cipher.Length + 16];
                Buffer.BlockCopy(cipher, 0, all, 0, cipher.Length);
                Buffer.BlockCopy(tag, 0, all, cipher.Length, 16);
                return all;
            }
            finally { n.Free(); t.Free(); BCryptDestroyKey(handle); BCryptCloseAlgorithmProvider(alg, 0); }
        }

        /// The plain bytes, or null when the tag does not match.
        public static byte[] Open(byte[] key, byte[] nonce, byte[] frame)
        {
            if (frame == null || frame.Length < 16) return null;
            IntPtr alg, handle = Key(key, out alg);
            byte[] cipher = new byte[frame.Length - 16];
            byte[] tag = new byte[16];
            Buffer.BlockCopy(frame, 0, cipher, 0, cipher.Length);
            Buffer.BlockCopy(frame, cipher.Length, tag, 0, 16);
            GCHandle n = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            GCHandle t = GCHandle.Alloc(tag, GCHandleType.Pinned);
            try
            {
                AuthInfo info = new AuthInfo();
                info.cbSize = Marshal.SizeOf(typeof(AuthInfo)); info.dwInfoVersion = 1;
                info.pbNonce = n.AddrOfPinnedObject(); info.cbNonce = nonce.Length;
                info.pbTag = t.AddrOfPinnedObject(); info.cbTag = 16;
                byte[] plain = new byte[cipher.Length];
                int written;
                return BCryptDecrypt(handle, cipher, cipher.Length, ref info, null, 0, plain, plain.Length, out written, 0) == 0 ? plain : null;
            }
            finally { n.Free(); t.Free(); BCryptDestroyKey(handle); BCryptCloseAlgorithmProvider(alg, 0); }
        }
    }

    // =============================================================== sealing (runtime/devices/rendezvous/seal.ts)

    /// The helper's per-session box key and the one cipher of a sealed 'pair' request (counters: one message each way).
    public sealed class PairBox
    {
        public const string PairInfo = "wf-relay-pair-v1";
        readonly byte[] priv = new byte[32];
        public readonly byte[] Pub;
        public readonly string PubText;

        public PairBox()
        {
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(priv);
            Pub = X25519.Public(priv);
            PubText = B64.Enc(Pub);
        }

        /// The cipher for a sender's ephemeral key `e`, or null when `e` is malformed.
        public PairCipher FromSender(string e, string info)
        {
            try
            {
                if (e == null || e.Length > 64) return null;
                byte[] eRaw = B64.Dec(e);
                if (eRaw.Length != 32) return null;
                byte[] shared = X25519.Scalar(priv, eRaw);
                if (X25519.AllZero(shared)) return null;
                byte[] salt = new byte[64];
                Buffer.BlockCopy(eRaw, 0, salt, 0, 32);
                Buffer.BlockCopy(Pub, 0, salt, 32, 32);
                byte[] okm = Kdf.Hkdf(shared, salt, Encoding.UTF8.GetBytes(info), 64);
                byte[] toOwner = new byte[32], toOpener = new byte[32];
                Buffer.BlockCopy(okm, 0, toOwner, 0, 32);
                Buffer.BlockCopy(okm, 32, toOpener, 0, 32);
                return new PairCipher(toOpener, toOwner);
            }
            catch (Exception) { return null; }
        }
    }

    public sealed class PairCipher
    {
        readonly byte[] sendKey, receiveKey;
        long sent, received;
        public PairCipher(byte[] sendKey, byte[] receiveKey) { this.sendKey = sendKey; this.receiveKey = receiveKey; }

        static byte[] Nonce(long counter)
        {
            byte[] n = new byte[12];
            for (int i = 0; i < 8; i++) n[11 - i] = (byte)(counter >> (8 * i));
            return n;
        }

        public byte[] Seal(byte[] plain) { return Gcm.Seal(sendKey, Nonce(sent++), plain); }

        public byte[] Open(byte[] frame)
        {
            if (frame == null || frame.Length < 16) return null;
            byte[] plain = Gcm.Open(receiveKey, Nonce(received), frame);
            if (plain != null) received++;
            return plain;
        }

        /// The JSON body of a sealed text, or null (too long, tampered, not JSON).
        public object OpenJson(string sealedText)
        {
            if (sealedText == null || sealedText.Length > 22000) return null;
            try
            {
                byte[] plain = Open(B64.Dec(sealedText));
                return plain == null ? null : MiniJson.Parse(Encoding.UTF8.GetString(plain));
            }
            catch (Exception) { return null; }
        }

        public string SealText(string json) { return B64.Enc(Seal(Encoding.UTF8.GetBytes(json))); }
    }

    // =============================================================== the file and the decision

    public sealed class WakePin { public string Fp; public byte[] Pub; }

    public sealed class WakeFile
    {
        public string Relay;
        public byte[] Seed;
        public string PubText;
        public byte[] Pub;
        public string Fp;
        public List<WakePin> Pins = new List<WakePin>();
    }

    public static class WakeRules
    {
        public const long FreshMs = 60000;
        public const int MaxPins = 64;
        public const int MaxFileBytes = 64 * 1024;
        static readonly byte[] Pkcs8Prefix = new byte[] { 0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20 };

        public static string FingerprintOf(byte[] pub)
        {
            using (SHA256 sha = SHA256.Create()) return B64.Hex(sha.ComputeHash(pub));
        }

        static bool IsFp(string s)
        {
            if (s == null || s.Length != 64) return false;
            foreach (char c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        static byte[] Key32(object value)
        {
            string s = value as string;
            if (s == null || s.Length > 64 || !B64.Charset(s)) return null;
            try { byte[] raw = B64.Dec(s); return raw.Length == 32 ? raw : null; } catch (Exception) { return null; }
        }

        /// ^wss?://\S{1,300}$
        public static bool IsRelayUrl(string s)
        {
            if (s == null) return false;
            int at = s.StartsWith("wss://", StringComparison.Ordinal) ? 6 : s.StartsWith("ws://", StringComparison.Ordinal) ? 5 : -1;
            if (at < 0) return false;
            int rest = s.Length - at;
            if (rest < 1 || rest > 300) return false;
            for (int i = at; i < s.Length; i++) if (char.IsWhiteSpace(s[i])) return false;
            return true;
        }

        /// The helper's file as far as it is valid (null: no wake helper for this PC). Same rules as wake-sign.ts parseWakeFile; on top the
        /// private key must be Ed25519 and belong to the public key it names.
        public static WakeFile Parse(string text)
        {
            if (text == null || text.Length > MaxFileBytes) return null;
            Dictionary<string, object> map;
            try { map = MiniJson.Parse(text) as Dictionary<string, object>; } catch (Exception) { return null; }
            if (map == null) return null;
            double? version = MiniJson.Num(map, "v");
            string relay = MiniJson.Str(map, "relay");
            if (version != 1 || !IsRelayUrl(relay)) return null;
            object keyObject;
            Dictionary<string, object> key = map.TryGetValue("key", out keyObject) ? keyObject as Dictionary<string, object> : null;
            if (key == null) return null;
            object pubObject;
            key.TryGetValue("pub", out pubObject);
            byte[] pub = Key32(pubObject);
            string pkcs8 = MiniJson.Str(key, "pkcs8");
            if (pub == null || pkcs8 == null || pkcs8.Length > 200) return null;
            byte[] der;
            try { der = Convert.FromBase64String(pkcs8); } catch (Exception) { return null; }
            if (der.Length != 48) return null;
            for (int i = 0; i < Pkcs8Prefix.Length; i++) if (der[i] != Pkcs8Prefix[i]) return null;
            byte[] seed = new byte[32];
            Buffer.BlockCopy(der, 16, seed, 0, 32);
            byte[] derived = Ed25519.PublicKey(seed);
            if (!SameBytes(derived, pub)) return null;
            object pinsObject;
            List<object> pinList = map.TryGetValue("pins", out pinsObject) ? pinsObject as List<object> : null;
            if (pinList == null) return null;
            WakeFile file = new WakeFile();
            file.Relay = relay; file.Seed = seed; file.Pub = pub; file.PubText = B64.Enc(pub); file.Fp = FingerprintOf(pub);
            foreach (object item in pinList)
            {
                Dictionary<string, object> pin = item as Dictionary<string, object>;
                if (pin == null) continue;
                string fp = MiniJson.Str(pin, "fp");
                object pinPub;
                pin.TryGetValue("pub", out pinPub);
                byte[] raw = Key32(pinPub);
                if (!IsFp(fp) || raw == null || FingerprintOf(raw) != fp) continue;
                WakePin entry = new WakePin();
                entry.Fp = fp; entry.Pub = raw;
                file.Pins.Add(entry);
                if (file.Pins.Count >= MaxPins) break;
            }
            return file.Pins.Count > 0 ? file : null;
        }

        public static bool SameBytes(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        /// What a waker signs (shared/model/wake.ts wakeText).
        public static string WakeText(string wakeFp, string box, string at, string nonce) { return "wf-wake-v1|" + wakeFp + "|" + box + "|" + at + "|" + nonce; }

        static bool NonceOk(string nonce)
        {
            if (nonce == null || nonce.Length < 16 || nonce.Length > 64) return false;
            return B64.Charset(nonce);
        }

        /// The helper's check (wake-sign.ts checkWake): a wake body from the relay's sender `from`, signed by that pin's key over this
        /// session (`wakeFp`, `box`), fresh, with a nonce not seen before. Records the nonce when it passes. `seen`: nonce -> time.
        public static bool Check(object body, string from, IList<WakePin> pins, string wakeFp, string box, long nowMs, Dictionary<string, long> seen)
        {
            Dictionary<string, object> o = body as Dictionary<string, object>;
            if (o == null || from == null) return false;
            WakePin pin = null;
            foreach (WakePin candidate in pins) if (string.Equals(candidate.Fp, from, StringComparison.Ordinal)) { pin = candidate; break; }
            if (pin == null || MiniJson.Str(o, "op") != "wake") return false;
            double? at = MiniJson.Num(o, "at");
            if (at == null || double.IsNaN(at.Value) || double.IsInfinity(at.Value) || Math.Abs(nowMs - at.Value) > FreshMs) return false;
            string nonce = MiniJson.Str(o, "nonce");
            string sig = MiniJson.Str(o, "sig");
            if (!NonceOk(nonce) || seen.ContainsKey(nonce)) return false;
            if (sig == null || sig.Length > 128 || !B64.Charset(sig)) return false;
            byte[] sigBytes;
            try { sigBytes = B64.Dec(sig); } catch (Exception) { return false; }
            byte[] text = Encoding.UTF8.GetBytes(WakeText(wakeFp, box, MiniJson.Number(at.Value), nonce));
            if (!Ed25519.Verify(pin.Pub, text, sigBytes)) return false;
            Prune(seen, nowMs);
            seen[nonce] = nowMs;
            return true;
        }

        const int MaxSeen = 256;

        static void Prune(Dictionary<string, long> seen, long nowMs)
        {
            if (seen.Count < 32) return;
            List<string> old = new List<string>();
            foreach (KeyValuePair<string, long> pair in seen) if (nowMs - pair.Value > 3 * FreshMs) old.Add(pair.Key);
            foreach (string key in old) seen.Remove(key);
            if (seen.Count >= MaxSeen) seen.Clear(); // only a pinned sender can fill this, and then the 30 s hold after an accepted wake and the nonce window still bound it
        }
    }

    /// A token bucket: `burst` immediately, then one more every `refillMs`.
    public sealed class Throttle
    {
        readonly int burst;
        readonly long refillMs;
        double tokens;
        long last;
        bool started;

        public Throttle(int burst, long refillMs) { this.burst = burst; this.refillMs = refillMs; tokens = burst; }

        public bool Take(long nowMs)
        {
            if (!started) { started = true; last = nowMs; }
            long elapsed = Math.Max(0, nowMs - last);
            last = nowMs;
            tokens = Math.Min(burst, tokens + (double)elapsed / refillMs);
            if (tokens < 1) return false;
            tokens -= 1;
            return true;
        }
    }

    /// One connection's decisions (sleeper.ts Sleeper.control/pair): what to answer to a frame of the meeting server, and whether a
    /// wake was taken. Pure: no socket, no process, no file.
    public sealed class WakeCore
    {
        public const long HoldAfterWakeMs = 30000;
        readonly WakeFile file;
        readonly Func<long> now;
        readonly Action<string> log;
        readonly Dictionary<string, long> seen = new Dictionary<string, long>();
        readonly Throttle throttle = new Throttle(6, 5000);
        PairBox box = new PairBox();
        long lastWake = -1;

        public bool Ready;
        public int Dropped;

        public WakeCore(WakeFile file, Func<long> now, Action<string> log) { this.file = file; this.now = now; this.log = log ?? (s => { }); }

        /// A new connection: a new box key (the old session's wakes no longer verify) and not ready until the server says so.
        public void NewSession() { box = new PairBox(); Ready = false; }

        public string BoxText { get { return box.PubText; } }

        string Sign(string text) { return B64.Enc(Ed25519.Sign(file.Seed, Encoding.UTF8.GetBytes(text))); }

        /// The text to send back (or null), for one text frame from the meeting server. `wake` is true when a valid wake was taken: the
        /// caller sends the answer, then starts the app once.
        public string OnFrame(string text, out bool wake)
        {
            wake = false;
            Dictionary<string, object> frame;
            try { frame = MiniJson.Parse(text) as Dictionary<string, object>; } catch (Exception) { return null; }
            if (frame == null) return null;
            string type = MiniJson.Str(frame, "t");
            if (type == "challenge")
            {
                string n = MiniJson.Str(frame, "n");
                if (n == null || n.Length > 64) return null;
                return "{\"t\":\"hello\",\"v\":1,\"pub\":" + MiniJson.Quote(file.PubText) + ",\"sig\":" + MiniJson.Quote(Sign("wf-relay-v1|hello|" + n))
                    + ",\"box\":" + MiniJson.Quote(box.PubText) + ",\"boxSig\":" + MiniJson.Quote(Sign("wf-relay-v1|box|" + box.PubText)) + ",\"peers\":[],\"findable\":true}";
            }
            if (type == "ready") { Ready = true; log("waiting for a wake at the meeting server"); return null; }
            if (type == "pair") return Pair(frame, out wake);
            return null;
        }

        string Pair(Dictionary<string, object> frame, out bool wake)
        {
            wake = false;
            long t = now();
            string from = MiniJson.Str(frame, "from");
            bool pinned = false;
            if (from != null) foreach (WakePin pin in file.Pins) if (string.Equals(pin.Fp, from, StringComparison.Ordinal)) { pinned = true; break; }
            string e = MiniJson.Str(frame, "e"), c = MiniJson.Str(frame, "c");
            // Everything that is no real wake is dropped without an answer: not from a pin, not throttled in, not opened, not signed.
            if (!pinned || e == null || c == null || (lastWake >= 0 && t - lastWake < HoldAfterWakeMs) || !throttle.Take(t)) { Dropped++; return null; }
            PairCipher cipher = box.FromSender(e, PairBox.PairInfo);
            object body = cipher == null ? null : cipher.OpenJson(c);
            if (body == null || !WakeRules.Check(body, from, file.Pins, file.Fp, box.PubText, t, seen)) { Dropped++; return null; }
            lastWake = t;
            wake = true;
            log("woken by a linked PC: starting the app");
            object reference;
            frame.TryGetValue("ref", out reference);
            return "{\"t\":\"pairReply\"" + (frame.ContainsKey("ref") ? ",\"ref\":" + MiniJson.Write(reference) : "") + ",\"c\":" + MiniJson.Quote(cipher.SealText("{\"ok\":true}")) + "}";
        }
    }

    // =============================================================== the helper's own life (sleeper-life.ts)

    public sealed class RunStateFile
    {
        public string State;
        public double? At, Pid;
        public string By;

        public static RunStateFile Parse(string text)
        {
            Dictionary<string, object> map;
            try { map = MiniJson.Parse(text) as Dictionary<string, object>; } catch (Exception) { return null; }
            if (map == null) return null;
            RunStateFile state = new RunStateFile();
            state.State = MiniJson.Str(map, "state");
            state.At = MiniJson.Num(map, "at");
            state.Pid = MiniJson.Num(map, "pid");
            state.By = MiniJson.Str(map, "by");
            return state;
        }
    }

    public static class Life
    {
        public const long DueSettleMs = 5 * 60000;
        public const long DueTickMs = 15 * 60000;
        public const long DueRecoveryMs = 120000;

        /// run-state.json says 'running' and its process is alive (no pid at all counts as running).
        public static bool AppRunning(RunStateFile state, Func<long, bool> alive)
        {
            if (state == null || state.State != "running") return false;
            return state.Pid == null || alive((long)state.Pid.Value);
        }

        /// sleeper.json names another live helper.
        public static bool OtherHelper(long? markPid, long self, Func<long, bool> alive) { return markPid != null && markPid.Value != self && alive(markPid.Value); }

        /// When to start for scheduled work; the caller has already established that no app runs.
        public static double? DueStartAt(double? at, long startedAt, RunStateFile previous)
        {
            if (at == null || double.IsNaN(at.Value) || double.IsInfinity(at.Value)) return null;
            double? stateAt = previous == null ? null : previous.At;
            if (previous != null && stateAt != null && !double.IsNaN(stateAt.Value) && !double.IsInfinity(stateAt.Value) && stateAt.Value <= startedAt)
            {
                if (previous.State == "running")
                    return at.Value > stateAt.Value && at.Value >= startedAt - DueRecoveryMs ? (double?)Math.Max(at.Value, startedAt) : null;
                if (previous.State == "quit" && previous.By == "person")
                    return at.Value > stateAt.Value && at.Value >= startedAt - DueRecoveryMs ? (double?)Math.Max(at.Value, stateAt.Value + DueSettleMs) : null;
            }
            return at.Value > startedAt ? (double?)Math.Max(at.Value, startedAt + DueSettleMs) : null;
        }

        public static long DueDelay(double startAt, long now) { return (long)Math.Max(0, Math.Min(startAt - now, DueTickMs)); }

        /// One command-line argument by the CommandLineToArgvW rules.
        public static string Quote(string arg)
        {
            if (arg == null) arg = "";
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            StringBuilder sb = new StringBuilder("\"");
            int i = 0;
            while (i < arg.Length)
            {
                int backslashes = 0;
                while (i < arg.Length && arg[i] == '\\') { backslashes++; i++; }
                if (i == arg.Length) { sb.Append('\\', backslashes * 2); break; }
                if (arg[i] == '"') { sb.Append('\\', backslashes * 2 + 1); sb.Append('"'); }
                else { sb.Append('\\', backslashes); sb.Append(arg[i]); }
                i++;
            }
            return sb.Append('"').ToString();
        }
    }

    // =============================================================== WebSocket client (RFC 6455, text frames only)

    public sealed class WsClosed : Exception
    {
        public readonly int Code;
        public WsClosed(int code) : base("closed " + code) { Code = code; }
    }

    public sealed class WsClient
    {
        public const int MaxPayload = 70 * 1024;
        TcpClient tcp;
        Stream stream;
        readonly object gate = new object();
        readonly byte[] mask = new byte[4];
        readonly RandomNumberGenerator rng = RandomNumberGenerator.Create();

        /// Connects (TCP 10 s, TLS for wss, HTTP upgrade 10 s); afterwards a read waits at most `readMs`.
        public static WsClient Connect(string url, int readMs)
        {
            Uri uri = new Uri(url);
            bool secure = uri.Scheme == "wss";
            int port = uri.Port > 0 ? uri.Port : secure ? 443 : 80;
            WsClient client = new WsClient();
            try
            {
                client.tcp = new TcpClient();
                IAsyncResult connecting = client.tcp.BeginConnect(uri.Host, port, null, null);
                if (!connecting.AsyncWaitHandle.WaitOne(10000)) throw new IOException("connect timeout");
                client.tcp.EndConnect(connecting);
                client.tcp.NoDelay = true;
                client.tcp.ReceiveTimeout = 10000;
                client.tcp.SendTimeout = 10000;
                Stream raw = client.tcp.GetStream();
                if (secure)
                {
                    SslStream ssl = new SslStream(raw, false);
                    SslProtocols protocols;
                    try { protocols = SslProtocols.Tls12 | (SslProtocols)12288; ssl.AuthenticateAsClient(uri.Host, null, protocols, false); }
                    catch (NotSupportedException) { ssl = new SslStream(client.tcp.GetStream(), false); ssl.AuthenticateAsClient(uri.Host, null, SslProtocols.Tls12, false); }
                    raw = ssl;
                }
                client.stream = raw;
                client.Handshake(uri);
                client.tcp.ReceiveTimeout = readMs;
                return client;
            }
            catch (Exception) { client.Abort(); throw; }
        }

        void Handshake(Uri uri)
        {
            byte[] nonce = new byte[16];
            rng.GetBytes(nonce);
            string key = Convert.ToBase64String(nonce);
            string request = "GET " + uri.PathAndQuery + " HTTP/1.1\r\nHost: " + uri.Authority + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key
                + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
            byte[] bytes = Encoding.ASCII.GetBytes(request);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
            StringBuilder head = new StringBuilder();
            while (head.Length < 8192)
            {
                int b = stream.ReadByte();
                if (b < 0) throw new IOException("closed in handshake");
                head.Append((char)b);
                if (head.Length >= 4 && head[head.Length - 4] == '\r' && head[head.Length - 3] == '\n' && head[head.Length - 2] == '\r' && head[head.Length - 1] == '\n') break;
            }
            string text = head.ToString();
            if (!text.StartsWith("HTTP/1.1 101", StringComparison.Ordinal)) throw new IOException("upgrade refused");
            string accept;
            using (SHA1 sha = SHA1.Create()) accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            bool ok = false;
            foreach (string line in text.Split(new string[] { "\r\n" }, StringSplitOptions.None))
                if (line.StartsWith("sec-websocket-accept:", StringComparison.OrdinalIgnoreCase) && line.Substring(21).Trim() == accept) ok = true;
            if (!ok) throw new IOException("bad accept");
        }

        void ReadExact(byte[] buffer, int count)
        {
            int got = 0;
            while (got < count)
            {
                int n = stream.Read(buffer, got, count - got);
                if (n <= 0) throw new IOException("closed");
                got += n;
            }
        }

        /// The next text message (fragments joined) or null for something to ignore (binary, pong); answers pings; throws WsClosed on a
        /// close frame and IOException on a dead or silent connection (the read timeout is the 90 s watchdog: any frame re-arms it).
        public string ReadText()
        {
            MemoryStream message = null;
            int messageOpcode = 0;
            byte[] header = new byte[8];
            while (true)
            {
                ReadExact(header, 2);
                bool fin = (header[0] & 0x80) != 0;
                int opcode = header[0] & 0x0f;
                bool masked = (header[1] & 0x80) != 0;
                long length = header[1] & 0x7f;
                if ((header[0] & 0x70) != 0 || masked) throw new IOException("protocol");
                if (length == 126) { ReadExact(header, 2); length = (header[0] << 8) | header[1]; }
                else if (length == 127)
                {
                    ReadExact(header, 8);
                    length = 0;
                    for (int i = 0; i < 8; i++) length = (length << 8) | header[i];
                }
                if (length < 0 || length > MaxPayload) { Close(1009); throw new IOException("too large"); }
                byte[] payload = new byte[length];
                if (length > 0) ReadExact(payload, (int)length);
                if (opcode >= 8)
                {
                    if (!fin || length > 125) throw new IOException("protocol");
                    if (opcode == 9) { Send(10, payload); return null; }
                    if (opcode == 10) return null;
                    if (opcode == 8)
                    {
                        int code = payload.Length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
                        throw new WsClosed(code);
                    }
                    throw new IOException("protocol");
                }
                if (opcode == 1 || opcode == 2) { if (message != null) throw new IOException("protocol"); message = new MemoryStream(); messageOpcode = opcode; }
                else if (opcode != 0 || message == null) throw new IOException("protocol");
                if (message.Length + length > MaxPayload) { Close(1009); throw new IOException("too large"); }
                message.Write(payload, 0, payload.Length);
                if (fin) return messageOpcode == 1 ? Encoding.UTF8.GetString(message.ToArray()) : null;
            }
        }

        public void SendText(string text) { Send(1, Encoding.UTF8.GetBytes(text)); }

        void Send(int opcode, byte[] payload)
        {
            lock (gate)
            {
                if (stream == null) return;
                MemoryStream frame = new MemoryStream();
                frame.WriteByte((byte)(0x80 | opcode));
                if (payload.Length < 126) frame.WriteByte((byte)(0x80 | payload.Length));
                else if (payload.Length < 65536) { frame.WriteByte(0x80 | 126); frame.WriteByte((byte)(payload.Length >> 8)); frame.WriteByte((byte)payload.Length); }
                else throw new IOException("too large");
                rng.GetBytes(mask);
                frame.Write(mask, 0, 4);
                byte[] masked = new byte[payload.Length];
                for (int i = 0; i < payload.Length; i++) masked[i] = (byte)(payload[i] ^ mask[i & 3]);
                frame.Write(masked, 0, masked.Length);
                byte[] all = frame.ToArray();
                stream.Write(all, 0, all.Length);
                stream.Flush();
            }
        }

        /// A close frame (best effort), then the connection goes.
        public void Close(int code)
        {
            try { Send(8, new byte[] { (byte)(code >> 8), (byte)code }); } catch (Exception) { }
            Abort();
        }

        public void Abort()
        {
            try { if (stream != null) stream.Close(); } catch (Exception) { }
            try { if (tcp != null) tcp.Close(); } catch (Exception) { }
            stream = null;
        }
    }

    // =============================================================== processes (Win32)

    static class Procs
    {
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint STILL_ACTIVE = 259;
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
        [DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr process, IntPtr min, IntPtr max);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

        /// The process lives and its image is one of `images` (file names); an image that cannot be read counts as a match (like kill(pid, 0)).
        public static bool Alive(long pid, params string[] images)
        {
            if (pid <= 0 || pid > uint.MaxValue) return false;
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
            if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 5; // access denied: it lives
            try
            {
                uint code;
                if (!GetExitCodeProcess(process, out code) || code != STILL_ACTIVE) return false;
                StringBuilder name = new StringBuilder(1024);
                int size = name.Capacity;
                if (!QueryFullProcessImageName(process, 0, name, ref size)) return true;
                string image = Path.GetFileName(name.ToString());
                foreach (string wanted in images) if (string.Equals(image, wanted, StringComparison.OrdinalIgnoreCase)) return true;
                return false;
            }
            finally { CloseHandle(process); }
        }

        /// Hands back the pages this process does not need right now (they come back from the standby list when touched).
        public static void Trim()
        {
            GC.Collect(2, GCCollectionMode.Forced, true);
            SetProcessWorkingSetSize(GetCurrentProcess(), (IntPtr)(-1), (IntPtr)(-1));
        }
    }

    // =============================================================== the program

    public static class Program
    {
        const string AppImage = "Autark.exe";
        static readonly int[] BackoffMs = { 1000, 2000, 5000, 15000, 30000, 60000 };
        static string dir = "", appExe = "", ownImage = "AutarkWakeHelper.exe";
        static List<string> appArgs = new List<string>();
        static volatile bool ended;
        static readonly ManualResetEvent endSignal = new ManualResetEvent(false);
        static readonly object startGate = new object();
        static bool starting;
        static WsClient client;
        static string markFile = "";
        static long startedAt;
        static Mutex single;
        static System.Threading.Timer dueTimer;
        static FileSystemWatcher watcher;

        static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

        static string Read(string name)
        {
            try
            {
                string file = Path.Combine(dir, name);
                FileInfo info = new FileInfo(file);
                if (!info.Exists || info.Length > WakeRules.MaxFileBytes) return "";
                using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
            }
            catch (Exception) { return ""; }
        }

        static Dictionary<string, object> Map(string text)
        {
            try { return MiniJson.Parse(text) as Dictionary<string, object>; } catch (Exception) { return null; }
        }

        static void Log(string line)
        {
            try
            {
                string folder = Path.Combine(dir, "logs");
                Directory.CreateDirectory(folder);
                string file = Path.Combine(folder, "sleeper.log");
                FileInfo info = new FileInfo(file);
                if (info.Exists && info.Length > 256 * 1024) File.Delete(file);
                File.AppendAllText(file, DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) + " " + line + "\n", new UTF8Encoding(false));
            }
            catch (Exception) { }
        }

        static bool AppAlive(long pid) { return Procs.Alive(pid, Path.GetFileName(appExe), AppImage); }
        static bool HelperAlive(long pid) { return Procs.Alive(pid, ownImage, AppImage); }
        static bool Running() { return Life.AppRunning(RunStateFile.Parse(Read("run-state.json")), AppAlive); }

        static long? MarkPid()
        {
            return (long?)MiniJson.Num(Map(Read("sleeper.json")), "pid");
        }

        static void Unmark()
        {
            try
            {
                long? pid = MarkPid();
                if (markFile.Length > 0 && pid != null && pid.Value == Process.GetCurrentProcess().Id) File.Delete(markFile);
            }
            catch (Exception) { }
        }

        /// The app, the ordinary way, once: never while it runs, never twice at the same time.
        static void StartApp(IList<string> extra)
        {
            lock (startGate)
            {
                if (starting || Running()) return;
                starting = true;
            }
            try
            {
                StringBuilder args = new StringBuilder();
                foreach (string arg in extra) args.Append(args.Length > 0 ? " " : "").Append(Life.Quote(arg));
                foreach (string arg in appArgs) args.Append(args.Length > 0 ? " " : "").Append(Life.Quote(arg));
                ProcessStartInfo info = new ProcessStartInfo(appExe, args.ToString());
                info.UseShellExecute = false;
                info.WorkingDirectory = Path.GetDirectoryName(appExe);
                info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); // the app starts as the app
                Process.Start(info).Dispose();
            }
            catch (Exception e) { Log("app launch failed: " + e.GetType().Name); }
        }

        static void End()
        {
            if (ended) return;
            ended = true;
            Log("ending");
            endSignal.Set();
            WsClient current = client;
            if (current != null) current.Abort();
        }

        public static int Main(string[] argv)
        {
            if (Environment.GetEnvironmentVariable("WAKE_TRACE_LOADS") == "1")
                AppDomain.CurrentDomain.AssemblyLoad += delegate(object s, AssemblyLoadEventArgs a)
                {
                    StackTrace trace = new StackTrace(1, false);
                    StringBuilder sb = new StringBuilder("LOAD " + a.LoadedAssembly.GetName().Name + " <-");
                    for (int i = 0; i < trace.FrameCount && i < 14; i++) { System.Reflection.MethodBase m = trace.GetFrame(i).GetMethod(); sb.Append(" " + (m.DeclaringType != null ? m.DeclaringType.Name : "") + "." + m.Name); }
                    if (dir == "") pendingLoads.Add(sb.ToString()); else Log(sb.ToString());
                };
            try { return Run(argv); }
            catch (Exception e) { Log("failed: " + e.GetType().Name); return 1; }
        }
        static readonly List<string> pendingLoads = new List<string>();

        static int Run(string[] argv)
        {
            string file = argv.Length > 0 ? argv[0] : "";
            for (int i = 1; i < argv.Length; i++)
            {
                if (argv[i] == "--") { for (int j = i + 1; j < argv.Length; j++) appArgs.Add(argv[j]); break; }
                if (argv[i] == "--app" && i + 1 < argv.Length) appExe = argv[++i];
            }
            if (file.Length == 0 || !Path.IsPathRooted(file)) return 0;
            dir = Path.GetDirectoryName(Path.GetFullPath(file));
            foreach (string pending in pendingLoads) Log(pending);
            ownImage = Path.GetFileName(Process.GetCurrentProcess().MainModule.FileName);
            startedAt = NowMs();
            WakeFile wake = WakeRules.Parse(Read(Path.GetFileName(file)));
            bool appOk = appExe.Length >= 7 && appExe[1] == ':' && (appExe[2] == '\\' || appExe[2] == '/') && appExe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(appExe);
            if (wake == null || !appOk || Running()) return 0;
            bool created;
            string tag = B64.Hex(SHA1.Create().ComputeHash(Encoding.UTF8.GetBytes(dir.ToLowerInvariant()))).Substring(0, 16);
            single = new Mutex(true, "Local\\AutarkWakeHelper-" + tag, out created);
            if (!created || Life.OtherHelper(MarkPid(), Process.GetCurrentProcess().Id, HelperAlive)) return 0;
            markFile = Path.Combine(dir, "sleeper.json");
            try
            {
                string temp = markFile + "." + Process.GetCurrentProcess().Id + ".tmp";
                File.WriteAllText(temp, "{\"pid\":" + Process.GetCurrentProcess().Id + ",\"at\":" + startedAt + "}\n", new UTF8Encoding(false));
                if (File.Exists(markFile)) File.Delete(markFile);
                File.Move(temp, markFile);
            }
            catch (Exception) { /* no mark: the broker may start a second helper, which the mutex and the meeting server's key handover (4009) end */ }
            AppDomain.CurrentDomain.ProcessExit += (s, a) => Unmark();

            ArmDue();
            try
            {
                watcher = new FileSystemWatcher(dir, "run-state.json");
                watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size;
                FileSystemEventHandler changed = (s, a) => { if (Running()) End(); };
                watcher.Changed += changed; watcher.Created += changed;
                watcher.Renamed += (s, a) => { if (Running()) End(); };
                watcher.EnableRaisingEvents = true;
            }
            catch (Exception) { /* no watch: the helper waits on; a wake while the app runs only shows its window (single instance) */ }
            Log("started (pid " + Process.GetCurrentProcess().Id + ")");
            Connections(wake);
            Unmark();
            return 0;
        }

        static void ArmDue()
        {
            double? due = Life.DueStartAt(MiniJson.Num(Map(Read("next-due.json")), "at"), startedAt, RunStateFile.Parse(Read("run-state.json")));
            if (due == null) return;
            Log("scheduled work starts the app at " + new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(due.Value).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            double at = due.Value;
            TimerCallback tick = null;
            tick = state =>
            {
                if (ended) return;
                if (NowMs() < at) { dueTimer.Change(Life.DueDelay(at, NowMs()), Timeout.Infinite); return; }
                if (!Running()) { Log("scheduled work is due: starting the app"); StartApp(new string[] { "--background" }); }
                Thread.Sleep(1000);
                End();
            };
            dueTimer = new System.Threading.Timer(tick, null, Life.DueDelay(at, NowMs()), Timeout.Infinite);
        }

        static void Connections(WakeFile wake)
        {
            WakeCore core = new WakeCore(wake, NowMs, Log);
            int attempt = 0;
            while (!ended)
            {
                try
                {
                    core.NewSession();
                    WsClient ws = WsClient.Connect(wake.Relay, 90000);
                    client = ws;
                    Procs.Trim();
                    while (!ended)
                    {
                        string text = ws.ReadText();
                        if (text == null) continue;
                        bool woke;
                        string reply = core.OnFrame(text, out woke);
                        if (core.Ready) attempt = 0;
                        if (reply != null) ws.SendText(reply);
                        if (woke)
                        {
                            StartApp(new string[0]);
                            Thread.Sleep(500); // the answer is on its way
                            ws.Close(1000);
                            End();
                        }
                    }
                }
                catch (WsClosed closed)
                {
                    if (closed.Code == 4009) { Log("another wake helper took over"); End(); }
                    else Log("the meeting server closed the connection (" + closed.Code + ")");
                }
                catch (Exception e)
                {
                    // the connection is gone: reconnect with backoff (the kind of failure only – never a message that could carry data)
                    Log("connection ended: " + e.GetType().Name + (e is IOException || e is SocketException || e is AuthenticationException ? ": " + e.Message : ""));
                }
                client = null;
                if (ended) break;
                int delay = BackoffMs[Math.Min(attempt, BackoffMs.Length - 1)];
                attempt++;
                Procs.Trim();
                endSignal.WaitOne(delay);
            }
        }
    }
}
