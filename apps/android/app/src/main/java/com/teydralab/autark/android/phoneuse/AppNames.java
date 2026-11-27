// Owns: which installed app a name means for phone.open's `app` (owner 20.11.2026, Konrad 19.11.: he guessed two package
// names for SimplySign, both wrong, and never opened it) – the name under the app's icon, compared without case, spaces,
// punctuation and accents: the one app of that name first, then the one whose name starts with it, then the one whose
// name contains it. Two apps that fit the same (two icons called "Wallet") open neither: the AI reads their names with
// their packages, else the phone's apps, so its next try names one of them. Pure, so a host test pins it
// (test/phoneuse/AppNamesTest.java); UseService lists the launcher's icons and starts the matched one.
// Never: opens anything itself, or guesses between two apps that fit the same.
package com.teydralab.autark.android.phoneuse;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TreeSet;

final class AppNames {
    /** How many names the AI reads when none fits. */
    static final int LISTED = 80;

    private AppNames() {}

    /** The launcher icon called `name` among `apps` ({label, package, activity} each), or null without one clear app. */
    static String[] match(List<String[]> apps, String name) {
        List<String[]> fit = close(apps, key(name));
        return fit.size() == 1 ? fit.get(0) : null;
    }

    /** What I read when no app clearly is `name`: the apps that fit it (with their packages), else the phone's apps. */
    static String missing(List<String[]> apps, String name) {
        List<String[]> fit = close(apps, key(name));
        String shown = name == null ? "" : name.trim();
        if (!fit.isEmpty()) {
            StringBuilder list = new StringBuilder();
            for (String[] app : fit) {
                if (list.length() > 0) list.append(", ");
                list.append(app[0]).append(" (").append(app[1]).append(')');
            }
            return "Several apps fit \"" + shown + "\": " + list + ". I open one of them by its full name or its package.";
        }
        return "No app named \"" + shown + "\" is on this phone. Its apps: " + names(apps) + ".";
    }

    /**
     * What I read when Android was asked to start `pkg` but it did not come to the front within `ms` (27.11.2026: an open
     * said "opened" while the app never showed): which app is in front instead, and the way on – never "opened".
     */
    static String notInFront(String shown, String pkg, String front, long ms) {
        String name = shown == null || shown.trim().isEmpty() ? pkg : shown.trim() + " (" + pkg + ")";
        String instead = front == null || front.isEmpty() ? "no readable app is in front" : front + " is in front";
        return "Android was asked to start " + name + ", but it did not come to the front within " + (ms / 1000) + " s – " + instead
                + ". phone.screenshot shows the screen; phone.key home, then phone.open again starts it fresh.";
    }

    /** The apps of that name; else those whose name starts with it; else those whose name contains it. */
    private static List<String[]> close(List<String[]> apps, String want) {
        List<String[]> out = new ArrayList<>();
        if (want.isEmpty()) return out;
        for (int pass = 0; pass < 3 && out.isEmpty(); pass++) {
            for (String[] app : apps) {
                String label = key(app[0]);
                if (pass == 0 ? label.equals(want) : pass == 1 ? label.startsWith(want) : label.contains(want)) out.add(app);
            }
        }
        return out;
    }

    private static String names(List<String[]> apps) {
        TreeSet<String> sorted = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        for (String[] app : apps) if (app[0] != null && !app[0].trim().isEmpty()) sorted.add(app[0].trim());
        StringBuilder out = new StringBuilder();
        int count = 0;
        for (String label : sorted) {
            if (count == LISTED) { out.append(", …"); break; }
            if (count++ > 0) out.append(", ");
            out.append(label);
        }
        return out.toString();
    }

    /** "Simply Sign!" → "simplysign", "Échéancier" → "echeancier". */
    static String key(String text) {
        if (text == null) return "";
        String plain = Normalizer.normalize(text, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        return plain.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+", "");
    }
}
