// How cmd.exe reads the words of a statement (task_7ja3mcr6, PR #49 review), for the cmd part of the delete guard
// (shell-deletes.ts cmdDeletes): `rd/s/q X` and `/s/q` are glued switches, `if exist X rd …`, `else`, `do` and `call` lead a
// command without being it, `for %i in (…) do rd /s /q %i` lets the loop variable stand for its items, and operands that
// are one unquoted path with spaces are recognized (cmd cuts such a path into several targets).
// Owns: these readings of already split words. Never: runs anything, touches the file system except `exists`, decides about a delete.

import { lstatSync } from 'node:fs';
import { pathOf } from './delete-zones.ts';
import { commandName, type Word } from './shell-words.ts';

export const CMD_SWITCH = /^\/[a-z](?::.*)?$/i;
/** `/s/q`: cmd takes switches glued together. */
const CMD_SWITCHES = /^(?:\/[a-z]){2,}$/i;
/** Commands whose name cmd ends at a slash (`rd/s/q X`, `cmd/c …`). */
const CMD_SLASH_NAMES = new Set(['rd', 'rmdir', 'del', 'erase', 'cmd', 'cd', 'chdir', 'pushd', 'pwsh', 'powershell', 'if', 'for']);

/** A word of a cmd statement as cmd reads it: `at` is the index of the word it comes from, `word` is missing for a switch cut out of a glued one. */
export interface CmdArg { text: string; word: Word | undefined; at: number }

/** The statement's words (`texts`: each with its variables expanded) as cmd reads them: `rd/s/q` is `rd /s /q`. */
export function cmdArgs(words: Word[], texts: string[]): CmdArg[] {
  const out: CmdArg[] = [];
  const push = (text: string, word: Word | undefined, at: number) => {
    if (CMD_SWITCHES.test(text)) for (const one of text.match(/\/[a-z]/gi) ?? []) out.push({ text: one, word: undefined, at });
    else out.push({ text, word, at });
  };
  words.forEach((w, at) => {
    const text = texts[at] ?? '';
    const slash = at === 0 ? text.indexOf('/') : -1;
    if (slash > 0 && CMD_SLASH_NAMES.has(commandName(text.slice(0, slash)))) { out.push({ text: text.slice(0, slash), word: w, at }); push(text.slice(slash), undefined, at); } // rd/s/q
    else push(text, w, at);
  });
  return out;
}

/** What leads a command in cmd without being it: `if [/i] [not] exist|defined|errorlevel X`, `if a==b`, `else`, `do`, `call`. */
export function cmdPeel(args: CmdArg[]): CmdArg[] {
  for (;;) {
    const head = args[0]?.text.replace(/^@/, '').toLowerCase();
    if (head === 'do' || head === 'else' || head === 'call') { args = args.slice(1); continue; }
    if (head !== 'if') return args;
    let n = 1;
    if (args[n]?.text.toLowerCase() === '/i') n++;
    if (args[n]?.text.toLowerCase() === 'not') n++;
    const kind = args[n]?.text.toLowerCase();
    if (kind === 'exist' || kind === 'defined' || kind === 'errorlevel' || kind === 'cmdextversion') n += 2;
    else n += /^(?:equ|neq|lss|leq|gtr|geq)$/i.test(args[n + 1]?.text ?? '') ? 3 : 2; // `a==b`: cmdStatements reads `=` as a space, so two words
    args = args.slice(n);
  }
}

/** `for [/d | /r [dir] | /l | /f …] %v in (items) do …`: what the loop variable stands for in the `do` part. */
export interface CmdLoop { variable: string; mode: string | undefined; dir: string | undefined; items: string[]; collecting: boolean; /** The items cannot be known (/f, /l). */ unknown: boolean }

export function cmdLoop(args: CmdArg[]): CmdLoop {
  const modeAt = args.findIndex((a, i) => i > 0 && /^\/[drlf]$/i.test(a.text));
  const varAt = args.findIndex((a, i) => i > 0 && a.text.startsWith('%'));
  const mode = modeAt > 0 ? args[modeAt].text.toLowerCase() : undefined;
  const dir = mode === '/r' && varAt > modeAt + 1 ? args[modeAt + 1].text : undefined;
  return { variable: varAt > 0 ? args[varAt].text.slice(-1) : '', mode, dir, items: [], collecting: true, unknown: varAt < 0 || mode === '/f' || mode === '/l' };
}

export const isLoopVariable = (loop: CmdLoop | undefined, text: string): loop is CmdLoop =>
  loop !== undefined && !loop.collecting && loop.variable !== '' && new RegExp(`^%%?(?:~[a-z]*)?${loop.variable.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`).test(text);

/**
 * Operands that cmd got from one unquoted path with spaces: `rd /s /q C:\a b\c` deletes C:\a, b and c. Suspect when the
 * words joined with spaces name an existing path (or its folder exists), or an absolute operand is followed by a relative
 * one. Quoted operands are one path each. `resolve` makes a path absolute from the command's folder. Returns the line for
 * the refusal; undefined when the operands look separate.
 */
export function splitOperands(operands: CmdArg[], platform: NodeJS.Platform, resolve: (text: string) => string | undefined, name: string, exists?: (path: string) => boolean): string | undefined {
  const m = pathOf(platform);
  const there = exists ?? ((path: string) => { try { lstatSync(path); return true; } catch { return false; } });
  const plain = (a: CmdArg) => a.word !== undefined && !a.word.quoted;
  for (let from = 0; from < operands.length - 1; from++) {
    if (!plain(operands[from])) continue;
    let end = from;
    while (end + 1 < operands.length && plain(operands[end + 1])) end++;
    for (let to = end; to > from; to--) { // the longest run first: it is the whole path
      const run = operands.slice(from, to + 1).map((a) => a.text);
      const joined = run.join(' ');
      const full = resolve(joined);
      const parent = joined.includes('\\') || joined.includes('/') ? resolve(m.dirname(joined)) : undefined;
      const relativeLast = !m.isAbsolute(run[run.length - 1]);
      const why = full && there(full) ? `\`${joined}\` exists as one path`
        : parent && m.dirname(joined) !== '.' && relativeLast && there(parent) ? `the folder \`${m.dirname(joined)}\` exists`
          : m.isAbsolute(run[0]) && relativeLast ? 'a relative word follows an absolute path' : undefined;
      if (why) return `cmd reads \`${name} /s … ${joined}\` as ${run.length} targets (${run.join(' | ')}): ${why}, so it is one path with spaces that was not put in quotes. Write the path in quotes: ${name} /s /q "${joined}"`;
    }
  }
  return undefined;
}
