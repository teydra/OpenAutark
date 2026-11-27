// The words of a command line as a shell splits them (task_7ja3mcr6), for the delete guard of shell.exec
// (shell-deletes.ts): PowerShell (shell.exec's shell on Windows), cmd.exe (a `cmd /c` inside it) and sh (macOS, Linux).
// Each splits into statements (`;`, newlines, `&&`, `||`, `&`, parentheses and braces; `|` keeps the pipeline) and words;
// quotes are taken off as the shell does – cmd and sh split an unquoted path at its spaces, which is how
// `cmd /c "rd /s /q C:\…\Autark Companies\x"` reached "…\Autark". Variables are kept as parts and expanded when the
// statement is read (shell-deletes.ts), so an assignment earlier in the same command counts.
// This is a reading for a guard, not a shell: a construct it does not know becomes an unknown part, never an error.
// Owns: the three splitters. Never: runs anything or decides about a delete.

/** One part of a word: literal text, or text whose `$…` expands (PowerShell double quotes and bare words; sh likewise). */
export interface Part { text: string; expand: boolean }
export interface Word { parts: Part[]; /** Something the reader cannot know ($(…), backticks in sh). */ opaque: boolean; /** A wildcard outside quotes. */ glob: boolean; quoted: boolean; raw: string }
export interface Statement { words: Word[]; /** The statement before it in the same pipeline (`a | b`). */ piped?: Statement }

const word = (start: number): Word & { start: number } => ({ parts: [], opaque: false, glob: false, quoted: false, raw: '', start });

/** Skips a `$( … )` (or `( … )`) from its open parenthesis; returns the index after its close. */
function skipParens(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Statements from a list of words and operators. */
function statements(items: Array<Word | ';' | '|'>): Statement[] {
  const out: Statement[] = [];
  let words: Word[] = [];
  let piped: Statement | undefined;
  const end = (op: ';' | '|') => {
    if (words.length) { const statement: Statement = { words, ...(piped ? { piped } : {}) }; out.push(statement); piped = op === '|' ? statement : undefined; }
    else if (op === ';') piped = undefined;
    words = [];
  };
  for (const item of items) { if (item === ';' || item === '|') end(item); else words.push(item); }
  end(';');
  return out;
}

/** PowerShell: '…' literal ('' a quote), "…" expanding (` escapes, "" a quote), bare words expanding, ` escapes, # comments. */
export function powershellStatements(src: string): Statement[] {
  const items: Array<Word | ';' | '|'> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === ',') { i++; continue; }
    if (c === '`' && (src[i + 1] === '\n' || src[i + 1] === '\r')) { i += 2; continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '{' || c === '}') { items.push(';'); i++; continue; }
    if (c === '<' && src[i + 1] === '#') { const close = src.indexOf('#>', i + 2); i = close < 0 ? src.length : close + 2; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '|') { items.push(src[i + 1] === '|' ? ';' : '|'); i += src[i + 1] === '|' ? 2 : 1; continue; }
    if (c === '&') { items.push(';'); i += src[i + 1] === '&' ? 2 : 1; continue; }
    const w = word(i);
    while (i < src.length && !' \t\r\n;|&(){},'.includes(src[i])) {
      const d = src[i];
      if (d === '`') { w.parts.push({ text: src[i + 1] ?? '', expand: false }); i += 2; continue; }
      if (d === '$' && src[i + 1] === '(') { w.opaque = true; i = skipParens(src, i + 1); continue; }
      if (d === "'") {
        w.quoted = true;
        let text = '';
        for (i++; i < src.length; i++) {
          if (src[i] === "'") { if (src[i + 1] === "'") { text += "'"; i++; continue; } i++; break; }
          text += src[i];
        }
        w.parts.push({ text, expand: false });
        continue;
      }
      if (d === '"') {
        w.quoted = true;
        let text = '';
        for (i++; i < src.length;) {
          const e = src[i];
          if (e === '`') { if (text) w.parts.push({ text, expand: true }); text = ''; w.parts.push({ text: src[i + 1] ?? '', expand: false }); i += 2; continue; }
          if (e === '"') { if (src[i + 1] === '"') { text += '"'; i += 2; continue; } i++; break; }
          if (e === '$' && src[i + 1] === '(') { w.opaque = true; i = skipParens(src, i + 1); continue; }
          text += e; i++;
        }
        if (text) w.parts.push({ text, expand: true });
        continue;
      }
      let bare = '';
      while (i < src.length && !' \t\r\n;|&(){},`\'"'.includes(src[i]) && !(src[i] === '$' && src[i + 1] === '(')) bare += src[i++];
      if (/[*?[]/.test(bare)) w.glob = true;
      w.parts.push({ text: bare, expand: true });
    }
    w.raw = src.slice(w.start, i);
    items.push(w);
  }
  return statements(items);
}

