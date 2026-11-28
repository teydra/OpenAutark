// The delete guard of shell.exec (task_7ja3mcr6, after 24.11. and 27.11.2026). Before a command starts, its recognizable
// recursive deletes are read as the shell would read them (shell-words.ts) – `cmd /c rd|rmdir /s`, `del|erase /s`,
// PowerShell's Remove-Item and its aliases with -Recurse (rm -rf included) or after Get-ChildItem in a pipeline,
// [IO.Directory]::Delete(…, $true), sh's rm -r/-R/--recursive and find … -delete, also inside `cmd /c`, `pwsh -Command`
// (-EncodedCommand too) and `sh -c` – each target resolved against the command's folder (cd/Set-Location/pushd with a
// literal path move it). A target that is or holds a kept folder, lies inside one, or reaches it through a link
// (delete-zones.ts refusalOf) stops the whole command with a line pointing to files.delete.
// The recognition is a layer, not a fence: a delete through a variable the command computes, a script file, another
// program (python, node, robocopy, git clean) or an alias defined on the way is not seen – the protection of the data
// itself is the path check against the kept folders, and files.delete is the way meant for deleting.
// Owns: the recognition and the refusal text. Never: runs, changes or quotes a command, throws (a reading that fails lets
// the command run as before).

import { Buffer } from 'node:buffer';
import { cmdStatements, commandName, FILTER_STAGES, powershellStatements, shStatements, type Part, type Statement, type Word } from './shell-words.ts';
import { hasWildcard, pathOf, refusalOf, stripDevicePrefix, zoneRefusal, type DeleteZones } from './delete-zones.ts';
import { cmdArgs, cmdLoop, cmdPeel, CMD_SWITCH, isLoopVariable, splitOperands, type CmdLoop } from './shell-cmd.ts';

export interface ShellDelete {
  target: string;
  /** What lies inside `target` goes (a wildcard, del /s, find -delete), not `target` itself. */ contents: boolean;
  command: string;
  /** One statement deleted several targets (an unquoted path split at its spaces). */ several: boolean;
  /** Set on a statement's first target: its operands look like one unquoted path with spaces that cmd splits (blocked whatever they reach). */ split?: string;
}
/** `exists` is for tests with foreign paths; by default the file system of this PC. */
export interface ShellScope { platform: NodeJS.Platform; cwd: string; env: NodeJS.ProcessEnv; home: string; exists?: (path: string) => boolean }

interface State { cwd: string | undefined; vars: Map<string, string>; depth: number }

/** Targets whose links are resolved (realpath) in one check; later ones are compared as written only – a command with thousands of them costs seconds otherwise. */
const MAX_RESOLVED = 64;

const REMOVE_ITEM = new Set(['remove-item', 'rm', 'ri', 'rmdir', 'rd', 'del', 'erase']);
const LIST_CHILDREN = new Set(['get-childitem', 'gci', 'ls', 'dir']);
const GET_ITEM = new Set(['get-item', 'gi']);
const SET_LOCATION = new Set(['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd']);
const POWERSHELL = new Set(['pwsh', 'powershell']);
const SH = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SH_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'sudo', 'command', 'builtin', 'exec', 'nohup', 'nice', 'doas']);
const MAX_DEPTH = 4;

const envLookup = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, name: string): string | undefined => {
  if (platform !== 'win32') return env[name];
  const hit = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return hit === undefined ? undefined : env[hit];
};

/** A word's text with its variables expanded; undefined when a part cannot be known. */
function textOf(w: Word, scope: ShellScope, state: State, shell: 'ps' | 'sh' | 'cmd'): string | undefined {
  if (w.opaque) return undefined;
  let out = '';
  for (const [index, part] of w.parts.entries()) {
    const value = expandPart(part, index, scope, state, shell);
    if (value === undefined) return undefined;
    out += value;
  }
  return out;
}

