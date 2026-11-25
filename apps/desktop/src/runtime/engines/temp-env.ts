// Secure mode's temp folder for the engines (25.11.2026, after Andrea Griffiths' VM test: the OS temp folder was one of
// the team's own folders, so anything there – other programs' files too – lay open to read and change). The own
// folders now hold only <data>/tmp (security/policy.ts tempFolders); a Secure-mode agent turn gets TMP, TEMP and TMPDIR
// pointing there, so the CLIs and their shells keep their scratch files where the team may work without asking:
// Claude Code's process (claude/engine.ts) and every shell of a Codex thread (codex/engine.ts, shell_environment_policy.set).
// Trust AI mode keeps the PC's own temp folder (nothing changes there).
// Owns: those three variables. Never: creates or cleans the folder.

const TEMP_KEYS = ['TMP', 'TEMP', 'TMPDIR'] as const;

/** TMP, TEMP and TMPDIR pointing at `dir`. */
export function ownTempEnv(dir: string): Record<string, string> {
  return Object.fromEntries(TEMP_KEYS.map((key) => [key, dir]));
}

/**
 * A Codex thread's shell variables (shell_environment_policy.set): in Secure mode with TMP, TEMP and TMPDIR at `dir`. They
 * are set when the thread starts or resumes, so a thread opened before a switch to Secure keeps its old temp until then.
 */
export function secureShellEnv(base: Record<string, string> | undefined, dir: string | undefined, secure: boolean): Record<string, string> | undefined {
  return secure && dir ? { ...base, ...ownTempEnv(dir) } : base;
}

/** `env` with TMP, TEMP and TMPDIR at `dir` – any spelling of them taken out first (Windows names ignore case). */
export function withOwnTemp(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!TEMP_KEYS.includes(key.toUpperCase() as typeof TEMP_KEYS[number])) out[key] = value;
  return { ...out, ...ownTempEnv(dir) };
}
