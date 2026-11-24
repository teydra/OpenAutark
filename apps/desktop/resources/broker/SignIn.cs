// Sign-in after a restart (22.11.2026): when Windows boots to its sign-in screen and nobody is signed in, the broker signs
// the installing user in itself – the same way an agent does it on the lock screen (UIA on the Winlogon desktop: the
// curtain pane, "Sign-in options", the password provider, the password field, Submit). It never sets AutoAdminLogon or
// Winlogon's DefaultPassword: a PC that boots without the stored password, or whose owner turned this off, shows the
// normal sign-in screen and lets nobody in.
//
// The password: the app hands it over sealed on the pipe (op 'signin_store', Worker.cs) when the person stores the
// Windows password for this; the worker (LocalSystem) checks it with LogonUser for the broker's user SID and keeps it as
// an LSA private datum of its own name (L$AutarkDesktopBroker.SignIn – local-only, readable by SYSTEM only), never in a
// file, the registry or a log. 'signin_clear' removes it. The state (no secret: counters, last result, the lock wish) lives in
// HKLM\SOFTWARE\AutarkDesktopBroker\SignIn.
//
// Guard: at most one attempt per boot, only within the first minutes after boot, only while the console session has no
// user; a refused password (the sign-in screen says so) or two boots in a row without success suspend it until the app
// stores a password again – so a changed Windows password never locks the account out.
//
// Owns: SignInPolicy (when to try, what a result does), SignInPlanner (the next UIA step on the sign-in screen),
// SignInVault (LSA + LogonUser), SignInStore (the state), SignInRunner (the role "signin <userSid>" the service starts in
// the console session) and SignInOps (the pipe ops). Never: writes Winlogon values, logs or returns the password, types it
// anywhere but a password field on the Winlogon desktop, or submits twice in one boot.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32;

namespace AutarkBroker
{
    /// What the broker remembers between boots (HKLM\SOFTWARE\AutarkDesktopBroker\SignIn); nothing secret.
    public sealed class SignInState
    {
        public bool Suspended;
        public string Reason = "";
        public int Failures;
        /// The boot (minutes since 1601, UTC, of the boot time) of the last attempt: one attempt per boot.
        public long LastAttemptBoot;
        public string LastResult = "";
        public long LastAttemptUtc;
        public long LastSignInUtc;
        public bool LockAfter;
        /// The app has handled the last sign-in (locked the screen when LockAfter, or decided not to).
        public bool Handled = true;
    }

    public static class SignInResults
    {
        public const string SignedIn = "signed_in";
        public const string WrongPassword = "wrong_password";
        public const string UnknownScreen = "unknown_screen";
        public const string Timeout = "timeout";
        public const string NoSecret = "no_secret";
        public const string UserPresent = "user_present";
        public const string Error = "error";

        public static int ExitCode(string result)
        {
            switch (result)
            {
                case SignedIn: return 0;
                case WrongPassword: return 10;
                case UnknownScreen: return 11;
                case Timeout: return 12;
                case NoSecret: return 13;
                case UserPresent: return 14;
                default: return 1;
            }
        }

        public static string FromExitCode(int code)
        {
            switch (code)
            {
                case 0: return SignedIn;
                case 10: return WrongPassword;
                case 11: return UnknownScreen;
                case 12: return Timeout;
                case 13: return NoSecret;
                case 14: return UserPresent;
                default: return Error;
            }
        }
    }

    /// When to try and what a result changes – pure, so it is tested without Windows state.
    public static class SignInPolicy
    {
        /// Two boots in a row without a sign-in suspend it.
        public const int MaxFailures = 2;
        /// Only this long after boot: a later sign-in screen means someone signed out on purpose.
        public static readonly TimeSpan BootWindow = TimeSpan.FromMinutes(15);

        /// Null when the broker should sign in now, else why not (one word, for broker.log).
        public static string Decide(bool stored, SignInState state, bool userInConsole, TimeSpan uptime, long boot)
        {
            if (!stored) return "no_password";
            if (state.Suspended) return "suspended";
            if (userInConsole) return "user_present";
            if (uptime > BootWindow) return "not_after_boot";
            if (state.LastAttemptBoot == boot) return "tried_this_boot";
            return null;
        }

