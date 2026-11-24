// Unit tests for the pure parts of resources/broker/SignIn.cs (SignInPolicy, SignInPlanner, SignInResults), compiled with
// csc by test/unit/computer/signin.test.ts. Prints "PASS <name>" or "FAIL <name>: <why>" per case and exits 1 on any failure.
// Never touches LSA, the registry, UI Automation or a real password.

using System;
using System.Collections.Generic;

namespace AutarkBroker
{
    /// Broker.cs's Program.Log, which SignIn.cs calls (the tests compile SignIn.cs without the service).
    public static class Program { public static void Log(string line) { } }

    public static class SignInTests
    {
        static int failed;

        static void Case(string name, Func<string> body)
        {
            string why;
            try { why = body(); } catch (Exception e) { why = e.GetType().Name + ": " + e.Message; }
            if (why == null) Console.WriteLine("PASS " + name);
            else { failed++; Console.WriteLine("FAIL " + name + ": " + why); }
        }

        static string Expect(object actual, object expected, string what)
        {
            return Equals(actual, expected) ? null : what + ": expected " + expected + ", got " + actual;
        }

        static UiNode N(string role, string name, string id = "", bool password = false) { return new UiNode(role, name, id, password); }

        static readonly List<string> Users = new List<string> { "Heess", "Stanislaus Hees" };
        static readonly TimeSpan Early = TimeSpan.FromMinutes(1);

