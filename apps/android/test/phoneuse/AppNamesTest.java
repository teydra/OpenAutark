// Owns: host checks of which app a name means for phone.open's `app` (AppNames): the one app of that name without case,
// spaces, punctuation or accents first, then the one name that starts with it, then the one that contains it; two that
// fit the same – also two icons with the very same name – open neither, and the AI reads them with their packages (or
// the phone's apps). Never: a device test (the launcher list).
package com.teydralab.autark.android.phoneuse;

import java.util.Arrays;
import java.util.List;

public final class AppNamesTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    private static String pkg(String[] app) { return app == null ? null : app[1]; }

    public static void main(String[] args) {
        List<String[]> apps = Arrays.asList(
                new String[] { "SimplySign", "com.assecods.certum.simplysign", "com.assecods.certum.simplysign.Main" },
                new String[] { "Secure Folder", "com.samsung.knox.securefolder", "com.samsung.knox.securefolder.Start" },
                new String[] { "Google Wallet", "com.google.android.apps.walletnfcrel", "com.google.Wallet" },
                new String[] { "Wispr Flow", "com.wispr.flow", "com.wispr.flow.Main" },
                new String[] { "Échéancier", "fr.example.echeancier", "fr.example.echeancier.Main" },
                new String[] { "Banking", "de.bank.one", "de.bank.one.Main" },
                new String[] { "Banking", "de.bank.two", "de.bank.two.Main" });
        String[] simply = AppNames.match(apps, "SimplySign");
        check("com.assecods.certum.simplysign".equals(pkg(simply)) && "com.assecods.certum.simplysign.Main".equals(simply[2]), "the same name, with its launcher activity");
        check("com.assecods.certum.simplysign".equals(pkg(AppNames.match(apps, "simply sign"))), "without case and spaces");
        check("com.assecods.certum.simplysign".equals(pkg(AppNames.match(apps, "Simply"))), "the one name that starts with it");
        check("com.wispr.flow".equals(pkg(AppNames.match(apps, "flow"))), "the one name that contains it");
        check("fr.example.echeancier".equals(pkg(AppNames.match(apps, "echeancier"))), "without accents");
        check("com.google.android.apps.walletnfcrel".equals(pkg(AppNames.match(apps, "Wallet"))), "the one name that contains it");
        check(AppNames.match(apps, "s") == null, "several names start with it: none is guessed");
        check(AppNames.match(apps, "Banking") == null, "two icons with the very same name: none is guessed");
        check(AppNames.match(apps, "  ") == null && AppNames.match(apps, null) == null, "no name, no app");
        String several = AppNames.missing(apps, "s");
        check(several.contains("SimplySign (com.assecods.certum.simplysign)") && several.contains("Secure Folder") && several.contains("I open one"), "the close names: " + several);
        String twins = AppNames.missing(apps, "banking");
        check(twins.contains("Banking (de.bank.one)") && twins.contains("Banking (de.bank.two)"), "twins show their packages: " + twins);
        String none = AppNames.missing(apps, "Telegram");
        check(none.contains("No app named \"Telegram\"") && none.contains("Wispr Flow"), "none fits: the phone's apps: " + none);
        // 27.11.2026: started, but another app stayed in front – never "opened", always what is there and the way on
        String late = AppNames.notInFront("SimplySign", "com.assecods.certum.simplysign", "com.sec.android.app.launcher", 6_000);
        check(late.contains("start SimplySign (com.assecods.certum.simplysign)") && late.contains("within 6 s – com.sec.android.app.launcher is in front")
                && late.contains("phone.key home") && !late.contains("opened"), "not in front: " + late);
        check(AppNames.notInFront(null, "de.bank.one", null, 6_000).contains("start de.bank.one, but") && AppNames.notInFront("", "x.y", "", 6_000).contains("no readable app is in front"), "without a name or a front app");
        System.out.println("AppNamesTest: " + assertions + " assertions passed");
    }
}
