// Settings files are JSON with comments and trailing commas; both startup and the runtime read them.
// Owns: removal of JSONC syntax. Never: reads files or validates settings.

/** The text without comments (// and /* *\/) and trailing commas – plain JSON (strings are never touched). */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  let last = -1; // index in `out` of the last piece that is not white space
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      out.push(text.slice(i, end + 1));
      last = out.length - 1;
      i = end;
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out.push(' ');
      i = end < 0 ? text.length : end + 1;
    } else {
      if ((char === '}' || char === ']') && last >= 0 && out[last] === ',') out[last] = ' ';
      out.push(char);
      if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') last = out.length - 1;
    }
  }
  return out.join('');
}