function expandPart(part: Part, index: number, scope: ShellScope, state: State, shell: 'ps' | 'sh' | 'cmd'): string | undefined {
  if (!part.expand || shell === 'cmd') return part.text;
  if (shell === 'sh' && index === 0 && part.text === '~') return scope.home;
  let unknown = false;
  const name = (raw: string): string => {
    const lower = raw.toLowerCase();
    if (shell === 'ps' && lower.startsWith('env:')) return envLookup(scope.platform, scope.env, raw.slice(4)) ?? ((unknown = true), '');
    if (shell === 'ps' ? lower === 'home' : raw === 'HOME') return shell === 'sh' ? scope.env.HOME ?? scope.home : scope.home;
    if (shell === 'ps' ? lower === 'pwd' : raw === 'PWD') return state.cwd ?? ((unknown = true), '');
    const own = state.vars.get(shell === 'ps' ? lower : raw);
    if (own !== undefined) return own;
    if (shell === 'sh' && scope.env[raw] !== undefined) return scope.env[raw]!;
    unknown = true;
    return '';
  };
  const text = part.text.replace(/\$(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?)|([0-9@*#?$!-]))/g, (_all, braced?: string, plain?: string, special?: string) => {
    if (special !== undefined) { unknown = true; return ''; }
    const raw = braced ?? plain ?? '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?$/.test(raw)) { unknown = true; return ''; }
    return name(raw);
  });
  return unknown ? undefined : text;
}

/** A path as the shell resolves it from `cwd`; undefined when it cannot be known. */
function absolute(scope: ShellScope, cwd: string | undefined, given: string): string | undefined {
  const m = pathOf(scope.platform);
  let text = stripDevicePrefix(given.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, ''), scope.platform);
  if (!text) return undefined;
  if (text === '~' || /^~[\\/]/.test(text)) text = scope.home + text.slice(1);
  if (m.isAbsolute(text)) return m.resolve(cwd ?? scope.cwd, text);
  return cwd ? m.resolve(cwd, text) : undefined;
}

