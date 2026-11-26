// Windows shell ownership via the app's signed desktop broker, launched directly (never through its service).
// The broker's stdin is a lifetime pipe: the OS closes it if this runtime dies. The shell itself gets NUL.
// Owns: discovering the wrapper, negotiating its version and bounding pipe drain. Never: touches the installed broker service.
import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLE = 'shell-job-v1';
const CAPABILITY = 'autark-shell-job-v1';
const BROKER = path.join('resources', 'broker', 'AutarkDesktopBroker.exe');

let packagedBroker: string | undefined;
const supported = new Map<string, boolean>();

export function shellJobArgs(file: string, args: string[]): string[] {
  return [ROLE, file, ...args];
}

/** Packaged runtime modules are in app.asar/app. Windows source builds opt in for tests. */
export function shellJobBroker(): string | undefined {
  packagedBroker ??= brokerPath(fileURLToPath(import.meta.url), process.env.AUTARK_SHELL_JOB_TEST === '1');
  return packagedBroker && hasShellJobRole(packagedBroker) ? packagedBroker : undefined;
}

export function brokerPath(moduleFile: string, testBuild: boolean): string {
  const asar = /^(.*?[\\/])app\.asar[\\/]/i.exec(moduleFile);
  if (asar) return path.join(asar[1]!, 'app.asar.unpacked', BROKER);
  return testBuild ? path.resolve(import.meta.dirname, '../../../', BROKER) : '';
}

/** Missing/older resource: leave shell.exec available, but don't retry a command once it may have started. */
function hasShellJobRole(file: string): boolean {
  if (!existsSync(file)) return false;
  if (!supported.has(file)) {
    const probe = spawnSync(file, [ROLE, '--capability'], {
      cwd: path.dirname(file), windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    supported.set(file, probe.status === 0 && probe.stdout?.trim() === CAPABILITY);
  }
  return supported.get(file) === true;
}

/**
 * Even a redirected Start-Process can inherit copies of the shell's pipes. Once the owning wrapper
 * exits, give the streams 1.5 s to deliver buffered output; then close our readers so Node emits
 * 'close' with the wrapper's exit code. Later output from deliberately detached work is not collected.
 */
export function drainJobOutput(child: ChildProcess): void {
  child.once('exit', () => {
    const drain = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, 1500);
    drain.unref?.();
    child.once('close', () => clearTimeout(drain));
  });
}