        /// The state after an attempt in `boot` ended with `result`.
        public static void Record(SignInState state, string result, long boot, long nowUtc)
        {
            state.LastAttemptBoot = boot;
            state.LastAttemptUtc = nowUtc;
            state.LastResult = result;
            if (result == SignInResults.SignedIn)
            {
                state.Failures = 0;
                state.LastSignInUtc = nowUtc;
                state.Handled = !state.LockAfter;
                return;
            }
            if (result == SignInResults.UserPresent) return; // someone was faster: no failure
            if (result == SignInResults.WrongPassword)
            {
                state.Suspended = true;
                state.Reason = "Windows refused the stored password (changed?). Store the current one again in Autark.";
                return;
            }
            state.Failures++;
            if (state.Failures >= MaxFailures)
            {
                state.Suspended = true;
                state.Reason = "No sign-in after " + state.Failures + " restarts (last: " + result + ").";
            }
        }

        /// A new password from the app: everything starts over.
        public static void Stored(SignInState state, bool lockAfter)
        {
            state.Suspended = false;
            state.Reason = "";
            state.Failures = 0;
            state.LockAfter = lockAfter;
        }
    }

    /// One element of the sign-in screen as the planner sees it.
    public sealed class UiNode
    {
        public string Role = "";
        public string Name = "";
        public string AutomationId = "";
        public bool IsPassword;
        public bool Enabled = true;
        public object Handle;

        public UiNode() { }
        public UiNode(string role, string name, string automationId, bool isPassword)
        {
            Role = role ?? ""; Name = name ?? ""; AutomationId = automationId ?? ""; IsPassword = isPassword;
        }
    }

    public enum SignInAction { Wait, Reveal, RevealKey, PickUser, Options, PasswordProvider, Fill, Submit, WrongPassword, Unknown }

    public sealed class SignInStep
    {
        public SignInAction Action;
        public UiNode Target;
        /// For Fill: the Submit button pressed right after.
        public UiNode Submit;
        public SignInStep(SignInAction action, UiNode target) { Action = action; Target = target; }
    }

    /// The next step on the Windows sign-in screen (German and English Windows; automation ids first, names as fallback).
    public static class SignInPlanner
    {
        static readonly string[] SubmitNames = { "Übermitteln", "Submit", "Anmelden", "Sign in" };
        static readonly string[] OptionNames = { "Anmeldeoptionen", "Sign-in options" };
        static readonly string[] PasswordWords = { "Kennwort", "Passwort", "Password" };
        static readonly string[] WrongWords = { "falsch", "nicht korrekt", "incorrect", "is wrong" };
        static readonly string[] PinWords = { "PIN" };

