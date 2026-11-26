// Workspace file and shell tools. files.write and shell.exec are direct for engines that bring no tools of their own
// (HTTP APIs, local models – tools/core-sets.ts) and reachable for every engine through tools.call – a CLI engine uses
// shell.exec for a linked PC's terminal or a command with a stored secret, and files.write for bytes or a large text from
// its script; files.write runs on this PC. A path is relative to the workspace or absolute anywhere on the PC – the data
// folder included. files.read, files.list and shell.exec are remote tools: with `device` (or an agent homed on another
// PC) that PC runs them (registry.ts, devices/tools.ts runRemoteTool), by the same path rule as this PC's own agents
// (readPath). shell.exec is offered in every mode (registry.ts: every tool in every mode; core-sets.ts BASE_CORE) and takes `env`, whose values may hold
// secret://<id> handles resolved at spawn (command.ts, secrets/handles.ts). A command without cwd runs in a split part's
// folder (ToolContext.split.cwd), else in the workspace (commandCwd). On Windows it runs in PowerShell itself
// (defaultShell: the engines' PowerShell 7 where found, else Windows PowerShell 5.1; the command as one -Command
// argument, UTF-8 out of and into programs, no progress records); macOS and Linux keep sh. A miss of files.read /
// files.list shows what is there (file-miss.ts missText); files.list counts the entries past its first 500.
// Owns: files.read, files.write, files.list, shell.exec, the path rule (resolvePath) and the resource of a workspace
// path (workspaceResource: one spelling per file); isInside / realInside for the worktrees (git/).
// Never: lets a command run unbounded (timeout + output cap; killed on run abort).

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ActionDescription, ToolContext, ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { clip, defineTool } from './util.ts';
import { commandAction, ENV_SCHEMA, runCommand } from './command.ts';
import { searchTool } from './files-search.ts';
import { missText } from './file-miss.ts'; // B-080: a miss shows what is there
import { LINE_READ_BYTES, lineWindow } from './file-window.ts';
import { shellJobArgs, shellJobBroker } from '../../system/shell-job.ts';
import { pwshDir } from '../../engines/wf-shim.ts'; // B-080 wave 3: the engines' PowerShell 7

const MAX_READ = 256 * 1024;
const PATH = { type: 'string', minLength: 1, maxLength: 1024 };
/** Entries one files.list answer shows; the rest is counted in its last line. */
export const LIST_ENTRIES = 500;
const outside = () => new WorkforceError('forbidden', 'Path is outside the folder.');

/** A path as given: relative to the workspace, or absolute anywhere on this PC. */
export function resolvePath(ctx: Pick<ToolContext, 'services'>, given: string | undefined): string {
  return path.resolve(ctx.services.paths.workspace, given ?? '.');
}


/** Where a command runs: `cwd` as given (resolvePath); without one, a split part's own folder (its worktree), else the workspace. */
export function commandCwd(ctx: Pick<ToolContext, 'services' | 'split'>, given: string | undefined): string {
  const asked = given?.trim();
  return asked ? resolvePath(ctx, asked) : ctx.split?.cwd ?? resolvePath(ctx, undefined);
}

