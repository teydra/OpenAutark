// Waker supervisor (23.11.2026, Autark 0.3.19): keeps the Autark wake helper ("sleeper") alive for the signed-in user while the
// app is closed. The helper is the app's own Autark.exe run as Node (ELECTRON_RUN_AS_NODE=1) on app/sleeper.mjs; it waits at the
// meeting server for a signed wake from the person's phone. When the person ends Autark (Task Manager, a crash, a restart) the
// helper dies with it – this supervisor, living in the always-running service, starts one again, as the person.
//
// Since 0.3.22 (Windows only) the helper can be the slim native AutarkWakeHelper.exe (WakeHelper.cs, ~15 MB instead of 113 MB):
// the registration names it in the optional "helper"; it is used when that file is there and has not died within a minute twice in
// a row (WakerBackoff.NativeBroken) – otherwise the Node helper above is started, unchanged. Mac and Linux have no broker and keep the
// Node helper (launchd / systemd --user).
//
// The contract with the app (TypeScript side):
//   <the user's Local AppData>\AutarkDesktopBroker\wakers\*.json   one registration per Autark data folder; present = waker on:
//       {"v":1,"exe":"C:\\...\\Autark.exe","script":"C:\\...\\app\\sleeper.mjs","data":"C:\\Users\\x\\AppData\\Roaming\\Autark","args":["--company=company-2"],"helper":"C:\\...\\broker\\AutarkWakeHelper.exe"}
//   <data>\wake.json      the helper's key file (must exist)
//   <data>\run-state.json {"state":"running"|"quit","at":<epoch ms>,"pid":<n>,"by":"person"|"update"|"system"|"launcher"}
//   <data>\sleeper.json   {"pid":<n>,"at":<epoch ms>} written by a running helper, removed at its clean end
// Every 15 s (and at each session change) WakerPolicy.Decide says per registration whether to start: not without wake.json, not
// while the app runs, not while an update installs, not while a helper runs, not while an installer runs, and with a growing
// wait (15 s x 2^n, at most 30 min) after helpers that died within a minute. Then the helper starts in the console session with
// the PERSON's token (WTSQueryUserToken, the unelevated half when UAC split it, the person's own environment plus
// ELECTRON_RUN_AS_NODE=1), never with the service's SYSTEM token.
//
// Files of the user's profile (the registrations, <data>\*.json, whether exe and script exist) are read while IMPERSONATING the
// user, so a junction or symlink there never lets LocalSystem read what the user cannot. Process checks (alive, image name) run
// as the service.
//
// Owns: WakerRegistration (parse + validate), WakerFacts/WakerBackoff/WakerPolicy (the pure decision), WakerCommandLine and
// WakerEnvironment (pure), WakerNative (the Win32 calls) and WakerSupervisor (the 15 s tick). Needs Json of the helper source
// (WorkforceHelper.Json). Never: starts the app itself (no Autark.exe without the sleeper script, no --background), holds a
// network connection, restarts an app the person ended on purpose, starts anything as SYSTEM or elevated, or reads the key.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace AutarkBroker
{
    /// One registration file, validated. Parse is pure: the text, its byte length and an injected "does this file exist".
    public sealed class WakerRegistration
    {
        public const int MaxBytes = 64 * 1024;
        public const int MaxArgs = 8;
        public const int MaxArgLength = 200;

        public string FileName = "";
        public string Exe = "";
        public string Script = "";
        public string Data = "";
        /// The slim native wake helper (AutarkWakeHelper.exe, 0.3.22), "" when the registration names none or it is not there: then the
        /// Node helper (exe + script) is used, as before.
        public string Helper = "";
        public List<string> Args = new List<string>();

        public const string HelperFileName = "AutarkWakeHelper.exe";

        public string WakeFile { get { return Path.Combine(Data, "wake.json"); } }
        public string RunStateFile { get { return Path.Combine(Data, "run-state.json"); } }
        public string SleeperFile { get { return Path.Combine(Data, "sleeper.json"); } }

        /// A drive-letter path with a separator ("C:\..."); relative paths, "C:foo", UNC and device paths are refused.
        public static bool IsAbsolute(string path)
        {
            if (string.IsNullOrEmpty(path) || path.IndexOf('\0') >= 0) return false;
            return path.Length >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':' && (path[2] == '\\' || path[2] == '/');
        }

        /// Returns the registration, or null with `reason` set (too_large, bad_json, bad_version, bad_exe, bad_script, bad_data,
        /// bad_args, exe_missing, script_missing).
        public static WakerRegistration Parse(string fileName, string text, long length, Func<string, bool> exists, out string reason)
        {
            reason = null;
            if (length > MaxBytes || (text != null && text.Length > MaxBytes)) { reason = "too_large"; return null; }
            Dictionary<string, object> map;
            try { map = WorkforceHelper.Json.Parse(text ?? "") as Dictionary<string, object>; }
            catch (Exception) { map = null; }
            if (map == null) { reason = "bad_json"; return null; }
            object version;
            if (!map.TryGetValue("v", out version) || !(version is double) || (double)version != 1) { reason = "bad_version"; return null; }
            string exe = Str(map, "exe"), script = Str(map, "script"), data = Str(map, "data");
            if (!IsAbsolute(exe) || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) { reason = "bad_exe"; return null; }
            if (!IsAbsolute(script)) { reason = "bad_script"; return null; }
            if (!IsAbsolute(data)) { reason = "bad_data"; return null; }
            List<string> args = new List<string>();
            object rawArgs;
            if (map.TryGetValue("args", out rawArgs) && rawArgs != null)
            {
                List<object> list = rawArgs as List<object>;
                if (list == null || list.Count > MaxArgs) { reason = "bad_args"; return null; }
                foreach (object item in list)
                {
                    string arg = item as string;
                    if (arg == null || arg.Length > MaxArgLength || arg.IndexOf('\0') >= 0) { reason = "bad_args"; return null; }
                    args.Add(arg);
                }
            }
            if (exists == null || !exists(exe)) { reason = "exe_missing"; return null; }
            if (!exists(script)) { reason = "script_missing"; return null; }
            WakerRegistration registration = new WakerRegistration();
            registration.FileName = fileName;
            registration.Exe = exe;
            registration.Script = script;
            registration.Data = data;
            registration.Args = args;
            // optional: only the file "AutarkWakeHelper.exe" at an absolute path that exists counts; anything else = no native helper
            string helper = Str(map, "helper");
            if (helper != null && IsAbsolute(helper) && string.Equals(Path.GetFileName(helper), HelperFileName, StringComparison.OrdinalIgnoreCase) && exists(helper))
                registration.Helper = helper;
            return registration;
        }

        static string Str(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value as string : null;
        }
    }

    /// What WakerPolicy.Decide knows about one registration: the small files and the processes (injected, so the decision is pure).
    public sealed class WakerFacts
    {
        public string ExeName = "";
        /// The native helper's image name ("AutarkWakeHelper.exe"), "" = none registered.
        public string HelperName = "";
        public bool WakeFileExists;
        /// run-state.json's "state"; null = absent or unreadable.
        public string RunState;
        public long RunAt;
        public long RunPid;
        public string RunBy = "";
        public long SleeperPid;
        /// The helper this supervisor started last (0 = none).
        public long OwnHelperPid;
        /// A setup/uninstall process runs in the person's session.
        public bool InstallerRunning;
        /// The image file name ("Autark.exe") of a live process, null when no such process lives.
        public Func<long, string> ImageOf;

        public void ApplyRunState(string json)
        {
            Dictionary<string, object> map = WakerJson.Map(json);
            if (map == null) return;
            string state = WakerJson.Text(map, "state");
            if (state != "running" && state != "quit") return;
            RunState = state;
            RunAt = WakerJson.Number(map, "at");
            RunPid = WakerJson.Number(map, "pid");
            RunBy = WakerJson.Text(map, "by") ?? "";
        }

        public void ApplySleeper(string json)
        {
            Dictionary<string, object> map = WakerJson.Map(json);
            if (map == null) return;
            SleeperPid = WakerJson.Number(map, "pid");
        }

        /// The process `pid` lives and is an Autark.exe (the pid-reuse guard: a recycled pid is another program).
        public bool IsExe(long pid)
        {
            if (pid <= 0 || ImageOf == null) return false;
            string image = ImageOf(pid);
            return image != null && string.Equals(image, ExeName, StringComparison.OrdinalIgnoreCase);
        }

        /// The process `pid` lives and is a wake helper: the Node helper (an Autark.exe) or the native one (AutarkWakeHelper.exe).
        public bool IsHelper(long pid)
        {
            if (pid <= 0 || ImageOf == null) return false;
            string image = ImageOf(pid);
            if (image == null) return false;
            return string.Equals(image, ExeName, StringComparison.OrdinalIgnoreCase)
                || (HelperName.Length > 0 && string.Equals(image, HelperName, StringComparison.OrdinalIgnoreCase));
        }
    }

    static class WakerJson
    {
        public static Dictionary<string, object> Map(string json)
        {
            if (string.IsNullOrEmpty(json) || json.Length > WakerRegistration.MaxBytes) return null;
            try { return WorkforceHelper.Json.Parse(json) as Dictionary<string, object>; }
            catch (Exception) { return null; }
        }

        public static string Text(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value as string : null;
        }

        public static long Number(Dictionary<string, object> map, string key)
        {
            object value;
            if (!map.TryGetValue(key, out value) || !(value is double)) return 0;
            double number = (double)value;
            return number > 0 && number < 9e15 ? (long)number : 0;
        }
    }

    /// Per registration: when the last helper was started and how many in a row died within a minute.
    public sealed class WakerBackoff
    {
        public const long QuickMs = 60 * 1000;
        public const long BaseMs = 15 * 1000;
        public const long MaxMs = 30 * 60 * 1000;

        public long LastStartMs;
        public int QuickDeaths;
        public long HelperPid;
        bool judged = true;
        bool lastNative;
        int nativeQuick;
        /// The native helper died within a minute twice in a row (or would not start): the Node helper is used from then on, until the
        /// registration goes away and comes back (the app's next start of "Wake while closed" – a fresh memory).
        public bool NativeBroken;
        public const int NativeTries = 2;

        /// Which helper to start now: the native one when the registration has it and it has not failed NativeTries times in a row.
        public bool UseNative(WakerRegistration registration) { return registration.Helper.Length > 0 && !NativeBroken; }

        void Judge(bool quick)
        {
            if (!lastNative) return;
            if (!quick) { nativeQuick = 0; return; }
            if (++nativeQuick >= NativeTries) NativeBroken = true;
        }

        /// The wait after the last start: 15 s x 2^deaths, at most 30 minutes.
        public static long WaitMs(int quickDeaths)
        {
            int n = Math.Max(0, Math.Min(quickDeaths, 16));
            return Math.Min(MaxMs, BaseMs << n);
        }

        public void Started(long nowMs, long pid) { Started(nowMs, pid, false); }

        public void Started(long nowMs, long pid, bool native) { LastStartMs = nowMs; HelperPid = pid; judged = false; lastNative = native; }

        /// The start itself failed: counts like a helper that died at once.
        public void Failed(long nowMs) { Failed(nowMs, false); }

        public void Failed(long nowMs, bool native) { LastStartMs = nowMs; HelperPid = 0; judged = true; QuickDeaths++; lastNative = native; Judge(true); }

        /// The last start has been judged (its helper lived a minute, or is gone): nothing more to learn from its process.
        public bool Judged { get { return judged; } }

        public void Observe(long nowMs, bool helperAlive) { Observe(nowMs, helperAlive, UnknownExit); }

        /// The exit code of a helper that is gone and whose code could not be read (killed from outside, no handle): counts as a crash.
        public const long UnknownExit = -1;

        /// Called at every tick with whether the helper started last still lives: it lived a minute -> the count resets; it was gone
        /// before -> one more quick death (judged once per start). `exitCode` is the gone helper's exit code (UnknownExit when not
        /// known): the native helper ends at once ON PURPOSE with 0 – the app already runs (every logon with autostart), a wake was
        /// taken, another helper took over, its mutex is held – and such an end is no failure: it does not count towards NativeBroken
        /// (the general wait after a quick end is unchanged).
        public void Observe(long nowMs, bool helperAlive, long exitCode)
        {
            if (judged || LastStartMs <= 0) return;
            long age = nowMs - LastStartMs;
            if (helperAlive)
            {
                if (age >= QuickMs) { QuickDeaths = 0; judged = true; Judge(false); }
                return;
            }
            judged = true;
            if (age < QuickMs) QuickDeaths++; else QuickDeaths = 0;
            Judge(age < QuickMs && exitCode != 0);
        }
    }

    /// The pure decision: null = start a helper now, else the reason not to.
    public static class WakerPolicy
    {
        /// An update installer replaces Autark.exe for up to this long after run-state says "quit by update".
        public const long UpdateWindowMs = 10 * 60 * 1000;

        public static string Decide(WakerFacts facts, WakerBackoff backoff, long nowMs)
        {
            if (!facts.WakeFileExists) return "no_wake_file";
            if (facts.RunState == "running" && facts.IsExe(facts.RunPid)) return "app_running";
            if (facts.RunState == "quit" && facts.RunBy == "update")
            {
                long age = nowMs - facts.RunAt;
                if (age >= -60 * 1000 && age < UpdateWindowMs) return "updating"; // a stamp far in the future is no update
            }
            if (facts.IsHelper(facts.SleeperPid) || facts.IsHelper(facts.OwnHelperPid)) return "helper_running";
            if (facts.InstallerRunning) return "installer";
            if (backoff != null && backoff.LastStartMs > 0 && nowMs < backoff.LastStartMs + WakerBackoff.WaitMs(backoff.QuickDeaths)) return "backoff";
            return null;
        }

        /// A running setup/uninstaller (also NSIS's temp copies "Un_A" and "Au_"): Autark.exe started now would be locked
        /// while the installer overwrites it.
        public static bool LooksLikeInstaller(string processName)
        {
            if (string.IsNullOrEmpty(processName)) return false;
            string name = processName.Trim();
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            string lower = name.ToLowerInvariant();
            return lower.Contains("setup") || lower.Contains("uninstall") || lower == "un_a" || lower == "au_";
        }
    }

    /// Command-line quoting by the CommandLineToArgvW rules.
    public static class WakerCommandLine
    {
        /// One argument; `force` quotes even when not needed. Backslashes before a quote (or the closing quote) are doubled.
        public static string Quote(string arg, bool force)
        {
            if (arg == null) arg = "";
            if (!force && arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
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
            sb.Append('"');
            return sb.ToString();
        }

        /// "exe" "script" "<data>\wake.json" -- args...: the helper's whole command line.
        public static string Build(string exe, string script, string wakeFile, IList<string> args)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append(Quote(exe, true)).Append(' ').Append(Quote(script, true)).Append(' ').Append(Quote(wakeFile, true)).Append(" --");
            if (args != null) foreach (string arg in args) sb.Append(' ').Append(Quote(arg, false));
            return sb.ToString();
        }

        /// The native helper's whole command line: "helper" "<data>\wake.json" --app "exe" -- args...
        public static string BuildNative(string helper, string exe, string wakeFile, IList<string> args)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append(Quote(helper, true)).Append(' ').Append(Quote(wakeFile, true)).Append(" --app ").Append(Quote(exe, true)).Append(" --");
            if (args != null) foreach (string arg in args) sb.Append(' ').Append(Quote(arg, false));
            return sb.ToString();
        }
    }

    /// The helper's environment block: the person's own variables plus ELECTRON_RUN_AS_NODE=1.
    public static class WakerEnvironment
    {
        public const string RunAsNode = "ELECTRON_RUN_AS_NODE";

        static string NameOf(string entry)
        {
            int at = entry.IndexOf('=', entry.Length > 0 && entry[0] == '=' ? 1 : 0); // "=C:=C:\x" keeps its leading '='
            return at < 0 ? entry : entry.Substring(0, at);
        }

        /// "K=V" entries -> a UTF-16 block "K=V\0K=V\0\0", sorted by name like Windows does; an existing ELECTRON_RUN_AS_NODE is replaced.
        public static string Build(IEnumerable<string> entries) { return Build(entries, true); }

        /// The native helper's memory settings for the .NET runtime (WakeHelper.cs removes them again from the app it starts): a plain
        /// GC without the background thread and a 1 MB youngest generation (hex) instead of a size taken from the CPU cache – about
        /// 4 MB less private memory. The same pair is set where the app starts the helper itself (sleeper.ts).
        public const string GcConcurrent = "COMPlus_gcConcurrent", GcConcurrentValue = "0", GcGen0Size = "COMPlus_GCgen0size", GcGen0SizeValue = "100000";

        /// `runAsNode` false (the native helper): no ELECTRON_RUN_AS_NODE at all – the app the helper starts must not inherit it –,
        /// and the GC settings above.
        public static string Build(IEnumerable<string> entries, bool runAsNode)
        {
            List<string> list = new List<string>();
            if (entries != null)
                foreach (string entry in entries)
                {
                    if (string.IsNullOrEmpty(entry) || entry.IndexOf('=', entry.Length > 0 && entry[0] == '=' ? 1 : 0) < 0) continue;
                    if (string.Equals(NameOf(entry), RunAsNode, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!runAsNode && (string.Equals(NameOf(entry), GcConcurrent, StringComparison.OrdinalIgnoreCase) || string.Equals(NameOf(entry), GcGen0Size, StringComparison.OrdinalIgnoreCase))) continue;
                    list.Add(entry);
                }
            if (runAsNode) list.Add(RunAsNode + "=1");
            else { list.Add(GcConcurrent + "=" + GcConcurrentValue); list.Add(GcGen0Size + "=" + GcGen0SizeValue); }
            list.Sort((a, b) => string.Compare(NameOf(a), NameOf(b), StringComparison.OrdinalIgnoreCase));
            StringBuilder sb = new StringBuilder();
            foreach (string entry in list) sb.Append(entry).Append('\0');
            sb.Append('\0');
            return sb.ToString();
        }
    }

    /// The Win32 side: the person's token, files as that person, the process image names, the start.
    static class WakerNative
    {
        public const uint NoSession = 0xFFFFFFFF;
        const uint TOKEN_ALL_ACCESS = 0xF01FF;
        const int SecurityImpersonation = 2;
        const int TokenPrimary = 1;
        const int TokenElevationType = 18;
        const int TokenLinkedToken = 19;
        const int TokenElevationTypeFull = 2;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const uint CREATE_NO_WINDOW = 0x08000000;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint STILL_ACTIVE = 259;
        static readonly Guid LocalAppDataFolder = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
        [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint session, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, out IntPtr info, int length, out int returned);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessAsUser(IntPtr token, string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
        [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
        [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr environment);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid folder, uint flags, IntPtr token, out IntPtr path);
        [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr memory);

        public static bool QueryUserToken(uint session, out IntPtr token)
        {
            token = IntPtr.Zero;
            return WTSQueryUserToken(session, out token) && token != IntPtr.Zero;
        }

        public static void Close(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }

        public static string SidOf(IntPtr token)
        {
            using (WindowsIdentity identity = new WindowsIdentity(token)) return identity.User != null ? identity.User.Value : "";
        }

        /// A primary copy of the person's token. When UAC split it into an elevated and a limited half and this is the elevated
        /// one, the limited half is taken: a wake helper needs no administrator rights. `note` says which one it is.
        public static IntPtr PrimaryCopy(IntPtr token, out string note)
        {
            note = "";
            IntPtr source = token, linked = IntPtr.Zero, copy = IntPtr.Zero;
            try
            {
                int type, returned;
                if (GetTokenInformation(token, TokenElevationType, out type, 4, out returned) && type == TokenElevationTypeFull)
                {
                    if (GetTokenInformation(token, TokenLinkedToken, out linked, IntPtr.Size, out returned) && linked != IntPtr.Zero)
                    {
                        if (DuplicateTokenEx(linked, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out copy)) { note = "limited"; return copy; }
                        copy = IntPtr.Zero;
                    }
                    note = "full (no limited half)";
                }
                if (!DuplicateTokenEx(source, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out copy)) throw new Win32Exception();
                return copy;
            }
            finally { if (linked != IntPtr.Zero) CloseHandle(linked); }
        }

        /// The user's Local AppData by the shell for that token; the ProfileList registry as fallback.
        public static string LocalAppData(IntPtr token, string userSid)
        {
            try
            {
                IntPtr path;
                if (SHGetKnownFolderPath(LocalAppDataFolder, 0, token, out path) == 0 && path != IntPtr.Zero)
                {
                    try { string text = Marshal.PtrToStringUni(path); if (!string.IsNullOrEmpty(text)) return text; }
                    finally { CoTaskMemFree(path); }
                }
            }
            catch (Exception) { }
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + userSid))
            {
                string profile = key == null ? null : key.GetValue("ProfileImagePath") as string;
                if (string.IsNullOrEmpty(profile)) return null;
                return Path.Combine(Environment.ExpandEnvironmentVariables(profile), "AppData", "Local");
            }
        }

        /// The file name of a live process's image ("Autark.exe"); null when the process does not live or cannot be asked.
        public static string ImageOf(long pid)
        {
            if (pid <= 0 || pid > uint.MaxValue) return null;
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
            if (process == IntPtr.Zero) return null;
            try
            {
                uint code;
                if (!GetExitCodeProcess(process, out code) || code != STILL_ACTIVE) return null;
                StringBuilder name = new StringBuilder(1024);
                int size = name.Capacity;
                if (!QueryFullProcessImageName(process, 0, name, ref size)) return null;
                return Path.GetFileName(name.ToString());
            }
            finally { CloseHandle(process); }
        }

        /// The person's own environment (HKCU\Environment, the machine's, the profile's) as "K=V" entries.
        public static List<string> UserEnvironment(IntPtr token)
        {
            IntPtr block;
            if (!CreateEnvironmentBlock(out block, token, false)) throw new Win32Exception();
            try
            {
                List<string> entries = new List<string>();
                int offset = 0;
                while (true)
                {
                    string entry = Marshal.PtrToStringUni(new IntPtr(block.ToInt64() + offset));
                    if (string.IsNullOrEmpty(entry)) break;
                    entries.Add(entry);
                    offset += (entry.Length + 1) * 2;
                }
                return entries;
            }
            finally { DestroyEnvironmentBlock(block); }
        }

        /// CreateProcessAsUser with the person's primary token and a Unicode environment block; returns the new process id and (in
        /// `process`) the process handle, which the caller closes (WakerNative.Close): it keeps the exit code readable after the end.
        public static int Start(IntPtr userToken, string exe, string commandLine, string currentDirectory, string desktop, string environmentBlock, out IntPtr process)
        {
            process = IntPtr.Zero;
            IntPtr environment = Marshal.StringToHGlobalUni(environmentBlock);
            try
            {
                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.lpDesktop = desktop;
                PROCESS_INFORMATION info;
                if (!CreateProcessAsUser(userToken, exe, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                    environment, currentDirectory, ref startup, out info))
                    throw new Win32Exception();
                CloseHandle(info.hThread);
                process = info.hProcess;
                return info.dwProcessId;
            }
            finally { Marshal.FreeHGlobal(environment); }
        }

        /// The exit code of a process that has ended (by its handle), else WakerBackoff.UnknownExit (it still runs, or cannot be asked).
        public static long ExitCodeOf(IntPtr process)
        {
            uint code;
            if (process == IntPtr.Zero || !GetExitCodeProcess(process, out code) || code == STILL_ACTIVE) return WakerBackoff.UnknownExit;
            return code;
        }
    }

    /// The service's wake-helper supervisor: a 15 s timer plus a poke at each session change. Never throws out of a tick.
    public sealed class WakerSupervisor
    {
        public const int PeriodMs = 15000;
        const int MaxRegistrations = 16;

        sealed class Entry
        {
            public string FileName;
            public string Invalid;
            public WakerRegistration Registration;
            public WakerFacts Facts;
        }

        readonly string userSid;
        readonly object gate = new object();
        readonly Dictionary<string, WakerBackoff> backoffs = new Dictionary<string, WakerBackoff>();
        readonly Dictionary<string, string> notes = new Dictionary<string, string>();
        /// Per registration: the process handle of the helper started last, until its start is judged (its exit code is read from it).
        readonly Dictionary<string, IntPtr> handles = new Dictionary<string, IntPtr>();
        System.Threading.Timer timer;
        bool stopped;

        public WakerSupervisor(string userSid) { this.userSid = userSid; }

        public void Start()
        {
            lock (gate)
            {
                if (stopped || timer != null) return;
                timer = new System.Threading.Timer(_ => Tick(), null, 5000, PeriodMs);
            }
        }

        public void Stop()
        {
            lock (gate)
            {
                stopped = true;
                if (timer != null) { timer.Dispose(); timer = null; }
                foreach (string key in new List<string>(handles.Keys)) Release(key);
            }
        }

        /// A session change (logon, unlock): one tick off the service thread.
        public void Poke() { ThreadPool.QueueUserWorkItem(_ => Tick()); }

        public void Tick()
        {
            if (!Monitor.TryEnter(gate)) return; // a tick is running; the next one follows
            try
            {
                if (stopped) return;
                TickLocked();
            }
            catch (Exception e) { Note("", "tick failed: " + e.GetType().Name + ": " + e.Message, true); }
            finally { Monitor.Exit(gate); }
        }

        void TickLocked()
        {
            uint session = WakerNative.WTSGetActiveConsoleSessionId();
            if (session == WakerNative.NoSession) { Note("", "no console session", false); return; }
            IntPtr userToken, token = IntPtr.Zero;
            if (!WakerNative.QueryUserToken(session, out userToken)) { Note("", "nobody signed in at the console", false); return; }
            try
            {
                string sid = WakerNative.SidOf(userToken);
                if (!string.Equals(sid, userSid, StringComparison.OrdinalIgnoreCase)) { Note("", "another user at the console", false); return; }
                string tokenNote;
                token = WakerNative.PrimaryCopy(userToken, out tokenNote);
                Note("", "console user " + (tokenNote.Length > 0 ? tokenNote + " token" : "signed in"), false);
                List<Entry> entries = ReadAsUser(token);
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                bool? installer = null;
                foreach (Entry entry in entries)
                {
                    seen.Add(entry.FileName);
                    if (entry.Registration == null) { Note(entry.FileName, "ignored: " + entry.Invalid, false); continue; }
                    WakerRegistration registration = entry.Registration;
                    WakerBackoff backoff;
                    if (!backoffs.TryGetValue(entry.FileName, out backoff)) { backoff = new WakerBackoff(); backoffs[entry.FileName] = backoff; }
                    WakerFacts facts = entry.Facts;
                    facts.ExeName = Path.GetFileName(registration.Exe);
                    facts.HelperName = registration.Helper.Length > 0 ? Path.GetFileName(registration.Helper) : "";
                    facts.ImageOf = WakerNative.ImageOf;
                    long now = NowMs();
                    IntPtr started;
                    handles.TryGetValue(entry.FileName, out started);
                    bool helperAlive = facts.IsHelper(backoff.HelperPid);
                    backoff.Observe(now, helperAlive, helperAlive ? WakerBackoff.UnknownExit : WakerNative.ExitCodeOf(started));
                    if (backoff.Judged) Release(entry.FileName); // judged: the helper's handle has told what it could
                    facts.OwnHelperPid = backoff.HelperPid;
                    if (!installer.HasValue) installer = InstallerRunning(session);
                    facts.InstallerRunning = installer.Value;
                    string why = WakerPolicy.Decide(facts, backoff, now);
                    if (why != null) { if (why != "backoff") Note(entry.FileName, why, false); continue; }
                    bool native = backoff.UseNative(registration);
                    try
                    {
                        // The slim native helper when the registration names it (and it has not failed twice in a row), else the Node
                        // helper – both with the person's token, in the person's session, never as SYSTEM.
                        string program = native ? registration.Helper : registration.Exe;
                        string command = native
                            ? WakerCommandLine.BuildNative(registration.Helper, registration.Exe, registration.WakeFile, registration.Args)
                            : WakerCommandLine.Build(registration.Exe, registration.Script, registration.WakeFile, registration.Args);
                        string block = WakerEnvironment.Build(WakerNative.UserEnvironment(token), !native);
                        IntPtr process;
                        int pid = WakerNative.Start(token, program, command, Path.GetDirectoryName(registration.Exe), "winsta0\\default", block, out process);
                        Release(entry.FileName);
                        handles[entry.FileName] = process;
                        backoff.Started(now, pid, native);
                        notes[entry.FileName] = "started";
                        Program.Log("waker " + entry.FileName + " started " + (native ? "native" : "node") + " helper " + pid + " in session " + session);
                    }
                    catch (Exception e)
                    {
                        backoff.Failed(now, native);
                        notes[entry.FileName] = "start failed";
                        Program.Log("waker " + entry.FileName + " start failed: " + e.GetType().Name + ": " + e.Message);
                    }
                }
                Forget(seen);
            }
            finally
            {
                WakerNative.Close(token);
                WakerNative.Close(userToken);
            }
        }

        /// Closes the process handle kept for a registration's last helper (it serves only to read the exit code once).
        void Release(string key)
        {
            IntPtr handle;
            if (!handles.TryGetValue(key, out handle)) return;
            handles.Remove(key);
            WakerNative.Close(handle);
        }

        /// Removed registrations drop their memory: switching the waker off and on starts clean.
        void Forget(HashSet<string> seen)
        {
            foreach (string key in new List<string>(handles.Keys)) if (!seen.Contains(key)) Release(key);
            foreach (string key in new List<string>(backoffs.Keys)) if (!seen.Contains(key)) backoffs.Remove(key);
            foreach (string key in new List<string>(notes.Keys)) if (key.Length > 0 && !seen.Contains(key)) notes.Remove(key);
        }

        /// Every file of the person's profile is read here, as the person.
        List<Entry> ReadAsUser(IntPtr token)
        {
            string local = WakerNative.LocalAppData(token, userSid);
            List<Entry> entries = new List<Entry>();
            if (string.IsNullOrEmpty(local)) return entries;
            using (WindowsIdentity identity = new WindowsIdentity(token))
            {
                WindowsImpersonationContext context = identity.Impersonate();
                try
                {
                    string folder = Path.Combine(local, "AutarkDesktopBroker", "wakers");
                    if (!Directory.Exists(folder)) return entries;
                    string[] files = Directory.GetFiles(folder, "*.json");
                    Array.Sort(files, StringComparer.OrdinalIgnoreCase);
                    foreach (string file in files)
                    {
                        if (entries.Count >= MaxRegistrations) break;
                        Entry entry = new Entry();
                        entry.FileName = Path.GetFileName(file);
                        try
                        {
                            long length = new FileInfo(file).Length;
                            string text = length > WakerRegistration.MaxBytes ? null : File.ReadAllText(file);
                            entry.Registration = WakerRegistration.Parse(entry.FileName, text, length, File.Exists, out entry.Invalid);
                        }
                        catch (Exception) { entry.Invalid = "unreadable"; }
                        if (entry.Registration != null)
                        {
                            WakerFacts facts = new WakerFacts();
                            facts.WakeFileExists = File.Exists(entry.Registration.WakeFile);
                            if (facts.WakeFileExists)
                            {
                                facts.ApplyRunState(ReadSmall(entry.Registration.RunStateFile));
                                facts.ApplySleeper(ReadSmall(entry.Registration.SleeperFile));
                            }
                            entry.Facts = facts;
                        }
                        entries.Add(entry);
                    }
                    return entries;
                }
                finally { context.Undo(); }
            }
        }

        static string ReadSmall(string file)
        {
            try
            {
                FileInfo info = new FileInfo(file);
                if (!info.Exists || info.Length > WakerRegistration.MaxBytes) return null;
                return File.ReadAllText(file);
            }
            catch (Exception) { return null; }
        }

        static bool InstallerRunning(uint session)
        {
            Process[] all;
            try { all = Process.GetProcesses(); } catch (Exception) { return false; }
            bool found = false;
            foreach (Process process in all)
            {
                try
                {
                    if (!found && (uint)process.SessionId == session && WakerPolicy.LooksLikeInstaller(process.ProcessName)) found = true;
                }
                catch (Exception) { }
                finally { process.Dispose(); }
            }
            return found;
        }

        /// One log line when the reason for a registration (key "" = the service's own view) changes.
        void Note(string key, string reason, bool always)
        {
            string last;
            if (!always && notes.TryGetValue(key, out last) && last == reason) return;
            notes[key] = reason;
            Program.Log("waker " + (key.Length > 0 ? key + " " : "") + reason);
        }

        static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
    }
}