/** A wildcard path: the folder before its first wildcard part, whose contents it reaches. */
function globBase(given: string, platform: NodeJS.Platform): string {
  const text = stripDevicePrefix(given, platform); // `\\?\C:\x\*`: the prefix's `?` is no wildcard part
  const parts = text.split(platform === 'win32' ? /[\\/]/ : /\//);
  const first = parts.findIndex((part) => /[*?[]/.test(part));
  const base = parts.slice(0, Math.max(first, 0)).join(platform === 'win32' ? '\\' : '/');
  return base || (text.startsWith('/') || text.startsWith('\\') ? text[0] : '.');
}

function target(scope: ShellScope, state: State, text: string, glob: boolean, contents: boolean, command: string): ShellDelete | undefined {
  const at = absolute(scope, state.cwd, glob ? globBase(text, scope.platform) : text);
  return at === undefined ? undefined : { target: at, contents: contents || glob, command, several: false };
}

/** Every recognizable recursive delete in `command`, as the shell on `scope.platform` reads it. */
export function recursiveDeletes(command: string, scope: ShellScope): ShellDelete[] {
  const state: State = { cwd: scope.cwd, vars: new Map(), depth: 0 };
  return scope.platform === 'win32' ? powershellDeletes(command, scope, state) : shDeletes(command, scope, state);
}

function powershellDeletes(src: string, scope: ShellScope, state: State): ShellDelete[] {
  const hits: ShellDelete[] = [];
  for (const match of src.matchAll(/\[(?:System\.)?IO\.Directory\]::Delete\(\s*(?:'([^']*)'|"([^"]*)")\s*,\s*\$true\s*\)/gi)) {
    const text = match[1] ?? expandPart({ text: match[2] ?? '', expand: true }, 1, scope, state, 'ps');
    const at = text === undefined ? undefined : absolute(scope, scope.cwd, text); // .NET resolves from the process's folder
    if (at) hits.push({ target: at, contents: false, command: '[IO.Directory]::Delete', several: false });
  }
  for (const statement of powershellStatements(src)) hits.push(...powershellStatement(statement, scope, state));
  return hits;
}

/** A PowerShell parameter name as written (-Recurse, -r, -LiteralPath:x): its kind and an inline value. */
function psParam(raw: string): { kind: 'recurse' | 'path' | 'literal' | 'filter' | 'value' | 'whatif' | 'switch'; inline?: string } | undefined {
  const match = /^-([A-Za-z]+)(?::(.*))?$/.exec(raw);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const inline = match[2];
  const prefix = (full: string, min = 1) => name.length >= min && full.startsWith(name);
  const kind = prefix('recurse') || name === 'rf' || name === 'fr' ? 'recurse'
    : prefix('literalpath') || name === 'lp' || prefix('pspath', 2) ? 'literal'
      : prefix('path') ? 'path'
        : prefix('filter') || prefix('include', 2) ? 'filter'
          : prefix('whatif', 2) ? 'whatif'
            : prefix('exclude', 2) || prefix('credential', 2) || prefix('stream', 2) || /^(ea|ev|wa|wv|infa|iv|ov|ob|pv|proga)$/.test(name) || prefix('erroraction', 6) || prefix('errorvariable', 6) || prefix('warningaction', 8) || prefix('warningvariable', 8) || prefix('informationaction', 12) || prefix('informationvariable', 12) || prefix('outvariable', 4) || prefix('outbuffer', 4) || prefix('pipelinevariable', 3) || prefix('progressaction', 3) ? 'value' : 'switch';
  return { kind, ...(inline !== undefined ? { inline } : {}) };
}

interface PsArgs { recurse: boolean; whatIf: boolean; filtered: boolean; paths: Array<{ text: string | undefined; glob: boolean }>; slashS: boolean }

function psArgs(words: Word[], scope: ShellScope, state: State): PsArgs {
  const out: PsArgs = { recurse: false, whatIf: false, filtered: false, paths: [], slashS: false };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    // `-Path:'x'` is one word whose first part is the bare `-Path:`: a quote inside the word does not make it a value
    const param = w.quoted && !/^-[A-Za-z]+:/.test(w.raw) ? undefined : psParam(w.raw);
    if (!param) {
      if (/^\/[sq]$/i.test(w.raw)) { out.slashS ||= /^\/s$/i.test(w.raw); continue; } // cmd habits in PowerShell's rd: /s /q
      const text = textOf(w, scope, state, 'ps');
      out.paths.push({ text, glob: hasWildcard(text ?? '') }); // -Path (and a positional path) takes wildcards, quoted or not
      continue;
    }
    if (param.kind === 'recurse') out.recurse = param.inline === undefined || !/^\$false$/i.test(param.inline);
    else if (param.kind === 'whatif') out.whatIf = param.inline === undefined || !/^\$false$/i.test(param.inline);
    else if (param.kind === 'path' || param.kind === 'literal') {
      const next = param.inline !== undefined ? undefined : words[++i];
      const inline = param.inline !== undefined ? textOf(w, scope, state, 'ps')?.replace(/^-[A-Za-z]+:/, '') : undefined; // the value with its quotes taken off
      const text = param.inline !== undefined ? inline : next ? textOf(next, scope, state, 'ps') : undefined;
      out.paths.push({ text, glob: param.kind === 'path' && hasWildcard(text ?? '') });
    } else if (param.kind === 'filter') { out.filtered = true; if (param.inline === undefined) i++; }
    else if (param.kind === 'value' && param.inline === undefined) i++;
  }
  return out;
}

function powershellStatement(statement: Statement, scope: ShellScope, state: State): ShellDelete[] {
  const words = statement.words;
  const first = words[0];
  const assigned = /^\$([A-Za-z_][A-Za-z0-9_]*)\s*=?$/.exec(first.raw);
  if (assigned && (first.raw.endsWith('=') || words[1]?.raw === '=')) {
    const valueWord = first.raw.endsWith('=') ? words[1] : words[2];
    const value = valueWord && words.length <= (first.raw.endsWith('=') ? 2 : 3) ? textOf(valueWord, scope, state, 'ps') : undefined;
    if (value === undefined) state.vars.delete(assigned[1].toLowerCase()); else state.vars.set(assigned[1].toLowerCase(), value);
    return [];
  }
  const glued = /^\$([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(first.raw);
  if (glued && words.length === 1) {
    const value = textOf(powershellStatements(glued[2])[0]?.words[0] ?? first, scope, state, 'ps');
    if (value === undefined) state.vars.delete(glued[1].toLowerCase()); else state.vars.set(glued[1].toLowerCase(), value);
    return [];
  }
  const name = commandName(textOf(first, scope, state, 'ps') ?? first.raw);
  const values = () => words.slice(1).map((w) => textOf(w, scope, state, 'ps'));
  if (SET_LOCATION.has(name)) {
    const args = psArgs(words, scope, state);
    const to = args.paths[0];
    state.cwd = to === undefined ? scope.home : to.text === undefined ? undefined : absolute(scope, state.cwd, to.text);
    return [];
  }
  if (name === 'cmd') return cmdDeletes(cmdLine(words.slice(1), scope, state), scope, state);
  if (POWERSHELL.has(name)) return nestedPowershell(values(), scope, state);
  if (REMOVE_ITEM.has(name)) {
    const args = psArgs(words, scope, state);
    const recursive = args.recurse || ((name === 'rd' || name === 'rmdir') && args.slashS);
    if (args.whatIf) return [];
    if (args.paths.length) {
      if (!recursive) return [];
      return args.paths.flatMap((one) => (one.text === undefined ? [] : [target(scope, state, one.text, one.glob, args.filtered, name)].filter((hit): hit is ShellDelete => Boolean(hit))));
    }
    let source = statement.piped;
    while (source && FILTER_STAGES.has(commandName(textOf(source.words[0], scope, state, 'ps') ?? ''))) source = source.piped; // `gci x | Where-Object {…} | Remove-Item`: the filter only selects among what gci lists
    const sourceName = source ? commandName(textOf(source.words[0], scope, state, 'ps') ?? '') : '';
    if (!source || !(LIST_CHILDREN.has(sourceName) || GET_ITEM.has(sourceName))) return [];
    const listed = psArgs(source.words, scope, state);
    if (!recursive && !(LIST_CHILDREN.has(sourceName) && listed.recurse)) return [];
    const from = listed.paths.length ? listed.paths : [{ text: '.', glob: false }];
    return from.flatMap((one) => (one.text === undefined ? [] : [target(scope, state, one.text, one.glob, LIST_CHILDREN.has(sourceName), name)].filter((hit): hit is ShellDelete => Boolean(hit))));
  }
  return [];
}

/**
 * The line cmd.exe receives after `/c` (or `/k`) from PowerShell: the arguments joined with spaces, one holding a space
 * wrapped in quotes as they are (PowerShell's legacy passing for cmd.exe); then cmd's own rule – a line starting with a
 * quote loses that first and its last quote. `cmd /c "rd /s /q C:\a b"` so becomes `rd /s /q C:\a b`: two targets.
 */
function cmdLine(args: Word[], scope: ShellScope, state: State): string | undefined {
  const at = args.findIndex((w) => /^\/[ck]$/i.test(w.raw));
  if (at < 0) return undefined;
  const parts: string[] = [];
  for (const w of args.slice(at + 1)) {
    const text = textOf(w, scope, state, 'ps');
    if (text === undefined) return undefined;
    parts.push(/\s/.test(text) ? `"${text}"` : text);
  }
  let line = parts.join(' ');
  if (line.startsWith('"')) { const last = line.lastIndexOf('"'); line = last > 0 ? `${line.slice(1, last)}${line.slice(last + 1)}` : line.slice(1); }
  return line;
}

function cmdDeletes(line: string | undefined, scope: ShellScope, state: State): ShellDelete[] {
  if (line === undefined || state.depth >= MAX_DEPTH) return [];
  const hits: ShellDelete[] = [];
  const inner: State = { ...state, depth: state.depth + 1 };
  let loop: CmdLoop | undefined;
  for (const statement of cmdStatements(line, scope.env)) {
    let args = cmdArgs(statement.words, statement.words.map((w) => textOf(w, scope, inner, 'cmd') ?? ''));
    if (loop?.collecting) { // the items of a `for … in (…)` come as statements of their own, up to `do`
      if (args[0]?.text.toLowerCase() !== 'do') { loop.items.push(...args.map((a) => a.text)); continue; }
      loop.collecting = false;
    }
    args = cmdPeel(args);
    const name = commandName(args[0]?.text ?? '');
    if (name === 'for') { loop = cmdLoop(args); continue; }
    const rest = args.slice(1);
    const switches = rest.filter((a) => CMD_SWITCH.test(a.text)).map((a) => a.text.toLowerCase());
    const operands = rest.filter((a) => !CMD_SWITCH.test(a.text));
    if (name === 'cd' || name === 'chdir' || name === 'pushd') {
      const to = operands.map((a) => a.text).join(' ');
      if (to) inner.cwd = absolute(scope, inner.cwd, to);
      continue;
    }
    if (name === 'cmd') { // cmd /c … inside cmd: the words after /c as one line
      const switchAt = rest.find((a) => /^\/[ck]$/i.test(a.text));
      if (switchAt) hits.push(...cmdDeletes(statement.words.slice(switchAt.at + 1).map((w) => w.raw).join(' '), scope, inner));
      continue;
    }
    if (POWERSHELL.has(name)) { hits.push(...nestedPowershell(rest.map((a) => a.text), scope, inner)); continue; }
    const rd = (name === 'rd' || name === 'rmdir') && switches.includes('/s');
    const del = (name === 'del' || name === 'erase') && switches.includes('/s');
    if (!rd && !del) continue;
    const several = operands.length > 1;
    const found: ShellDelete[] = [];
    const add = (text: string, glob: boolean, contents: boolean) => {
      const at = absolute(scope, inner.cwd, glob ? globBase(text, scope.platform) : text);
      if (at) found.push({ target: at, contents, command: name, several });
    };
    for (const operand of operands) {
      if (isLoopVariable(loop, operand.text)) { // the loop's items stand in for %i
        if (loop.unknown) continue;
        if (loop.mode === '/r') add(loop.dir ?? '.', false, true); // every file or folder below the start folder
        else for (const item of loop.items) { const glob = hasWildcard(item); add(item, glob, glob); }
        continue;
      }
      add(operand.text, operand.word?.glob === true || (operand.word === undefined && hasWildcard(operand.text)), del);
    }
    const split = several && !(loop && operands.some((o) => isLoopVariable(loop, o.text))) ? splitOperands(operands, scope.platform, (text) => absolute(scope, inner.cwd, text), name, scope.exists) : undefined;
    if (split && found.length) found[0] = { ...found[0], split };
    hits.push(...found);
  }
  return hits;
}

/** pwsh / powershell -Command … or -EncodedCommand …: the inner command, read the same way. */
function nestedPowershell(args: Array<string | undefined>, scope: ShellScope, state: State): ShellDelete[] {
  if (state.depth >= MAX_DEPTH) return [];
  const at = args.findIndex((text) => text !== undefined && /^-(c|co|com|comm|comma|comman|command)$/i.test(text));
  const encoded = args.findIndex((text) => text !== undefined && /^-(e|ec|en|enc|encodedcommand)$/i.test(text));
  let inner: string | undefined;
  if (at >= 0) inner = args.slice(at + 1).some((text) => text === undefined) ? undefined : args.slice(at + 1).join(' ');
  else if (encoded >= 0 && args[encoded + 1]) inner = Buffer.from(args[encoded + 1]!, 'base64').toString('utf16le');
  return inner ? powershellDeletes(inner, scope, { ...state, vars: new Map(), depth: state.depth + 1 }) : [];
}

function shDeletes(src: string, scope: ShellScope, state: State): ShellDelete[] {
  const hits: ShellDelete[] = [];
  for (const statement of shStatements(src)) {
    let words = statement.words;
    const assignment = (w: Word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw);
    if (words.every(assignment)) {
      for (const w of words) { const [name] = w.raw.split('='); const value = textOf(w, scope, state, 'sh'); if (value === undefined) state.vars.delete(name); else state.vars.set(name, value.slice(name.length + 1)); }
      continue;
    }
    for (;;) {
      const head = words[0];
      if (!head) break;
      const name = head.quoted ? '' : head.raw;
      if (SH_PREFIX.has(name) || assignment(head) || (name.startsWith('-') && words !== statement.words)) { words = words.slice(1); continue; }
      if (name === 'env') { words = words.slice(1); continue; }
      break;
    }
    if (!words.length) continue;
    const name = commandName(textOf(words[0], scope, state, 'sh') ?? '');
    const texts = words.slice(1).map((w) => textOf(w, scope, state, 'sh'));
    if (name === 'cd') { const to = texts.find((text) => text !== '--'); state.cwd = to === undefined ? scope.home : absolute(scope, state.cwd, to); continue; }
    if (SH.has(name) && state.depth < MAX_DEPTH) {
      const at = texts.indexOf('-c');
      const inner = at >= 0 ? texts[at + 1] : undefined;
      if (inner) hits.push(...shDeletes(inner, scope, { ...state, vars: new Map(), depth: state.depth + 1 }));
      continue;
    }
    if (name === 'rm') {
      let recursive = false;
      let options = true;
      const operands: Array<{ w: Word; text: string | undefined }> = [];
      words.slice(1).forEach((w, i) => {
        const text = texts[i];
        if (options && !w.quoted && text === '--') { options = false; return; }
        if (options && !w.quoted && text?.startsWith('-') && text.length > 1) { if (text === '--recursive' || (!text.startsWith('--') && /[rR]/.test(text))) recursive = true; return; }
        operands.push({ w, text });
      });
      if (recursive) for (const one of operands) { const hit = one.text === undefined ? undefined : target(scope, state, one.text, one.w.glob, false, 'rm'); if (hit) hits.push(hit); }
      continue;
    }
    if (name === 'find' && texts.some((text) => text === '-delete' || text === 'rm')) {
      const starts = texts.slice(0, Math.max(texts.findIndex((text) => text === undefined || /^[-(!]/.test(text)), 0) || texts.length);
      for (const start of starts.length ? starts : ['.']) { const hit = start === undefined ? undefined : target(scope, state, start, false, true, 'find'); if (hit) hits.push(hit); }
    }
  }
  return hits;
}

/** The first recursive delete in `command` that reaches a kept folder, as my refusal; undefined when none does. */
export function shellDeleteRefusal(command: string, scope: ShellScope, zones: DeleteZones): string | undefined {
  let hits: ShellDelete[];
  try { hits = recursiveDeletes(command, scope); } catch { return undefined; }
  // Only the first MAX_RESOLVED targets are followed through links (realpath per target: a command with ~3800 of them took
  // 1.7 s); the rest are compared as written – a link above one of them goes unseen, which is the fail-open of this layer.
  const reason = (hit: ShellDelete, index: number) => (index < MAX_RESOLVED ? refusalOf : zoneRefusal)(hit.target, zones, hit.contents);
  for (const [index, hit] of hits.entries()) {
    const why = reason(hit, index);
    if (!why) continue;
    const split = hit.several ? ` One of several targets of \`${hit.command}\`: an unquoted path splits at its spaces, so \`rd /s /q C:\\a b\` deletes C:\\a and b.` : '';
    return `BLOCKED – not executed. This command deletes recursively (\`${hit.command}\`), and as the shell reads it, it reaches ${hit.target}${hit.contents ? ' (what lies inside)' : ''}: ${why}.${split} Nothing ran. To delete a file or folder I use files.delete with its exact path – dryRun shows first what would go; it keeps company data, browser profiles and the app safe and removes links without entering them.`;
  }
  // an unquoted path with spaces: cmd deletes the wrong things whatever they are (a folder of the same name, a sibling)
  const unquoted = hits.find((hit) => hit.split);
  if (unquoted) return `BLOCKED – not executed. ${unquoted.split}. Nothing ran. To delete a folder I can also use files.delete with its exact path – dryRun shows first what would go.`;
  return undefined;
}