        /// `submitted`: this run already pressed Submit (it never does twice). `users`: the account and display names of the broker's user.
        public static SignInStep Next(IList<UiNode> nodes, ICollection<string> users, bool submitted)
        {
            foreach (UiNode node in nodes)
                if ((node.Role == "text" || node.Role == "pane") && Contains(node.Name, WrongWords) && Contains(node.Name, PasswordWords))
                    return new SignInStep(SignInAction.WrongPassword, node);
            UiNode field = null, pin = null, submit = null, options = null, provider = null, curtain = null;
            bool clock = false;
            List<UiNode> tiles = new List<UiNode>();
            foreach (UiNode node in nodes)
            {
                // The lock screen's clock and date (24.11.2026 15:40, teydra-server): the curtain is down even when no element offers to open it.
                if (node.Role == "text" && (node.AutomationId == "TimeText" || node.AutomationId == "DayOfWeekText")) clock = true;
                if (!node.Enabled) continue;
                // Windows Hello's PIN box is a password box too (24.11.2026, teydra-server after a restart): never our password.
                if (node.Role == "edit" && node.IsPassword && IsPin(node) && pin == null) pin = node;
                else if (node.Role == "edit" && node.IsPassword && field == null) field = node;
                else if (node.Role == "button" && (node.AutomationId == "SubmitButton" || Equal(node.Name, SubmitNames)) && submit == null) submit = node;
                else if ((node.Role == "hyperlink" || node.Role == "button") && Equal(node.Name, OptionNames)) options = node;
                else if (node.Role == "button" && Contains(node.Name, PasswordWords) && provider == null) provider = node;
                else if (node.AutomationId == "InvokableLockContentControl") curtain = node;
                else if (node.Role == "listitem") tiles.Add(node);
            }
            if (submitted) return new SignInStep(SignInAction.Wait, null);
            if (curtain != null && field == null && pin == null) return new SignInStep(SignInAction.Reveal, curtain);
            // Only the clock: nothing to invoke, so a key lifts the curtain, as a person would do.
            if (clock && field == null && pin == null && options == null && provider == null && submit == null && tiles.Count == 0)
                return new SignInStep(SignInAction.RevealKey, null);
            if (tiles.Count > 1 && field == null && pin == null)
            {
                foreach (UiNode tile in tiles) if (Equal(tile.Name, users)) return new SignInStep(SignInAction.PickUser, tile);
                return new SignInStep(SignInAction.Unknown, null); // other users only: never type our password into their tile
            }
            if (field != null && submit != null)
            {
                SignInStep fill = new SignInStep(SignInAction.Fill, field);
                fill.Submit = submit;
                return fill;
            }
            // PIN (or a password box without Submit): switch to the password provider through the sign-in options.
            if (provider != null) return new SignInStep(SignInAction.PasswordProvider, provider);
            if (options != null) return new SignInStep(SignInAction.Options, options);
            if (field != null || pin != null) return new SignInStep(SignInAction.Unknown, field ?? pin);
            return new SignInStep(SignInAction.Wait, null);
        }

        /// A PIN box: its name or id says PIN and not password.
        static bool IsPin(UiNode node)
        {
            return (Contains(node.Name, PinWords) || Contains(node.AutomationId, PinWords)) && !Contains(node.Name, PasswordWords);
        }

        /// What the screen shows, for broker.log: role#id'name' per element (names cut at 40, at most 40 elements). It never
        /// reads a field's value – UiNode holds none.
        public static string Describe(IList<UiNode> nodes)
        {
            System.Text.StringBuilder text = new System.Text.StringBuilder();
            text.Append(nodes.Count).Append(" elements");
            int shown = 0;
            foreach (UiNode node in nodes)
            {
                if (node.Role != "button" && node.Role != "edit" && node.Role != "hyperlink" && node.Role != "listitem" && node.Role != "text" && string.IsNullOrEmpty(node.AutomationId)) continue;
                if (shown++ == 40) { text.Append(" …"); break; }
                string name = (node.Name ?? "").Replace('\r', ' ').Replace('\n', ' ');
                if (name.Length > 40) name = name.Substring(0, 40) + "…";
                text.Append(shown == 1 ? ": " : "; ").Append(node.Role);
                if (node.AutomationId.Length > 0) text.Append('#').Append(node.AutomationId);
                text.Append(" '").Append(name).Append('\'');
                if (node.IsPassword) text.Append(" (password)");
                if (!node.Enabled) text.Append(" (hidden)");
            }
            return text.ToString();
        }

