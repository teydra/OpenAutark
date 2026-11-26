// "Keep this PC awake" (0.3.20, preferences.keepPcAwake): while the app runs and the PC is on mains power it holds one
// powerSaveBlocker 'prevent-app-suspension' – no standby, so agents and schedules keep working – and never
// 'prevent-display-sleep': Windows may still turn the screen off. On battery the hold is released.
// Owns: the decision (switch × power source) and the one hold. Never: imports electron (the blocker and the power
// monitor come in). The runtime's active-turn and after-hours work leases are separate.

export interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): unknown;
}

export interface PowerSource {
  /** True when the PC runs on its battery (powerMonitor.isOnBatteryPower). */
  onBattery(): boolean;
  /** Calls `listener` whenever the PC switches between mains and battery; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

/** The hold wired to Electron's powerSaveBlocker and powerMonitor (passed in, so this file stays electron-free). */
export function pcKeepAwakeFor(electron: { powerSaveBlocker: PowerBlocker; powerMonitor: { isOnBatteryPower(): boolean; on(event: 'on-ac' | 'on-battery', l: () => void): unknown; removeListener(event: 'on-ac' | 'on-battery', l: () => void): unknown } }, switchOn: boolean, log: (line: string) => void): PcKeepAwake {
  const { powerSaveBlocker, powerMonitor } = electron;
  return new PcKeepAwake(powerSaveBlocker, {
    onBattery: () => powerMonitor.isOnBatteryPower(),
    onChange: listener => {
      powerMonitor.on('on-ac', listener); powerMonitor.on('on-battery', listener);
      return () => { powerMonitor.removeListener('on-ac', listener); powerMonitor.removeListener('on-battery', listener); };
    },
  }, switchOn, log);
}

/** The whole rule: the switch is on and the PC is not on battery. */
export const shouldKeepAwake = (switchOn: boolean, onBattery: boolean): boolean => switchOn && !onBattery;

export class PcKeepAwake {
  private id: number | null = null;
  private switchOn: boolean;
  private readonly off: () => void;
  private readonly blocker: PowerBlocker;
  private readonly power: PowerSource;
  private readonly log: (line: string) => void;

  constructor(blocker: PowerBlocker, power: PowerSource, switchOn: boolean, log: (line: string) => void = () => {}) {
    this.blocker = blocker;
    this.power = power;
    this.log = log;
    this.switchOn = switchOn;
    this.off = power.onChange(() => this.apply());
    this.apply();
  }

  /** True while the hold is on. */
  get holding(): boolean { return this.id !== null; }

  /** The setting changed. */
  setSwitch(on: boolean): void {
    if (on === this.switchOn) return;
    this.switchOn = on;
    this.apply();
  }

  /** The app quits: release the hold and stop listening. */
  dispose(): void {
    this.off();
    this.release();
  }

  private apply(): void {
    let battery = false;
    try { battery = this.power.onBattery(); } catch { /* unknown: treated as mains, the PC is likely a desktop */ }
    if (shouldKeepAwake(this.switchOn, battery)) this.hold(); else this.release();
  }

  private hold(): void {
    if (this.id !== null) return;
    try {
      this.id = this.blocker.start('prevent-app-suspension');
      this.log('keep-awake: PC held awake (mains power)');
    } catch (error) {
      this.log(`keep-awake: could not hold the PC awake: ${String(error)}`);
    }
  }

  private release(): void {
    if (this.id === null) return;
    const id = this.id;
    this.id = null;
    try { this.blocker.stop(id); } catch { /* already stopped */ }
    this.log('keep-awake: hold released');
  }
}
