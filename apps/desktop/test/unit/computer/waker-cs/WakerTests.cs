// Unit tests for the pure parts of resources/broker/Waker.cs (WakerRegistration, WakerPolicy, WakerBackoff, WakerCommandLine,
// WakerEnvironment), compiled by test/unit/computer/waker.test.ts through run.ps1. Prints "PASS <name>" or "FAIL <name>: <why>"
// per case and exits 1 on any failure. Never starts a process, reads the registry or touches a token.

using System;
using System.Collections.Generic;

namespace AutarkBroker
{
    /// Broker.cs's Program.Log, which Waker.cs calls (the tests compile Waker.cs without the service).
    public static class Program { public static void Log(string line) { } }

    public static class WakerTests
    {
        static int failed;
        const long Minute = 60 * 1000;
        const long T0 = 1000000000000L;

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

        /// A world where the processes in `alive` (pid -> image name) live.
        static WakerFacts Facts(Dictionary<long, string> alive)
        {
            WakerFacts f = new WakerFacts();
            f.ExeName = "Autark.exe";
            f.WakeFileExists = true;
            f.ImageOf = pid => { string image; return alive.TryGetValue(pid, out image) ? image : null; };
            return f;
        }

        static Dictionary<long, string> Alive(params object[] pairs)
        {
            Dictionary<long, string> map = new Dictionary<long, string>();
            for (int i = 0; i < pairs.Length; i += 2) map[Convert.ToInt64(pairs[i])] = (string)pairs[i + 1];
            return map;
        }

        const string Exe = "C:\\\\Apps\\\\Autark\\\\Autark.exe";
        const string Script = "C:\\\\Apps\\\\Autark\\\\resources\\\\app.asar.unpacked\\\\app\\\\sleeper.mjs";
        const string Data = "C:\\\\Users\\\\x\\\\AppData\\\\Roaming\\\\Autark";

        static string Reg(string exe = Exe, string script = Script, string data = Data, string version = "1", string args = "[\"--company=company-2\"]")
        {
            return "{\"v\":" + version + ",\"exe\":\"" + exe + "\",\"script\":\"" + script + "\",\"data\":\"" + data + "\",\"args\":" + args + "}";
        }

        static string Parse(string json, Func<string, bool> exists, out WakerRegistration registration)
        {
            string reason;
            registration = WakerRegistration.Parse("a.json", json, json.Length, exists, out reason);
            return reason;
        }

        static readonly Func<string, bool> Everything = path => true;