        public static int Main()
        {
            Case("policy: signs in right after boot with a stored password and nobody signed in", () =>
                Expect(SignInPolicy.Decide(true, new SignInState(), false, Early, 100), null, "decision"));
            Case("policy: without a stored password nothing happens", () =>
                Expect(SignInPolicy.Decide(false, new SignInState(), false, Early, 100), "no_password", "decision"));
            Case("policy: a suspended sign-in waits for a new password", () =>
                Expect(SignInPolicy.Decide(true, new SignInState { Suspended = true }, false, Early, 100), "suspended", "decision"));
            Case("policy: a signed-in user is never touched", () =>
                Expect(SignInPolicy.Decide(true, new SignInState(), true, Early, 100), "user_present", "decision"));
            Case("policy: a sign-in screen long after boot (someone signed out) is left alone", () =>
                Expect(SignInPolicy.Decide(true, new SignInState(), false, TimeSpan.FromMinutes(40), 100), "not_after_boot", "decision"));
            Case("policy: one attempt per boot", () =>
                Expect(SignInPolicy.Decide(true, new SignInState { LastAttemptBoot = 100 }, false, Early, 100), "tried_this_boot", "decision"));
            Case("policy: the next boot may try again", () =>
                Expect(SignInPolicy.Decide(true, new SignInState { LastAttemptBoot = 99, Failures = 1 }, false, Early, 100), null, "decision"));

            Case("record: a refused password suspends at once (no lockout from retries)", () =>
            {
                SignInState s = new SignInState();
                SignInPolicy.Record(s, SignInResults.WrongPassword, 100, 5);
                return Expect(s.Suspended, true, "suspended") ?? Expect(s.LastAttemptBoot, 100L, "boot");
            });
            Case("record: two boots without success suspend", () =>
            {
                SignInState s = new SignInState();
                SignInPolicy.Record(s, SignInResults.Timeout, 100, 5);
                string first = Expect(s.Suspended, false, "after one");
                SignInPolicy.Record(s, SignInResults.UnknownScreen, 101, 6);
                return first ?? Expect(s.Suspended, true, "after two") ?? Expect(s.Failures, 2, "failures");
            });
            Case("record: success resets failures and leaves a lock to the app when wished", () =>
            {
                SignInState s = new SignInState { Failures = 1, LockAfter = true };
                SignInPolicy.Record(s, SignInResults.SignedIn, 100, 7);
                return Expect(s.Failures, 0, "failures") ?? Expect(s.LastSignInUtc, 7L, "signed in at") ?? Expect(s.Handled, false, "handled");
            });
            Case("record: success without the lock wish needs nothing from the app", () =>
            {
                SignInState s = new SignInState();
                SignInPolicy.Record(s, SignInResults.SignedIn, 100, 7);
                return Expect(s.Handled, true, "handled");
            });
            Case("record: someone signing in first is no failure", () =>
            {
                SignInState s = new SignInState();
                SignInPolicy.Record(s, SignInResults.UserPresent, 100, 7);
                return Expect(s.Failures, 0, "failures") ?? Expect(s.Suspended, false, "suspended");
            });
            Case("stored: a new password lifts the suspension", () =>
            {
                SignInState s = new SignInState { Suspended = true, Reason = "x", Failures = 2 };
                SignInPolicy.Stored(s, true);
                return Expect(s.Suspended, false, "suspended") ?? Expect(s.Failures, 0, "failures") ?? Expect(s.LockAfter, true, "lock after");
            });
            Case("results: exit codes round-trip", () =>
            {
                foreach (string r in new[] { SignInResults.SignedIn, SignInResults.WrongPassword, SignInResults.UnknownScreen, SignInResults.Timeout, SignInResults.NoSecret, SignInResults.UserPresent, SignInResults.Error })
                    if (SignInResults.FromExitCode(SignInResults.ExitCode(r)) != r) return r;
                return null;
            });

            // The sign-in screen as seen on teydra-server (20.11.2026, lock screen; German Windows, Microsoft account).
            Case("planner: the curtain is opened first", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("pane", "Sperrbildschirm", "InvokableLockContentControl") }, Users, false).Action, SignInAction.Reveal, "action"));
            Case("planner: PIN is default – it opens the sign-in options", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "PIN"), N("hyperlink", "Anmeldeoptionen") }, Users, false).Action, SignInAction.Options, "action"));
            Case("planner: it picks the Microsoft account password provider", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("hyperlink", "Anmeldeoptionen"), N("button", "PIN (Windows Hello)"), N("button", "Kennwort für Microsoft-Konto") }, Users, false).Action, SignInAction.PasswordProvider, "action"));
            Case("planner: password field and Submit: fill, then Submit", () =>
            {
                UiNode submit = N("button", "Übermitteln");
                SignInStep step = SignInPlanner.Next(new List<UiNode> { N("edit", "Kennwort", "PasswordField_2", true), submit }, Users, false);
                return Expect(step.Action, SignInAction.Fill, "action") ?? Expect(step.Submit, submit, "submit");
            });
            Case("planner: English Windows works the same", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "Password", "", true), N("button", "Submit") }, Users, false).Action, SignInAction.Fill, "action"));
            Case("planner: a visible-text field that is not a password field is never filled", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "Kennwort", "", false), N("button", "Übermitteln") }, Users, false).Action, SignInAction.Wait, "action"));
            Case("planner: after Submit it only waits (never a second submit)", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "Kennwort", "", true), N("button", "Übermitteln") }, Users, true).Action, SignInAction.Wait, "action"));
            Case("planner: Windows refusing the password ends the run", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("text", "Das Kennwort ist falsch. Versuchen Sie es erneut."), N("button", "OK") }, Users, true).Action, SignInAction.WrongPassword, "action"));
            Case("planner: with several users it picks the broker's own tile", () =>
            {
                UiNode own = N("listitem", "Stanislaus Hees");
                SignInStep step = SignInPlanner.Next(new List<UiNode> { N("listitem", "Gast"), own }, Users, false);
                return Expect(step.Action, SignInAction.PickUser, "action") ?? Expect(step.Target, own, "tile");
            });
            Case("planner: with only other users' tiles it stops (never types our password for them)", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("listitem", "Gast"), N("listitem", "Anna") }, Users, false).Action, SignInAction.Unknown, "action"));
            Case("planner: a password field without a Submit button is not filled", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "Kennwort", "", true) }, Users, false).Action, SignInAction.Unknown, "action"));
            // After a restart (24.11.2026, unknown_screen at 07:46): Windows Hello's PIN box is a password box too.
            Case("planner: a PIN password box is never filled – it opens the sign-in options", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "PIN", "PinEntry", true), N("hyperlink", "Anmeldeoptionen") }, Users, false).Action, SignInAction.Options, "action"));
            Case("planner: a PIN box with a Submit button is still not filled", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "PIN", "", true), N("button", "Übermitteln"), N("hyperlink", "Sign-in options") }, Users, false).Action, SignInAction.Options, "action"));
            Case("planner: PIN box and the providers shown: it picks the password provider", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "PIN", "", true), N("hyperlink", "Anmeldeoptionen"), N("button", "PIN (Windows Hello)"), N("button", "Kennwort für Microsoft-Konto") }, Users, false).Action, SignInAction.PasswordProvider, "action"));
            Case("planner: the curtain over a PIN box is not clicked again", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("pane", "Sperrbildschirm", "InvokableLockContentControl"), N("edit", "PIN", "", true), N("hyperlink", "Anmeldeoptionen") }, Users, false).Action, SignInAction.Options, "action"));
            Case("planner: a PIN box alone is an unknown screen (never filled)", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "PIN", "", true) }, Users, false).Action, SignInAction.Unknown, "action"));
            Case("planner: a password box named 'Kennwort oder PIN' is a password box", () =>
                Expect(SignInPlanner.Next(new List<UiNode> { N("edit", "Kennwort oder PIN", "", true), N("button", "Übermitteln") }, Users, false).Action, SignInAction.Fill, "action"));
            Case("describe: roles, ids and names for broker.log, cut, never more than 40", () =>
            {
                List<UiNode> nodes = new List<UiNode> { N("pane", "Sperrbildschirm", "InvokableLockContentControl"), N("edit", "PIN", "PinEntry", true), N("group", "ignored") };
                for (int i = 0; i < 50; i++) nodes.Add(N("button", "Taste " + i + " mit einem sehr langen Namen, der gekürzt wird"));
                string text = SignInPlanner.Describe(nodes);
                return Expect(text.StartsWith("53 elements: pane#InvokableLockContentControl 'Sperrbildschirm'; edit#PinEntry 'PIN' (password); button 'Taste 0 mit"), true, "start: " + text)
                    ?? Expect(text.Contains("ignored"), false, "group shown")
                    ?? Expect(text.EndsWith(" …"), true, "cut at 40")
                    ?? Expect(text.Contains("gekürzt wird"), false, "names cut");
            });
            Case("planner: an empty screen (still booting) waits", () =>
                Expect(SignInPlanner.Next(new List<UiNode>(), Users, false).Action, SignInAction.Wait, "action"));

            Console.WriteLine(failed == 0 ? "ALL PASS" : failed + " FAILED");
            return failed == 0 ? 0 : 1;
        }
    }
}