        static bool Equal(string text, ICollection<string> words)
        {
            foreach (string word in words) if (string.Equals((text ?? "").Trim(), word, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        static bool Contains(string text, string[] words)
        {
            string lower = (text ?? "").ToLowerInvariant();
            foreach (string word in words) if (lower.Contains(word.ToLowerInvariant())) return true;
            return false;
        }
    }

    /// The broker's own copy of the Windows password: an LSA private datum (SYSTEM only, never leaves this PC).
    public static class SignInVault
    {
        public const string SecretName = "L$AutarkDesktopBroker.SignIn";

        public static bool Exists()
        {
            string value = Retrieve();
            bool found = value != null;
            Zero(value);
            return found;
        }

        public static void Store(string password) { Write(password); }
        public static void Clear() { Write(null); }

        /// The stored password or null; the caller zeroes it after use.
        public static string Retrieve()
        {
            IntPtr policy = Open(POLICY_GET_PRIVATE_INFORMATION);
            try
            {
                LSA_UNICODE_STRING name = Unicode(SecretName);
                IntPtr data;
                uint status = LsaRetrievePrivateData(policy, ref name, out data);
                Marshal.FreeHGlobal(name.Buffer);
                if (status == STATUS_OBJECT_NAME_NOT_FOUND) return null;
                Check(status);
                try
                {
                    LSA_UNICODE_STRING value = (LSA_UNICODE_STRING)Marshal.PtrToStructure(data, typeof(LSA_UNICODE_STRING));
                    return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
                }
                finally { LsaFreeMemory(data); }
            }
            finally { LsaClose(policy); }
        }

        static void Write(string password)
        {
            IntPtr policy = Open(POLICY_CREATE_SECRET);
            LSA_UNICODE_STRING name = Unicode(SecretName);
            try
            {
                uint status;
                if (password == null) status = LsaStorePrivateData(policy, ref name, IntPtr.Zero);
                else
                {
                    LSA_UNICODE_STRING value = Unicode(password);
                    IntPtr boxed = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(LSA_UNICODE_STRING)));
                    try
                    {
                        Marshal.StructureToPtr(value, boxed, false);
                        status = LsaStorePrivateData(policy, ref name, boxed);
                    }
                    finally
                    {
                        ZeroUnicode(value);
                        Marshal.FreeHGlobal(boxed);
                    }
                }
                if (password == null && status == STATUS_OBJECT_NAME_NOT_FOUND) return;
                Check(status);
            }
            finally
            {
                Marshal.FreeHGlobal(name.Buffer);
                LsaClose(policy);
            }
        }

        /// The account behind `userSid` as (domain, name); null when Windows does not know it.
        public static string[] AccountOf(string userSid)
        {
            try
            {
                string account = new SecurityIdentifier(userSid).Translate(typeof(NTAccount)).Value;
                int slash = account.IndexOf('\\');
                return slash < 0 ? new[] { ".", account } : new[] { account.Substring(0, slash), account.Substring(slash + 1) };
            }
            catch (Exception) { return null; }
        }

        /// 0 when `password` signs `userSid` in (LogonUser, interactive), else the Win32 error (1326: wrong name or password).
        public static int Verify(string userSid, string password)
        {
            string[] account = AccountOf(userSid);
            if (account == null) return 1332; // ERROR_NONE_MAPPED
            IntPtr token;
            if (!LogonUser(account[1], account[0], password, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, out token))
                return Marshal.GetLastWin32Error();
            try
            {
                using (WindowsIdentity identity = new WindowsIdentity(token))
                    return identity.User != null && identity.User.Value == userSid ? 0 : 1326;
            }
            finally { CloseHandle(token); }
        }

        internal static unsafe void Zero(string text)
        {
            if (text == null) return;
            fixed (char* chars = text) for (int i = 0; i < text.Length; i++) chars[i] = '\0';
        }

        static LSA_UNICODE_STRING Unicode(string text)
        {
            LSA_UNICODE_STRING value = new LSA_UNICODE_STRING();
            value.Buffer = Marshal.StringToHGlobalUni(text);
            value.Length = (ushort)(text.Length * 2);
            value.MaximumLength = (ushort)(text.Length * 2 + 2);
            return value;
        }

        static void ZeroUnicode(LSA_UNICODE_STRING value)
        {
            byte[] zeros = new byte[value.MaximumLength];
            Marshal.Copy(zeros, 0, value.Buffer, zeros.Length);
            Marshal.FreeHGlobal(value.Buffer);
        }

        static IntPtr Open(uint access)
        {
            LSA_OBJECT_ATTRIBUTES attributes = new LSA_OBJECT_ATTRIBUTES();
            attributes.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
            IntPtr policy;
            Check(LsaOpenPolicy(IntPtr.Zero, ref attributes, access, out policy));
            return policy;
        }

        static void Check(uint status)
        {
            if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        }

        const uint POLICY_GET_PRIVATE_INFORMATION = 0x00000004;
        const uint POLICY_CREATE_SECRET = 0x00000020;
        const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;
        const int LOGON32_LOGON_INTERACTIVE = 2;
        const int LOGON32_PROVIDER_DEFAULT = 0;

        [StructLayout(LayoutKind.Sequential)]
        struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

        [StructLayout(LayoutKind.Sequential)]
        struct LSA_OBJECT_ATTRIBUTES
        {
            public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes;
            public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
        }

        [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attributes, uint access, out IntPtr policy);
        [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr policy, ref LSA_UNICODE_STRING key, IntPtr data);
        [DllImport("advapi32.dll")] static extern uint LsaRetrievePrivateData(IntPtr policy, ref LSA_UNICODE_STRING key, out IntPtr data);
        [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr buffer);
        [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
        [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    }

    /// The state in HKLM\SOFTWARE\AutarkDesktopBroker\SignIn (SYSTEM writes, users may read: nothing secret).
    public static class SignInStore
    {
        public const string KeyPath = @"SOFTWARE\AutarkDesktopBroker\SignIn";

        public static SignInState Load()
        {
            SignInState state = new SignInState();
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(KeyPath))
            {
                if (key == null) return state;
                state.Suspended = Int(key, "Suspended") == 1;
                state.Reason = key.GetValue("Reason", "") as string ?? "";
                state.Failures = (int)Int(key, "Failures");
                state.LastAttemptBoot = Int(key, "LastAttemptBoot");
                state.LastResult = key.GetValue("LastResult", "") as string ?? "";
                state.LastAttemptUtc = Int(key, "LastAttemptUtc");
                state.LastSignInUtc = Int(key, "LastSignInUtc");
                state.LockAfter = Int(key, "LockAfter") == 1;
                state.Handled = Int(key, "Handled", 1) == 1;
            }
            return state;
        }

        public static void Save(SignInState state)
        {
            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(KeyPath))
            {
                key.SetValue("Suspended", state.Suspended ? 1 : 0, RegistryValueKind.DWord);
                key.SetValue("Reason", state.Reason ?? "", RegistryValueKind.String);
                key.SetValue("Failures", state.Failures, RegistryValueKind.DWord);
                key.SetValue("LastAttemptBoot", state.LastAttemptBoot, RegistryValueKind.QWord);
                key.SetValue("LastResult", state.LastResult ?? "", RegistryValueKind.String);
                key.SetValue("LastAttemptUtc", state.LastAttemptUtc, RegistryValueKind.QWord);
                key.SetValue("LastSignInUtc", state.LastSignInUtc, RegistryValueKind.QWord);
                key.SetValue("LockAfter", state.LockAfter ? 1 : 0, RegistryValueKind.DWord);
                key.SetValue("Handled", state.Handled ? 1 : 0, RegistryValueKind.DWord);
            }
        }

        public static void Delete()
        {
            try { Registry.LocalMachine.DeleteSubKeyTree(KeyPath, false); } catch (Exception) { }
        }

        static long Int(RegistryKey key, string name, long fallback = 0)
        {
            object value = key.GetValue(name);
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            return fallback;
        }
    }

