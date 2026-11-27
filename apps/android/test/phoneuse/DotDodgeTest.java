// Owns: host checks of DotDodge – the resting to-do dot lies at the side while the Autark app is in front (task_k8nekw1z; S9
// check 27.11.2026: it sat on the Tasks input "Add anything") and returns when the app goes, the person touches the tab, or
// anything goes on at the dot; a tab the person made stays; nothing is stored; and the wiring (MainActivity tells the
// service, TodoButton asks DotDodge, the dodge writes no preference). Never: a device test.
package com.teydralab.autark.android.phoneuse;

public final class DotDodgeTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    private static String source(String path) throws java.io.IOException {
        return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(System.getProperty("autark.android"), path)), java.nio.charset.StandardCharsets.UTF_8).replace("\r\n", "\n");
    }

    public static void main(String[] args) throws Exception {
        //                     front  rest   stored engaged touched
        check(DotDodge.docks(true, true, false, false, false), "the open app and a resting dot: the dot steps aside");
        check(!DotDodge.docks(false, true, false, false, false), "another app in front: the dot stays at its place");
        check(!DotDodge.docks(true, false, false, false, false), "the panel is open: it stays");
        check(!DotDodge.docks(true, true, true, false, false), "the person's own tab stays as it is");
        check(!DotDodge.docks(true, true, false, true, false), "a drag, a hold, a call, a shot, a send or the AI at work: back at its place");
        check(!DotDodge.docks(true, true, false, false, true), "the person touched the tab: the dot stays out for this visit");
        // every one of the four conditions alone undoes the dodge
        for (int mask = 0; mask < 32; mask++) {
            boolean front = (mask & 1) != 0, rest = (mask & 2) != 0, stored = (mask & 4) != 0, engaged = (mask & 8) != 0, touched = (mask & 16) != 0;
            boolean expected = front && rest && !stored && !engaged && !touched;
            check(DotDodge.docks(front, rest, stored, engaged, touched) == expected, "mask " + mask);
        }
        check(DotDodge.LEAVE_MS > 0 && DotDodge.LEAVE_MS <= 500, "a short wait before the dot returns (no blink between two screens of the app)");
        check(DotDodge.POLL_MS >= 200 && DotDodge.POLL_MS <= 1_000, "the AI's start is noticed within a second");

        String main = source("app/src/main/java/com/teydralab/autark/android/MainActivity.java");
        check(main.contains("UseService.appFront(true)"), "MainActivity tells the service the app is in front");
        check(main.contains("UseService.appFront(false)"), "MainActivity tells it the app left the front");
        String button = source("app/src/main/java/com/teydralab/autark/android/phoneuse/TodoButton.java");
        check(button.contains("DotDodge.docks(appFront, atRest, place.getBoolean(\"tab\", false), engaged(), dodgeTouched)"), "TodoButton asks DotDodge");
        String dodge = button.substring(button.indexOf("private void settleDodge()"), button.indexOf("private boolean tabLeft("));
        check(!dodge.contains("place.edit()") && !dodge.contains("putInt(") && !dodge.contains("putBoolean("), "the dodge stores nothing");
        check(button.contains("if (dodging) { dodgeTouched = true; show(Look.DOT); return; }"), "a touch on the dodged tab brings the dot back, stored nothing");
        System.out.println("DotDodgeTest ok (" + assertions + " checks)");
    }
}
