// Owns: when the resting to-do dot steps aside (task_k8nekw1z; S9 check 27.11.2026: in the open Autark app the dot sat on
// the Tasks input "Add anything") – while the app is in front and the dot only rests, it lies at the side edge as the slim
// tab (the place the person moved it to stays stored; nothing is written), and it is back at once when the app goes, the
// person touches the dot or the tab, or anything wakes it: a drag, a hold, a call, a shot, a send, the panel, the AI at work
// or its question. Pure Java, so a host test pins it; TodoButton draws it.
// Never: stores a place, writes a preference, or docks a dot the person already made a tab or one that is doing something.
package com.teydralab.autark.android.phoneuse;

final class DotDodge {
    /** After the app left the front the dot waits this long before it returns: a quick pause (a dialog, the next screen
     *  of the app) never makes it blink. */
    static final long LEAVE_MS = 250;
    /** While the app is in front the state is looked at this often (the AI starts, a question comes). */
    static final long POLL_MS = 400;

    private DotDodge() {}

    /**
     * Whether the dot lies at the side now.
     * @param appFront      the Autark app (its main screen) is in front
     * @param atRest        the button shows as the dot (or as the dodged tab) – not the panel, not a stored tab
     * @param storedTab     the person made it a tab themselves (it is a tab anyway)
     * @param engaged       something goes on at the dot: a drag, a hold, a call, a shot, a send, the AI at work or its question
     * @param touched       the person touched the dodged tab in this visit of the app: the dot stays where they put it
     */
    static boolean docks(boolean appFront, boolean atRest, boolean storedTab, boolean engaged, boolean touched) {
        return appFront && atRest && !storedTab && !engaged && !touched;
    }
}
