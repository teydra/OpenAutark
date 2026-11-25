// B-078: the phone.* tools' one driver over both ways to a phone – ADB (USB or wireless debugging, adb.ts) and the
// Autark Android app's phone use (app-driver.ts, serial = the phone's device id). phone.devices lists both; a step with
// a serial goes to the phone that carries it; without one it goes to the app phone whenever one is attached (the
// person's own link, owner 10.11.2026: "Mach das über das Remote-System"), and to ADB only when no app phone is there.
// say follows the same rule (only the app has a bubble). Wireless pairing (pair, connect, disconnect, discover) stays ADB's.
// Which phones hang off this PC right now (PhonesHere) says so without asking a phone again: the device caps carry it to
// my other PCs (devices/tools.ts localCaps), so every PC's prompt names the PC a phone is attached to.
// Owns: that choice. Never: drives a phone itself.

import type { PhoneDriver, PhoneShot, PhoneStepOptions, PhoneTree, PhoneWireless } from './driver.ts';
import type { PhoneDevice } from './uiautomator.ts';
import type { AppPhones } from './app-driver.ts';
import type { AdbPhone } from './adb.ts';

type Adb = PhoneDriver & PhoneWireless;

/** Which phones hang off this PC right now: `app` by device id (the Autark app's socket), `adb` by serial; and whether
 *  adb is installed here (phone.* can work then, and says when no phone is on the cable). */
export interface PhonesHere { here(): { app: string[]; adb: string[] }; adbInstalled(): boolean }

export function mergedPhones(adb: Adb & Pick<AdbPhone, 'attached' | 'installed'>, app: Pick<AppPhones, keyof PhoneDriver | 'has' | 'serials'>): Adb & PhonesHere {
  /** The driver for a step: the app phone named, or any attached app phone when none is named; else ADB. */
  const pick = (serial: string | undefined): PhoneDriver => ((serial ? app.has(serial) : app.serials().length > 0) ? app : adb);
  return {
    available: async () => (await app.available()) || adb.available().catch(() => false),
    devices: async () => {
      const own = await app.devices();
      const viaAdb = (await adb.available().catch(() => false)) ? await adb.devices().catch(() => [] as PhoneDevice[]) : [];
      return [...own, ...viaAdb];
    },
    screenshot: (serial?: string, step?: PhoneStepOptions): Promise<PhoneShot> => pick(serial).screenshot(serial, step),
    uiTree: (serial?: string, step?: PhoneStepOptions): Promise<PhoneTree> => pick(serial).uiTree(serial, step),
    tap: (serial, x, y, step) => pick(serial).tap(serial, x, y, step),
    swipe: (serial, from, to, durationMs, step, via) => pick(serial).swipe(serial, from, to, durationMs, step, via),
    type: (serial, value, step) => pick(serial).type(serial, value, step),
    key: (serial, name, step) => pick(serial).key(serial, name, step),
    open: (serial, target, step) => pick(serial).open(serial, target, step),
    say: (serial, value, buttons, step) => pick(serial).say(serial, value, buttons, step),
    pair: (address, code) => adb.pair(address, code),
    connect: (address) => adb.connect(address),
    disconnect: (serial) => adb.disconnect(serial),
    discover: () => adb.discover(),
    here: () => ({ app: app.serials(), adb: adb.attached() }),
    adbInstalled: () => adb.installed(),
  };
}