/** cmd.exe after `/c`: %VAR% expanded from `env`, "…" quoting, ^ escapes, & && || | ( ) between statements, and space, tab, comma, semicolon and = between words. */
export function cmdStatements(line: string, env: NodeJS.ProcessEnv): Statement[] {
  const lookup = new Map(Object.entries(env).map(([name, value]) => [name.toLowerCase(), value]));
  const src = line.replace(/%([^%\s]+)%/g, (all, name: string) => lookup.get(name.toLowerCase()) ?? all);
  const items: Array<Word | ';' | '|'> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (' \t\r,;='.includes(c)) { i++; continue; }
    if (c === '\n' || c === '(' || c === ')') { items.push(';'); i++; continue; }
    if (c === '&') { items.push(';'); i += src[i + 1] === '&' ? 2 : 1; continue; }
    if (c === '|') { items.push(src[i + 1] === '|' ? ';' : '|'); i += src[i + 1] === '|' ? 2 : 1; continue; }
    const w = word(i);
    let text = '';
    let quoted = false;
    while (i < src.length) {
      const d = src[i];
      if (!quoted && (' \t\r\n,;=&|()'.includes(d))) break;
      if (d === '"') { quoted = !quoted; w.quoted = true; i++; continue; }
      if (d === '^' && !quoted) { text += src[i + 1] ?? ''; i += 2; continue; }
      if (!quoted && (d === '*' || d === '?')) w.glob = true;
      text += d; i++;
    }
    w.parts.push({ text, expand: false });
    w.raw = src.slice(w.start, i);
    items.push(w);
  }
  return statements(items);
}

/** sh: '…' literal, "…" expanding with \ escapes, bare words expanding with \ escapes and ~ at their start, # comments; $(…) and `…` unknown. */
export function shStatements(src: string): Statement[] {
  const items: Array<Word | ';' | '|'> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')') { items.push(';'); i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '|') { items.push(src[i + 1] === '|' ? ';' : '|'); i += src[i + 1] === '|' ? 2 : 1; continue; }
    if (c === '&') { items.push(';'); i += src[i + 1] === '&' ? 2 : 1; continue; }
    const w = word(i);
    if (c === '~' && (src[i + 1] === undefined || ' \t\n;/|&'.includes(src[i + 1]))) { w.parts.push({ text: '~', expand: true }); i++; }
    while (i < src.length && !' \t\r\n;|&()'.includes(src[i])) {
      const d = src[i];
      if (d === '\\') { w.parts.push({ text: src[i + 1] ?? '', expand: false }); i += 2; continue; }
      if (d === '`') { w.opaque = true; const close = src.indexOf('`', i + 1); i = close < 0 ? src.length : close + 1; continue; }
      if (d === '$' && src[i + 1] === '(') { w.opaque = true; i = skipParens(src, i + 1); continue; }
      if (d === "'") { w.quoted = true; const close = src.indexOf("'", i + 1); w.parts.push({ text: src.slice(i + 1, close < 0 ? src.length : close), expand: false }); i = close < 0 ? src.length : close + 1; continue; }
      if (d === '"') {
        w.quoted = true;
        let text = '';
        for (i++; i < src.length;) {
          const e = src[i];
          if (e === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) { if (text) w.parts.push({ text, expand: true }); text = ''; w.parts.push({ text: src[i + 1], expand: false }); i += 2; continue; }
          if (e === '"') { i++; break; }
          if (e === '`' || (e === '$' && src[i + 1] === '(')) { w.opaque = true; i = e === '`' ? (src.indexOf('`', i + 1) + 1 || src.length) : skipParens(src, i + 1); continue; }
          text += e; i++;
        }
        if (text) w.parts.push({ text, expand: true });
        continue;
      }
      let bare = '';
      while (i < src.length && !' \t\r\n;|&()\\`\'"'.includes(src[i]) && !(src[i] === '$' && src[i + 1] === '(')) bare += src[i++];
      if (/[*?[]/.test(bare)) w.glob = true;
      w.parts.push({ text: bare, expand: true });
    }
    w.raw = src.slice(w.start, i);
    if (w.parts.length || w.opaque) items.push(w);
  }
  return statements(items);
}