/** True when `target` is `root` or below it (path.relative folds case on Windows). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The real path of `target`: of its deepest existing ancestor, plus the parts that do not exist yet. */
async function realExisting(target: string): Promise<string> {
  const rest: string[] = [];
  let probe = target;
  for (;;) {
    try { return path.join(await realpath(probe), ...rest); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new WorkforceError('forbidden', 'This path cannot be checked (no access or a broken link).');
      const parent = path.dirname(probe);
      if (parent === probe) throw outside();
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolves `relative` inside `root` with symlinks and junctions followed: a link inside the
 * workspace that points elsewhere counts as outside. Returns the real path; throws 'forbidden'.
 */
export async function realInside(root: string, relative: string | undefined): Promise<string> {
  const base = path.resolve(root);
  const target = path.resolve(base, relative ?? '.');
  if (!isInside(base, target)) throw outside();
  const realBase = await realpath(base).catch(() => base);
  const real = await realExisting(target);
  if (!isInside(realBase, real)) throw outside();
  return real;
}

/** The real path of a read (resolvePath, links followed) – one rule for this PC's agents and a linked PC's calls (B-080). */
export async function readPath(ctx: ToolContext, given: string | undefined): Promise<string> {
  const target = resolvePath(ctx, given);
  return realpath(target).catch(() => target);
}

/** realExisting for describe() (sync): the same walk with the same native realpath. */
function realExistingSync(target: string): string {
  const rest: string[] = [];
  let probe = target;
  for (;;) {
    try { return path.join(realpathSync.native(probe), ...rest); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(probe);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === probe) throw error;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * The resource of a workspace path: its real path relative to the real workspace root,
 * '/'-separated ('.' = the root). './a', 'b/../a', an absolute path into the workspace and a link
 * to the file all give one spelling, so the journal names one file one way. A path outside the
 * workspace, or one that cannot be checked, keeps its spelling.
 */
export function workspaceResource(root: string, relative: string | undefined): string {
  const given = relative ?? '.';
  try {
    const base = path.resolve(root);
    let realBase = base;
    try { realBase = realpathSync.native(base); } catch { /* not created yet: as written */ }
    const real = realExistingSync(path.resolve(base, given));
    if (!isInside(realBase, real)) return given;
    return path.relative(realBase, real).split(path.sep).join('/') || '.';
  } catch {
    return given;
  }
}

/** What a read asks for: its summary and the workspace resource of the path (on another PC the registry adds its name). */
function readAction(ctx: ToolContext, summary: string, given: string | undefined): ActionDescription {
  return { summary, resource: workspaceResource(ctx.services.paths.workspace, given), reversible: true, external: false };
}

export type ShellSpawn = (command: string, options: { cwd: string; signal: AbortSignal; env?: NodeJS.ProcessEnv }) => {
  stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): boolean;
};

/** B-080: what every Windows command starts with – no progress records, UTF-8 out of and into native programs. */
export const WINDOWS_PREAMBLE = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding";

/**
 * B-080 wave 3 (live 09.11.2026: a command that did not parse stopped the preamble too, and its ParserError came back in
 * the OEM code page – "nicht zul�ssig"): the command as it runs after the preamble – its text travels as UTF-16 base64
 * (no quoting on the way), is parsed by [ScriptBlock]::Create once the preamble ran (a parse error comes back UTF-8 and
 * the call exits 1) and runs dot-sourced in the script's own scope. The line after it keeps -Command's exit rule: a last
 * statement that failed (a native program's non-zero exit, Write-Error) exits 1; `exit N` exits N.
 */
export function windowsScript(command: string): string {
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return `. ([ScriptBlock]::Create([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))).ToString() + "\`n\`nif (-not \`$?) { exit 1 }"))`;
}

/**
 * B-080: how Windows runs a command – PowerShell itself, the command as one -Command argument (no cmd.exe in between, no
 * -EncodedCommand: its errors would come back as CLIXML), UTF-8 output and no progress records first; and
 * $OutputEncoding UTF-8 too, so text piped into a program ('Grüße' | python -, '<json>' | wf call … -) keeps its
 * letters (5.1's default there is ASCII: "Gr??e"). B-080 wave 3: PowerShell 7 (pwsh.exe, engines/wf-shim.ts pwshDir of
 * `env`) where it is found, the same shell as the engines'; Windows PowerShell 5.1 otherwise; the command as windowsScript.
 */
export function windowsShell(command: string, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  const pwsh = pwshDir(env);
  return {
    file: pwsh ? path.win32.join(pwsh, 'pwsh.exe') : path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${WINDOWS_PREAMBLE}\n${windowsScript(command)}`],
  };
}

export const defaultShell = (command: string, options: Parameters<ShellSpawn>[1]) => {
  const win = process.platform === 'win32';
  const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] };
  const powershell = win ? windowsShell(command, options.env) : undefined;
  const broker = powershell ? shellJobBroker() : undefined;
  const child = powershell
    ? broker ? nodeSpawn(broker, shellJobArgs(powershell.file, powershell.args), { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] })
      : nodeSpawn(powershell.file, powershell.args, spawnOptions)
    : nodeSpawn(command, { ...spawnOptions, shell: true });
  const kill = () => {
    if (broker) {
      // Kill only the handle-owning process. The kernel kills the whole Job, even if the root already exited.
      child.kill();
    } else if (win && child.pid) {
      // Compatibility for source runs and old/missing broker resources: don't target a PID after its exit.
      if (child.exitCode !== null || child.signalCode !== null) return;
      nodeSpawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { child.kill(); });
    } else {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  };
  options.signal.addEventListener('abort', kill, { once: true });
  child.once('close', () => options.signal.removeEventListener('abort', kill));
  child.once('error', () => options.signal.removeEventListener('abort', kill));
  if (options.signal.aborted) kill();
  return child;
};

/** The resource of a shell command: its text (whitespace folded, clipped) and the working folder. */
export function shellResource(command: string, cwd: string | undefined): string {
  return `${clip(command.trim().replace(/\s+/g, ' '), 300)}@${cwd?.trim() || '.'}`;
}

export function fileTools(deps: { shell?: ShellSpawn } = {}): ToolDef[] {
  const shell = deps.shell ?? defaultShell;

  const readFileTool = defineTool<{ path: string; maxBytes?: number; fromLine?: number; lines?: number }>({
    name: 'files.read',
    description: 'Reads a text file anywhere on the PC in windows of whole lines. The last line says which lines came and where I go on.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ, description: 'Default 256 KB.' }, fromLine: { type: 'integer', minimum: 1 }, lines: { type: 'integer', minimum: 1 } },
      required: ['path'], additionalProperties: false,
    },
    category: 'read', remote: true,
    describe: (args, ctx) => readAction(ctx, `Read ${args.path}`, args.path),
    async run(args, ctx) {
      const file = await readPath(ctx, args.path);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return failure(await missText(ctx, args.path, file)); // B-080: what is there (a folder: its listing)
      // Only the bytes needed are read: the start (maxBytes, default MAX_READ), or up to LINE_READ_BYTES for lines
      // further down – a big file (or one a linked PC asks for) never fills memory. B-048: lines in windows (file-window.ts).
      const limit = args.fromLine !== undefined && args.fromLine > 1 ? LINE_READ_BYTES : (args.maxBytes ?? MAX_READ);
      const handle = await open(file, 'r');
      let body: string;
      try {
        const buffer = Buffer.alloc(Math.min(limit, info.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        body = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      return text(lineWindow(body, args, { size: info.size, readBytes: Math.min(limit, info.size) }));
    },
  });
  // A command line ends at 32,767 characters (os error 206), so files.write takes bytes too – base64 or a whole data: URL.
  const writeFileTool = defineTool<{ path: string; content: string; append?: boolean; base64?: boolean }>({
    name: 'files.write',
    description: 'Creates, overwrites or appends to a file anywhere on this PC, as text or bytes. Folders are created, and no command-line limit applies.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string', maxLength: 20_000_000, description: 'With base64: base64 or a whole data: URL.' }, append: { type: 'boolean' }, base64: { type: 'boolean' } },
      required: ['path', 'content'], additionalProperties: false,
    },
    category: 'write_local',
    describe: (args) => ({ summary: `Write ${args.path}`, external: false }),
    async run(args, ctx) {
      const file = resolvePath(ctx, args.path);
      await mkdir(path.dirname(file), { recursive: true });
      const data = args.base64 ? Buffer.from(args.content.replace(/^data:[^,]*,/, ''), 'base64') : args.content;
      await writeFile(file, data, { ...(args.base64 ? {} : { encoding: 'utf8' as const }), flag: args.append ? 'a' : 'w' });
      return json({ ok: true, path: file, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length });
    },
  });

  const listDir = defineTool<{ path?: string }>({
    name: 'files.list',
    description: 'Lists a folder anywhere on the PC; past 500 entries the rest is counted.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1024, description: 'Default the workspace.' } }, additionalProperties: false },
    category: 'read', remote: true,
    describe: (args, ctx) => readAction(ctx, `List ${args.path ?? '.'}`, args.path),
    async run(args, ctx) {
      const dir = await readPath(ctx, args.path);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
      if (!entries) return failure(await missText(ctx, args.path ?? '.', dir, 'folder')); // B-080: the nearest folder's listing
      const lines = entries.slice(0, LIST_ENTRIES).map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
      const rest = entries.length - lines.length; // B-089: what is not shown is said, with the call that finds it
      if (rest > 0) lines.push(`[${LIST_ENTRIES} of ${entries.length} entries shown; ${rest} more are in this folder – files.search with a part of a name and this path finds them.]`);
      return text(lines.length ? lines.join('\n') : '(empty)');
    },
  });

  const shellExec = defineTool<{ command: string; cwd?: string; timeoutSeconds?: number; env?: Record<string, string> }>({
    name: 'shell.exec',
    description: 'Runs a shell command on this PC or a linked PC, with stored secrets in its env if needed. With a shell of my own I use it for a linked PC or a stored secret. On Windows it runs in PowerShell (7 where installed, else 5.1): I chain with ";" and write cmd syntax as cmd /c "…"; output is capped.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 8000 }, cwd: { type: 'string', description: 'Default the workspace; a split part: its own folder.' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Until the first timeout review, which extends or ends it; default estimated.' }, env: { ...ENV_SCHEMA },
      },
      required: ['command'], additionalProperties: false,
    },
    category: 'write_system', remote: true,
    describe: (args, ctx) => commandAction(ctx, { summary: `Run: ${clip(args.command, 200)}`, resource: shellResource(args.command, args.cwd), reversible: false, external: false }, args.env),
    async run(args, ctx) {
      const cwd = commandCwd(ctx, args.cwd);
      return runCommand(shell, ctx, { command: args.command, cwd, timeoutSeconds: args.timeoutSeconds, env: args.env });
    },
  });

  return [readFileTool, writeFileTool, listDir, shellExec, searchTool({ resolve: readPath })];
}

