// Owns: the two wake locks of phone use (25.11.2026, owner: the AI should reach and wake the phone while it is closed).
// `reach` keeps the processor awake after the screen went off (AwakeRule), so the connection to the PC answers – without
// it the S918B dropped out of phone.devices right after the screen went off. `lit` keeps a screen the AI woke (phone.key
// wakeup, WakeActivity) on between its steps. Both end by themselves; UseService starts and stops this with the service.
// Never: turns the screen on by itself, or holds anything while phone use is not agreed.
package com.teydralab.autark.android.phoneuse;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.PowerManager;

final class Awake {
    private final Context context;
    private final PowerManager power;
    private final PowerManager.WakeLock reach;
    private final PowerManager.WakeLock lit;
    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent intent) {
            String action = intent.getAction();
            if (Intent.ACTION_SCREEN_ON.equals(action)) release(reach); // the screen keeps the processor awake itself
            else if (Intent.ACTION_SCREEN_OFF.equals(action)) { release(lit); hold(); }
            else if (!power.isInteractive()) hold(); // the cable came or went with the screen off
        }
    };

    @SuppressWarnings("deprecation") // SCREEN_DIM_WAKE_LOCK: the one way a service keeps a lit screen on
    Awake(Context context) {
        this.context = context;
        power = context.getSystemService(PowerManager.class);
        reach = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autark:phone-use");
        reach.setReferenceCounted(false);
        lit = power.newWakeLock(PowerManager.SCREEN_DIM_WAKE_LOCK, "autark:phone-use-screen");
        lit.setReferenceCounted(false);
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        context.registerReceiver(screen, filter); // system broadcasts only: no export flag needed
        if (!power.isInteractive()) hold();
    }

    /** A step of the AI: reachable for the next one, and a screen it woke stays on. */
    void step() {
        if (!power.isInteractive()) hold();
        if (lit.isHeld()) lit.acquire(AwakeRule.LIT_MS);
    }

    /** The AI just woke the screen: it stays on until the run is done or AwakeRule.LIT_MS pass without a step. */
    void keepLit() { lit.acquire(AwakeRule.LIT_MS); }

    /** The AI's run is over: the screen follows the phone's own timeout again. */
    void done() { release(lit); }

    void close() {
        try { context.unregisterReceiver(screen); } catch (IllegalArgumentException gone) { /* never registered */ }
        release(lit);
        release(reach);
    }

    private void hold() {
        if (!UseConsent.agreed(context)) return;
        BatteryManager battery = context.getSystemService(BatteryManager.class);
        reach.acquire(AwakeRule.reach(battery != null && battery.isCharging()));
    }

    private static void release(PowerManager.WakeLock lock) { if (lock.isHeld()) lock.release(); }
}