    /// Facts about this boot and the console session.
    public static class SignInFacts
    {
        public static TimeSpan Uptime() { return TimeSpan.FromMilliseconds(GetTickCount64()); }

        /// Minutes since 1601 (UTC) of the boot time: the same number for the whole boot.
        public static long Boot()
        {
            DateTime boot = DateTime.UtcNow - Uptime();
            return boot.ToFileTimeUtc() / TimeSpan.TicksPerMinute;
        }

        public static long NowUtc() { return DateTime.UtcNow.ToFileTimeUtc() / TimeSpan.TicksPerMillisecond; }

        /// The user name of the console session ("" while the sign-in screen shows).
        public static string ConsoleUser()
        {
            uint session = WTSGetActiveConsoleSessionId();
            if (session == 0xFFFFFFFF) return "";
            IntPtr buffer;
            int bytes;
            if (!WTSQuerySessionInformation(IntPtr.Zero, session, WTSUserName, out buffer, out bytes)) return "";
            try { return Marshal.PtrToStringUni(buffer) ?? ""; } finally { WTSFreeMemory(buffer); }
        }

        const int WTSUserName = 5;
        [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
        [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool WTSQuerySessionInformation(IntPtr server, uint session, int infoClass, out IntPtr buffer, out int bytes);
        [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
    }

    /// The pipe ops (Worker.cs routes signin_* here): results are plain dictionaries, failures SignInException.
    public static class SignInOps
    {
        public static bool Handles(string op) { return op != null && op.StartsWith("signin_", StringComparison.Ordinal); }

        public static Dictionary<string, object> Run(string op, string userSid, string password, bool? lockAfter)
        {
            SignInState state = SignInStore.Load();
            switch (op)
            {
                case "signin_status":
                    return Status(userSid, state);
                case "signin_store":
                    if (string.IsNullOrEmpty(password)) throw new SignInException("bad_request", "No password was sent.");
                    int error = SignInVault.Verify(userSid, password);
                    if (error == 1326) throw new SignInException("wrong_password", "Windows does not accept this password for the account.");
                    if (error != 0) throw new SignInException("verify_failed", "Windows could not check the password (error " + error + ").");
                    SignInVault.Store(password);
                    SignInPolicy.Stored(state, lockAfter ?? state.LockAfter);
                    SignInStore.Save(state);
                    Program.Log("sign-in password stored");
                    return Status(userSid, state);
                case "signin_clear":
                    SignInVault.Clear();
                    SignInStore.Delete();
                    Program.Log("sign-in password removed");
                    return Status(userSid, new SignInState());
                case "signin_options":
                    if (lockAfter.HasValue) state.LockAfter = lockAfter.Value;
                    SignInStore.Save(state);
                    return Status(userSid, state);
                case "signin_handled":
                    state.Handled = true;
                    SignInStore.Save(state);
                    return Status(userSid, state);
                default:
                    throw new SignInException("bad_request", "Unknown op " + op + ".");
            }
        }

        static Dictionary<string, object> Status(string userSid, SignInState state)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            string[] account = SignInVault.AccountOf(userSid);
            d["account"] = account == null ? "" : account[0] + "\\" + account[1];
            d["stored"] = SignInVault.Exists();
            d["suspended"] = state.Suspended;
            d["reason"] = state.Reason ?? "";
            d["failures"] = state.Failures;
            d["lastResult"] = state.LastResult ?? "";
            d["lastAttemptAt"] = Epoch(state.LastAttemptUtc);
            d["lastSignInAt"] = Epoch(state.LastSignInUtc);
            d["lockAfter"] = state.LockAfter;
            d["pendingLock"] = state.LockAfter && !state.Handled && state.LastSignInUtc > 0;
            return d;
        }

        /// File-time milliseconds → Unix epoch milliseconds (0 stays 0).
        static double Epoch(long fileTimeMs) { return fileTimeMs <= 0 ? 0 : fileTimeMs - 11644473600000L; }
    }

    public sealed class SignInException : Exception
    {
        public readonly string Code;
        public SignInException(string code, string message) : base(message) { Code = code; }
    }

    /// The role "signin <userSid>": started by the service in the console session on winsta0\winlogon right after boot.
    /// Walks the sign-in screen with UI Automation (SignInPlanner), fills the password once, submits once and waits until
    /// the console session belongs to the user. Its exit code is the result (SignInResults).
    public static class SignInRunner
    {
        /// 10 min (Konrad 24.11.2026: a slow boot under memory pressure showed the sign-in screen late; 150 s ran out at 07:46).
        static readonly TimeSpan Budget = TimeSpan.FromMinutes(10);
        /// A screen the planner does not know is looked at again after this, not given up on.
        static readonly TimeSpan Retry = TimeSpan.FromSeconds(30);
        /// Clicks and keys on the way (curtain, options, provider, tile) in the whole run; Submit stays once.
        const int MaxActions = 40;
        static string lastScreen = "";
        static DateTime lastScreenLog = DateTime.MinValue;

        public static int Run(string userSid)
        {
            string result;
            try { result = Attempt(userSid); }
            catch (Exception e) { Program.Log("sign-in failed: " + e.GetType().Name); result = SignInResults.Error; }
            Program.Log("sign-in after restart: " + result);
            return SignInResults.ExitCode(result);
        }

        static string Attempt(string userSid)
        {
            string[] account = SignInVault.AccountOf(userSid);
            if (account == null) return SignInResults.Error;
            List<string> users = new List<string> { account[1] };
            string full = FullName(account[1]);
            if (!string.IsNullOrEmpty(full)) users.Add(full);
            Stopwatch clock = Stopwatch.StartNew();
            bool submitted = false;
            int actions = 0, unknown = 0;
            while (clock.Elapsed < Budget)
            {
                if (SignInFacts.ConsoleUser().Length > 0)
                    return submitted && string.Equals(SignInFacts.ConsoleUser(), account[1], StringComparison.OrdinalIgnoreCase) ? SignInResults.SignedIn : SignInResults.UserPresent;
                string outcome = OnInputDesktop(() => Step(users, submitted, ref actions));
                if (outcome == "submitted") submitted = true;
                else if (outcome == SignInResults.UnknownScreen)
                {
                    // Not a final answer: the screen may still be building, or a toast covers it. Look again in 30 s.
                    unknown++;
                    Thread.Sleep(Retry);
                    continue;
                }
                else if (outcome != null) return outcome;
                if (actions > MaxActions) { Program.Log("sign-in: " + actions + " clicks without a password field"); return SignInResults.UnknownScreen; }
                Thread.Sleep(1500);
            }
            Program.Log("sign-in: gave up after " + (int)clock.Elapsed.TotalSeconds + " s (" + unknown + " unknown screens, " + actions + " clicks, submitted " + submitted + ")");
            return submitted ? SignInResults.Timeout : SignInResults.UnknownScreen;
        }

        /// broker.log gets what the screen shows when it changes, and at most once a minute while it stays (no values).
        static void LogScreen(List<UiNode> nodes, SignInAction action)
        {
            string screen = SignInPlanner.Describe(nodes);
            if (screen == lastScreen && DateTime.UtcNow - lastScreenLog < TimeSpan.FromMinutes(1)) return;
            lastScreen = screen;
            lastScreenLog = DateTime.UtcNow;
            Program.Log("sign-in sees (" + action + "): " + screen);
        }

        /// One look and at most one action: null = go on, "submitted", or a final result.
        static string Step(List<string> users, bool submitted, ref int actions)
        {
            List<UiNode> nodes = Read();
            SignInStep step = SignInPlanner.Next(nodes, users, submitted);
            LogScreen(nodes, step.Action);
            switch (step.Action)
            {
                case SignInAction.Wait: return null;
                case SignInAction.WrongPassword: return SignInResults.WrongPassword;
                case SignInAction.Unknown: return SignInResults.UnknownScreen;
                case SignInAction.RevealKey:
                    actions++;
                    PressSpace();
                    return null;
                case SignInAction.Fill:
                    string password = SignInVault.Retrieve();
                    if (password == null) return SignInResults.NoSecret;
                    try { Value((System.Windows.Automation.AutomationElement)step.Target.Handle, password); }
                    finally { SignInVault.Zero(password); }
                    Invoke((System.Windows.Automation.AutomationElement)step.Submit.Handle);
                    return "submitted";
                default:
                    actions++;
                    Invoke((System.Windows.Automation.AutomationElement)step.Target.Handle);
                    return null;
            }
        }

        static List<UiNode> Read()
        {
            List<UiNode> nodes = new List<UiNode>();
            System.Windows.Automation.TreeWalker walker = System.Windows.Automation.TreeWalker.ControlViewWalker;
            Walk(walker, System.Windows.Automation.AutomationElement.RootElement, 0, nodes);
            return nodes;
        }

        static void Walk(System.Windows.Automation.TreeWalker walker, System.Windows.Automation.AutomationElement parent, int depth, List<UiNode> nodes)
        {
            if (depth > 14 || nodes.Count > 600) return;
            System.Windows.Automation.AutomationElement child = null;
            try { child = walker.GetFirstChild(parent); } catch (Exception) { return; }
            while (child != null && nodes.Count <= 600)
            {
                try
                {
                    System.Windows.Automation.AutomationElement.AutomationElementInformation info = child.Current;
                    UiNode node = new UiNode(Role(info.ControlType), info.Name, info.AutomationId, info.IsPassword);
                    node.Enabled = info.IsEnabled && !info.IsOffscreen;
                    node.Handle = child;
                    nodes.Add(node);
                }
                catch (Exception) { }
                Walk(walker, child, depth + 1, nodes);
                try { child = walker.GetNextSibling(child); } catch (Exception) { child = null; }
            }
        }

        static string Role(System.Windows.Automation.ControlType type)
        {
            string name = type == null ? "" : type.ProgrammaticName; // "ControlType.Edit"
            int dot = name.LastIndexOf('.');
            return (dot >= 0 ? name.Substring(dot + 1) : name).ToLowerInvariant();
        }

        static void Invoke(System.Windows.Automation.AutomationElement element)
        {
            object pattern;
            if (element.TryGetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern, out pattern)) { ((System.Windows.Automation.InvokePattern)pattern).Invoke(); return; }
            if (element.TryGetCurrentPattern(System.Windows.Automation.SelectionItemPattern.Pattern, out pattern)) { ((System.Windows.Automation.SelectionItemPattern)pattern).Select(); return; }
            throw new InvalidOperationException("not invokable");
        }

        /// One Space on the input desktop: lifts the lock screen's curtain. Fill replaces the field's whole value, so a Space that
        /// lands in a field is never part of the password.
        static void PressSpace()
        {
            keybd_event(0x20, 0x39, 0, UIntPtr.Zero);
            keybd_event(0x20, 0x39, 2, UIntPtr.Zero);
        }

        static void Value(System.Windows.Automation.AutomationElement element, string text)
        {
            object pattern;
            if (!element.TryGetCurrentPattern(System.Windows.Automation.ValuePattern.Pattern, out pattern)) throw new InvalidOperationException("no value pattern");
            element.SetFocus();
            ((System.Windows.Automation.ValuePattern)pattern).SetValue(text);
        }

        /// The display name the sign-in screen may show on the tile (NetUserGetInfo level 2), or null.
        static string FullName(string user)
        {
            IntPtr buffer;
            if (NetUserGetInfo(null, user, 2, out buffer) != 0) return null;
            try { return ((USER_INFO_2_HEAD)Marshal.PtrToStructure(buffer, typeof(USER_INFO_2_HEAD))).full_name; }
            catch (Exception) { return null; }
            finally { NetApiBufferFree(buffer); }
        }

        /// The leading fields of USER_INFO_2 up to usri2_full_name (the buffer holds the whole struct).
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct USER_INFO_2_HEAD
        {
            public string name; public IntPtr password; public int password_age; public int priv; public string home_dir; public string comment;
            public int flags; public string script_path; public int auth_flags; public string full_name;
        }

        /// Runs `work` on a fresh MTA thread attached to the input desktop (Winlogon while the sign-in screen shows).
        static string OnInputDesktop(Func<string> work)
        {
            string answer = null;
            Thread thread = new Thread(() =>
            {
                IntPtr handle = OpenInputDesktop(0, false, 0x01FF);
                if (handle == IntPtr.Zero) { LogOnce("sign-in: input desktop not open (error " + Marshal.GetLastWin32Error() + ")"); return; }
                try
                {
                    if (SetThreadDesktop(handle)) answer = work();
                    else LogOnce("sign-in: input desktop not entered (error " + Marshal.GetLastWin32Error() + ")");
                }
                catch (Exception e) { Program.Log("sign-in step failed: " + e.GetType().Name); }
                finally { CloseDesktop(handle); }
            });
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            thread.Join();
            return answer;
        }

        static readonly HashSet<string> logged = new HashSet<string>();
        static void LogOnce(string line) { lock (logged) { if (logged.Add(line)) Program.Log(line); } }

        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserGetInfo(string server, string user, int level, out IntPtr buffer);
        [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buffer);
    }
}