        public static int Main()
        {
            // ---- registration -------------------------------------------------------------------------------------------------
            Case("registration: a valid file parses into exe, script, data and args", () =>
            {
                WakerRegistration r;
                string reason = Parse(Reg(), Everything, out r);
                if (reason != null) return "unexpected reason " + reason;
                return Expect(r.Exe, @"C:\Apps\Autark\Autark.exe", "exe") ?? Expect(r.Data, @"C:\Users\x\AppData\Roaming\Autark", "data")
                    ?? Expect(r.Args.Count, 1, "args") ?? Expect(r.Args[0], "--company=company-2", "arg")
                    ?? Expect(r.WakeFile, @"C:\Users\x\AppData\Roaming\Autark\wake.json", "wake file");
            });
            Case("registration: args are optional", () =>
            {
                WakerRegistration r;
                string json = "{\"v\":1,\"exe\":\"C:\\\\a\\\\Autark.exe\",\"script\":\"C:\\\\a\\\\s.mjs\",\"data\":\"C:\\\\d\"}";
                return Expect(Parse(json, Everything, out r), null, "reason") ?? Expect(r.Args.Count, 0, "args");
            });
            Case("registration: a wrong version is ignored", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(version: "2"), Everything, out r), "bad_version", "reason");
            });
            Case("registration: a missing version is ignored", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg().Replace("\"v\":1,", ""), Everything, out r), "bad_version", "reason");
            });
            Case("registration: a relative exe is ignored", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(exe: "Autark.exe"), Everything, out r), "bad_exe", "reason");
            });
            Case("registration: an exe that is no .exe is ignored", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(exe: "C:\\\\Apps\\\\Autark\\\\Autark.cmd"), Everything, out r), "bad_exe", "reason");
            });
            Case("registration: a relative script is ignored", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(script: "app\\\\sleeper.mjs"), Everything, out r), "bad_script", "reason");
            });
            Case("registration: a relative or UNC data folder is ignored", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(data: "data"), Everything, out r), "bad_data", "relative")
                    ?? Expect(Parse(Reg(data: "\\\\\\\\server\\\\share"), Everything, out r), "bad_data", "unc");
            });
            Case("registration: a missing exe is ignored (injected exists)", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(), p => !p.EndsWith("Autark.exe"), out r), "exe_missing", "reason");
            });
            Case("registration: a missing script is ignored (injected exists)", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(), p => !p.EndsWith("sleeper.mjs"), out r), "script_missing", "reason");
            });
            Case("registration: more than 8 args are ignored, 8 are fine", () =>
            {
                WakerRegistration r;
                string eight = Reg(args: "[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\"]");
                string nine = Reg(args: "[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\"]");
                return Expect(Parse(eight, Everything, out r), null, "eight") ?? Expect(Parse(nine, Everything, out r), "bad_args", "nine");
            });
            Case("registration: an arg over 200 chars or not a string is ignored", () =>
            {
                WakerRegistration r;
                string ok = Reg(args: "[\"" + new string('x', 200) + "\"]");
                string tooLong = Reg(args: "[\"" + new string('x', 201) + "\"]");
                return Expect(Parse(ok, Everything, out r), null, "200") ?? Expect(Parse(tooLong, Everything, out r), "bad_args", "long")
                    ?? Expect(Parse(Reg(args: "[5]"), Everything, out r), "bad_args", "number") ?? Expect(Parse(Reg(args: "\"--x\""), Everything, out r), "bad_args", "text");
            });
            Case("registration: a file over 64 KB or broken JSON is ignored", () =>
            {
                WakerRegistration r;
                string reason;
                WakerRegistration.Parse("a.json", Reg(), 64 * 1024 + 1, Everything, out reason);
                return Expect(reason, "too_large", "big") ?? Expect(Parse("{not json", Everything, out r), "bad_json", "broken") ?? Expect(Parse("[1]", Everything, out r), "bad_json", "array");
            });

            // ---- policy -------------------------------------------------------------------------------------------------------
            Case("policy: nothing to start without wake.json", () =>
            {
                WakerFacts f = Facts(Alive());
                f.WakeFileExists = false;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "no_wake_file", "decision");
            });
            Case("policy: the app runs (state running, its pid alive as Autark.exe)", () =>
            {
                WakerFacts f = Facts(Alive(100, "Autark.exe"));
                f.RunState = "running"; f.RunPid = 100; f.RunAt = T0 - 5000;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "app_running", "decision");
            });
            Case("policy: the image name match ignores case", () =>
            {
                WakerFacts f = Facts(Alive(100, "AUTARK.EXE"));
                f.RunState = "running"; f.RunPid = 100;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "app_running", "decision");
            });
            Case("policy: state running with a dead pid (the app was killed) starts the helper", () =>
            {
                WakerFacts f = Facts(Alive());
                f.RunState = "running"; f.RunPid = 100;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: state running whose pid was reused by another program starts the helper", () =>
            {
                WakerFacts f = Facts(Alive(100, "chrome.exe"));
                f.RunState = "running"; f.RunPid = 100;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: quit by the person with no helper starts one (the whole point)", () =>
            {
                WakerFacts f = Facts(Alive());
                f.RunState = "quit"; f.RunBy = "person"; f.RunAt = T0 - 1000; f.RunPid = 100;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: no run-state at all (killed before it wrote) starts the helper", () =>
                Expect(WakerPolicy.Decide(Facts(Alive()), new WakerBackoff(), T0), null, "decision"));
            Case("policy: an update is installing (quit by update, just under 10 minutes ago)", () =>
            {
                WakerFacts f = Facts(Alive());
                f.RunState = "quit"; f.RunBy = "update"; f.RunAt = T0 - (10 * Minute - 1);
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "updating", "decision");
            });
            Case("policy: the update window ends at exactly 10 minutes", () =>
            {
                WakerFacts f = Facts(Alive());
                f.RunState = "quit"; f.RunBy = "update"; f.RunAt = T0 - 10 * Minute;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: an update stamp far in the future blocks nothing", () =>
            {
                WakerFacts f = Facts(Alive());
                f.RunState = "quit"; f.RunBy = "update"; f.RunAt = T0 + 3600 * 1000;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: quit by something else than update does not wait", () =>
            {
                WakerFacts f = Facts(Alive());
                f.RunState = "quit"; f.RunBy = "system"; f.RunAt = T0 - 1000;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: a helper runs (sleeper.json pid alive as Autark.exe)", () =>
            {
                WakerFacts f = Facts(Alive(200, "Autark.exe"));
                f.SleeperPid = 200;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "helper_running", "decision");
            });
            Case("policy: sleeper.json left by a killed helper (dead pid) starts a new one", () =>
            {
                WakerFacts f = Facts(Alive());
                f.SleeperPid = 200;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: sleeper.json whose pid became another program starts a new helper", () =>
            {
                WakerFacts f = Facts(Alive(200, "notepad.exe"));
                f.SleeperPid = 200;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("policy: the helper this supervisor started last counts as running before it wrote sleeper.json", () =>
            {
                WakerFacts f = Facts(Alive(300, "Autark.exe"));
                f.OwnHelperPid = 300;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "helper_running", "decision");
            });
            Case("policy: a setup process in the session blocks the start", () =>
            {
                WakerFacts f = Facts(Alive());
                f.InstallerRunning = true;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "installer", "decision");
            });
            Case("policy: order - a running app beats an installer, no wake file beats everything", () =>
            {
                WakerFacts f = Facts(Alive(100, "Autark.exe"));
                f.RunState = "running"; f.RunPid = 100; f.InstallerRunning = true;
                string a = Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "app_running", "app");
                f.WakeFileExists = false;
                return a ?? Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "no_wake_file", "wake");
            });
            Case("policy: an installer beats the backoff, the backoff beats a start", () =>
            {
                WakerBackoff b = new WakerBackoff();
                b.Started(T0, 1);
                WakerFacts f = Facts(Alive());
                f.InstallerRunning = true;
                return Expect(WakerPolicy.Decide(f, b, T0 + 1000), "installer", "installer") ?? Expect(WakerPolicy.Decide(Facts(Alive()), b, T0 + 1000), "backoff", "backoff");
            });
            Case("installer names: setup, uninstall, NSIS temp copies - not Autark", () =>
                (WakerPolicy.LooksLikeInstaller("Autark Setup 0.3.19.exe") ? null : "setup")
                ?? (WakerPolicy.LooksLikeInstaller("Uninstall Autark") ? null : "uninstall")
                ?? (WakerPolicy.LooksLikeInstaller("UN_A.exe") ? null : "Un_A")
                ?? (WakerPolicy.LooksLikeInstaller("au_") ? null : "Au_")
                ?? (WakerPolicy.LooksLikeInstaller("Autark.exe") ? "Autark" : null)
                ?? (WakerPolicy.LooksLikeInstaller("Un_B.exe") ? "Un_B" : null)
                ?? (WakerPolicy.LooksLikeInstaller("") ? "empty" : null));

            // ---- backoff ------------------------------------------------------------------------------------------------------
            Case("backoff: the wait grows 15 s x 2^n and stops at 30 minutes", () =>
                Expect(WakerBackoff.WaitMs(0), 15000L, "n0") ?? Expect(WakerBackoff.WaitMs(1), 30000L, "n1") ?? Expect(WakerBackoff.WaitMs(2), 60000L, "n2")
                ?? Expect(WakerBackoff.WaitMs(6), 960000L, "n6") ?? Expect(WakerBackoff.WaitMs(7), 30 * Minute, "n7 capped")
                ?? Expect(WakerBackoff.WaitMs(40), 30 * Minute, "n40 capped") ?? Expect(WakerBackoff.WaitMs(-3), 15000L, "negative"));
            Case("backoff: the next start waits after the last one; the edge is allowed", () =>
            {
                WakerBackoff b = new WakerBackoff();
                b.Started(T0, 300);
                WakerFacts f = Facts(Alive());
                return Expect(WakerPolicy.Decide(f, b, T0 + 14999), "backoff", "before") ?? Expect(WakerPolicy.Decide(f, b, T0 + 15000), null, "at the edge");
            });
            Case("backoff: a helper that dies within a minute makes the wait grow", () =>
            {
                WakerBackoff b = new WakerBackoff();
                b.Started(T0, 300);
                b.Observe(T0 + 20000, false);
                string a = Expect(b.QuickDeaths, 1, "first");
                b.Started(T0 + 60000, 301);
                b.Observe(T0 + 70000, false);
                string c = Expect(b.QuickDeaths, 2, "second");
                WakerFacts f = Facts(Alive());
                return a ?? c ?? Expect(WakerPolicy.Decide(f, b, T0 + 60000 + 59999), "backoff", "waits 60 s") ?? Expect(WakerPolicy.Decide(f, b, T0 + 120000), null, "then starts");
            });
            Case("backoff: one death is judged once, not at every tick", () =>
            {
                WakerBackoff b = new WakerBackoff();
                b.Started(T0, 300);
                b.Observe(T0 + 20000, false);
                b.Observe(T0 + 35000, false);
                b.Observe(T0 + 50000, false);
                return Expect(b.QuickDeaths, 1, "count");
            });
            Case("backoff: a helper that lived a minute resets the count", () =>
            {
                WakerBackoff b = new WakerBackoff();
                b.QuickDeaths = 5;
                b.Started(T0, 300);
                b.Observe(T0 + 30000, true);
                string young = Expect(b.QuickDeaths, 5, "still young");
                b.Observe(T0 + 60000, true);
                return young ?? Expect(b.QuickDeaths, 0, "reset");
            });
            Case("backoff: a helper that died after living a minute is no quick death", () =>
            {
                WakerBackoff b = new WakerBackoff();
                b.QuickDeaths = 3;
                b.Started(T0, 300);
                b.Observe(T0 + 90000, false);
                return Expect(b.QuickDeaths, 0, "count");
            });
            Case("backoff: a failed start counts like a quick death", () =>
            {
                WakerBackoff b = new WakerBackoff();
                b.Failed(T0);
                b.Observe(T0 + 40000, false);
                return Expect(b.QuickDeaths, 1, "count") ?? Expect(b.HelperPid, 0L, "pid");
            });
            Case("backoff: a fresh registration starts at once", () =>
                Expect(WakerPolicy.Decide(Facts(Alive()), new WakerBackoff(), T0), null, "fresh"));

            // ---- command line -------------------------------------------------------------------------------------------------
            Case("quote: a plain argument stays as it is, an empty one becomes two quotes", () =>
                Expect(WakerCommandLine.Quote("--company=company-2", false), "--company=company-2", "plain") ?? Expect(WakerCommandLine.Quote("", false), "\"\"", "empty"));
            Case("quote: spaces wrap in quotes", () =>
                Expect(WakerCommandLine.Quote(@"C:\Program Files\Autark\Autark.exe", false), "\"C:\\Program Files\\Autark\\Autark.exe\"", "spaces"));
            Case("quote: a trailing backslash is doubled inside quotes", () =>
                Expect(WakerCommandLine.Quote(@"C:\My Dir\", false), "\"C:\\My Dir\\\\\"", "trailing") ?? Expect(WakerCommandLine.Quote(@"C:\Dir\", true), "\"C:\\Dir\\\\\"", "forced"));
            Case("quote: an embedded quote is escaped and the backslashes before it are doubled", () =>
                Expect(WakerCommandLine.Quote("say \"hi\"", false), "\"say \\\"hi\\\"\"", "quote") ?? Expect(WakerCommandLine.Quote("a\\\"b", false), "\"a\\\\\\\"b\"", "backslash quote"));
            Case("quote: backslashes elsewhere stay single", () =>
                Expect(WakerCommandLine.Quote(@"a\b c", false), "\"a\\b c\"", "inner"));
            Case("command line: quoted exe, script and wake.json, then --, then the args", () =>
            {
                string line = WakerCommandLine.Build(@"C:\Program Files\Autark\Autark.exe", @"C:\Program Files\Autark\app\sleeper.mjs", @"C:\Users\x\Roaming\Autark\wake.json",
                    new List<string> { "--company=company-2", "two words", "" });
                return Expect(line, "\"C:\\Program Files\\Autark\\Autark.exe\" \"C:\\Program Files\\Autark\\app\\sleeper.mjs\" \"C:\\Users\\x\\Roaming\\Autark\\wake.json\" -- --company=company-2 \"two words\" \"\"", "line");
            });
            Case("command line: without args it ends in --", () =>
                Expect(WakerCommandLine.Build(@"C:\a.exe", @"C:\s.mjs", @"C:\w.json", new List<string>()), "\"C:\\a.exe\" \"C:\\s.mjs\" \"C:\\w.json\" --", "line"));

            // ---- environment --------------------------------------------------------------------------------------------------
            Case("environment: ELECTRON_RUN_AS_NODE=1 is added, entries end each with NUL and the block with two", () =>
            {
                string block = WakerEnvironment.Build(new List<string> { "PATH=C:\\x", "USERNAME=x" });
                return Expect(block, "ELECTRON_RUN_AS_NODE=1\0PATH=C:\\x\0USERNAME=x\0\0", "block") ?? Expect(block.EndsWith("\0\0"), true, "double NUL");
            });
            Case("environment: an existing ELECTRON_RUN_AS_NODE (any case) is replaced", () =>
            {
                string block = WakerEnvironment.Build(new List<string> { "electron_run_as_node=0", "PATH=C:\\x" });
                return Expect(block, "ELECTRON_RUN_AS_NODE=1\0PATH=C:\\x\0\0", "block");
            });
            Case("environment: an empty environment still yields the one variable and the double NUL", () =>
                Expect(WakerEnvironment.Build(new List<string>()), "ELECTRON_RUN_AS_NODE=1\0\0", "block"));
            Case("environment: sorted by name ignoring case; drive entries (=C:) keep their name; junk without = is dropped", () =>
            {
                string block = WakerEnvironment.Build(new List<string> { "zeta=1", "=C:=C:\\work", "Alpha=2", "junk", "" });
                return Expect(block, "=C:=C:\\work\0Alpha=2\0ELECTRON_RUN_AS_NODE=1\0zeta=1\0\0", "block");
            });
            Case("environment: a value with = in it is kept whole", () =>
                Expect(WakerEnvironment.Build(new List<string> { "A=b=c" }), "A=b=c\0ELECTRON_RUN_AS_NODE=1\0\0", "block"));

            // ---- the slim native helper (0.3.22) ------------------------------------------------------------------------------
            const string HelperPath = "C:\\\\Apps\\\\Autark\\\\resources\\\\app.asar.unpacked\\\\resources\\\\broker\\\\AutarkWakeHelper.exe";
            Func<string, string> withHelper = path => Reg().Replace("}", ",\"helper\":\"" + path + "\"}");
            Case("native helper: a registration without \"helper\" has none (the Node helper runs, as before)", () =>
            {
                WakerRegistration r;
                return Expect(Parse(Reg(), Everything, out r), null, "reason") ?? Expect(r.Helper, "", "helper");
            });
            Case("native helper: an existing AutarkWakeHelper.exe at an absolute path is taken", () =>
            {
                WakerRegistration r;
                return Expect(Parse(withHelper(HelperPath), Everything, out r), null, "reason") ?? Expect(r.Helper, @"C:\Apps\Autark\resources\app.asar.unpacked\resources\broker\AutarkWakeHelper.exe", "helper");
            });
            Case("native helper: a missing file, another file name, a relative path or a non-string is ignored – no error, the Node helper stays", () =>
            {
                WakerRegistration r;
                string a = Expect(Parse(withHelper(HelperPath), p => !p.EndsWith("AutarkWakeHelper.exe"), out r), null, "missing") ?? Expect(r.Helper, "", "missing helper");
                string b = Expect(Parse(withHelper("C:\\\\Windows\\\\System32\\\\cmd.exe"), Everything, out r), null, "cmd") ?? Expect(r.Helper, "", "cmd helper");
                string c = Expect(Parse(withHelper("AutarkWakeHelper.exe"), Everything, out r), null, "relative") ?? Expect(r.Helper, "", "relative helper");
                string d = Expect(Parse(Reg().Replace("}", ",\"helper\":5}"), Everything, out r), null, "number") ?? Expect(r.Helper, "", "number helper");
                string e = Expect(Parse(withHelper("C:\\\\x\\\\AutarkWakeHelper.exe.bat"), Everything, out r), null, "bat") ?? Expect(r.Helper, "", "bat helper");
                return a ?? b ?? c ?? d ?? e;
            });
            Case("native helper: its process counts as a running helper (sleeper.json pid, own pid) – by its image name", () =>
            {
                WakerFacts f = Facts(Alive(200, "AutarkWakeHelper.exe"));
                f.HelperName = "AutarkWakeHelper.exe";
                f.SleeperPid = 200;
                string a = Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), "helper_running", "sleeper");
                WakerFacts g = Facts(Alive(201, "autarkwakehelper.EXE"));
                g.HelperName = "AutarkWakeHelper.exe";
                g.OwnHelperPid = 201;
                return a ?? Expect(WakerPolicy.Decide(g, new WakerBackoff(), T0), "helper_running", "own pid, case");
            });
            Case("native helper: without a registered native helper its image name means nothing; a pid reused by another program starts one", () =>
            {
                WakerFacts f = Facts(Alive(200, "AutarkWakeHelper.exe"));
                f.SleeperPid = 200; // HelperName stays "": not a helper of this registration
                WakerFacts g = Facts(Alive(200, "notepad.exe"));
                g.HelperName = "AutarkWakeHelper.exe";
                g.SleeperPid = 200;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "no native registered") ?? Expect(WakerPolicy.Decide(g, new WakerBackoff(), T0), null, "reused pid");
            });
            Case("native helper: the running app is never taken for the helper (AutarkWakeHelper.exe is no app)", () =>
            {
                WakerFacts f = Facts(Alive(42, "AutarkWakeHelper.exe"));
                f.HelperName = "AutarkWakeHelper.exe";
                f.RunState = "running"; f.RunPid = 42;
                return Expect(WakerPolicy.Decide(f, new WakerBackoff(), T0), null, "decision");
            });
            Case("native helper: used when registered; the Node helper when not", () =>
            {
                WakerRegistration with = new WakerRegistration(), without = new WakerRegistration();
                with.Helper = @"C:\x\AutarkWakeHelper.exe";
                WakerBackoff b = new WakerBackoff();
                return Expect(b.UseNative(with), true, "with") ?? Expect(b.UseNative(without), false, "without");
            });
            Case("native helper: two quick deaths in a row (or two failed starts) fall back to the Node helper for good", () =>
            {
                WakerRegistration r = new WakerRegistration();
                r.Helper = @"C:\x\AutarkWakeHelper.exe";
                WakerBackoff b = new WakerBackoff();
                b.Started(T0, 300, true);
                b.Observe(T0 + 20000, false);
                string a = Expect(b.UseNative(r), true, "after one death");
                b.Started(T0 + 60000, 301, true);
                b.Observe(T0 + 80000, false);
                string c = Expect(b.UseNative(r), false, "after two deaths");
                WakerBackoff f = new WakerBackoff();
                f.Failed(T0, true);
                string d = Expect(f.UseNative(r), true, "one failed start");
                f.Failed(T0 + 60000, true);
                return a ?? c ?? d ?? Expect(f.UseNative(r), false, "two failed starts");
            });
            Case("native helper: a helper that lived a minute clears its record; the Node helper's deaths never count against it", () =>
            {
                WakerRegistration r = new WakerRegistration();
                r.Helper = @"C:\x\AutarkWakeHelper.exe";
                WakerBackoff b = new WakerBackoff();
                b.Started(T0, 300, true);
                b.Observe(T0 + 20000, false); // one quick death
                b.Started(T0 + 60000, 301, true);
                b.Observe(T0 + 130000, true); // lived over a minute: the record is cleared
                b.Started(T0 + 140000, 302, true);
                b.Observe(T0 + 150000, false); // one quick death again, not two
                WakerBackoff n = new WakerBackoff();
                for (int i = 0; i < 4; i++) { n.Started(T0 + i * 60000, 400 + i, false); n.Observe(T0 + i * 60000 + 5000, false); }
                return Expect(b.UseNative(r), true, "cleared") ?? Expect(n.UseNative(r), true, "node deaths");
            });
            Case("native helper command line: helper, wake.json, --app exe, --, the registered args – nothing else", () =>
            {
                string line = WakerCommandLine.BuildNative(@"C:\Program Files\Autark\AutarkWakeHelper.exe", @"C:\Program Files\Autark\Autark.exe", @"C:\Users\x\Roaming\Autark\wake.json",
                    new List<string> { "--company=company-2", "two words" });
                return Expect(line, "\"C:\\Program Files\\Autark\\AutarkWakeHelper.exe\" \"C:\\Users\\x\\Roaming\\Autark\\wake.json\" --app \"C:\\Program Files\\Autark\\Autark.exe\" -- --company=company-2 \"two words\"", "line")
                    ?? Expect(WakerCommandLine.BuildNative(@"C:\h.exe", @"C:\a.exe", @"C:\w.json", null), "\"C:\\h.exe\" \"C:\\w.json\" --app \"C:\\a.exe\" --", "no args");
            });
            Case("native helper environment: no ELECTRON_RUN_AS_NODE at all (an inherited one is removed), the rest stays sorted", () =>
            {
                string block = WakerEnvironment.Build(new List<string> { "electron_run_as_node=1", "PATH=C:\\x", "Alpha=2" }, false);
                return Expect(block, "Alpha=2\0PATH=C:\\x\0\0", "block") ?? Expect(WakerEnvironment.Build(new List<string>(), false), "\0", "empty");
            });

            // ---- files of the app ---------------------------------------------------------------------------------------------
            Case("run-state.json and sleeper.json are read; broken ones are ignored", () =>
            {
                WakerFacts f = Facts(Alive());
                f.ApplyRunState("{\"state\":\"quit\",\"at\":1700000000000,\"pid\":42,\"by\":\"update\"}");
                f.ApplySleeper("{\"pid\":77,\"at\":1}");
                string a = Expect(f.RunState, "quit", "state") ?? Expect(f.RunAt, 1700000000000L, "at") ?? Expect(f.RunPid, 42L, "pid") ?? Expect(f.RunBy, "update", "by") ?? Expect(f.SleeperPid, 77L, "sleeper");
                WakerFacts g = Facts(Alive());
                g.ApplyRunState("{\"state\":\"weird\"}");
                g.ApplyRunState("not json");
                g.ApplySleeper("{\"pid\":\"x\"}");
                return a ?? Expect(g.RunState, null, "unknown state") ?? Expect(g.SleeperPid, 0L, "bad pid");
            });

            Console.WriteLine(failed == 0 ? "ALL PASS" : failed + " FAILED");
            return failed == 0 ? 0 : 1;
        }
    }
}
