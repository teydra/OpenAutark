// files.delete (task_7ja3mcr6, after 24.11. and 27.11.2026: an unquoted `cmd /c rd /s /q` under "…\Autark Companies\…"
// split at its space and deleted the first company's data folder): the agents' structured way to delete. Each path is
// taken as it is – one argument, no shell in between –, must be absolute and exist, and must not pass a link on its way
// (delete-zones.ts linkOnWay); it must not be, hold or lie in a kept folder (every company's data folder, this PC's plan
// logins, the app's installation, the person's browser profiles – delete-zones.ts), as written or as its real path; a
// folder holding a data mark anywhere inside stops it before anything goes (delete-tree.ts planTree). Links inside are
// removed as links, never entered. dryRun answers what would go and deletes nothing. A refused or failed path leaves the
// others as they are; the call is an error when any path did not go.
// zonesFor is also the zones of shell.exec's delete guard (files.ts, files/shell-deletes.ts).
// Owns: the tool and the zones of a call. Never: deletes without the checks, follows a link, retries.

import { lstat } from 'node:fs/promises';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { defineTool } from './util.ts';
import { deleteZones, linkOnWay, pathOf, refusalOf, type DeleteZones } from '../../files/delete-zones.ts';
import { planTree, removeTree } from '../../files/delete-tree.ts';

const MAX_PATHS = 20;

/** The kept and open folders for a call of `ctx`'s company (what is not known is left out, never a throw). */
export function zonesFor(ctx: Pick<ToolContext, 'services'>): DeleteZones {
  const paths = ctx.services.paths ?? ({} as Partial<ToolContext['services']['paths']>);
  let app: ToolContext['services']['host']['app'] | undefined;
  try { app = ctx.services.host?.app; } catch { app = undefined; }
  return deleteZones({
    data: paths.data, workspace: paths.workspace, temp: paths.temp, accounts: paths.accounts,
    ...(app?.companies ? { companies: app.companies } : {}),
    ...(app ? { app: { packaged: app.packaged, executable: app.executable, resourcesDir: app.resourcesDir } } : {}),
  });
}

/** Why `given` is no path files.delete takes as it is; undefined when it is one. */
function shapeRefusal(given: string, platform: NodeJS.Platform): string | undefined {
  if (!given.trim()) return 'an empty path';
  if (given !== given.trim()) return 'the path starts or ends with a space – it is taken exactly as given';
  if (/[*?]/.test(given) || (platform === 'win32' && /[<>|"]/.test(given))) return 'a wildcard or a sign a path cannot hold – one exact path per entry';
  const absolute = platform === 'win32' ? /^(?:[a-z]:[\\/]|\\\\)/i.test(given) : given.startsWith('/');
  if (!absolute) return 'not an absolute path – the whole path, from the drive or /';
  return undefined;
}

const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

async function deleteOne(given: string, zones: DeleteZones, dryRun: boolean, signal: AbortSignal): Promise<{ ok: boolean; line: string }> {
  const refuse = (why: string) => ({ ok: false, line: `REFUSED ${given} – ${why}` });
  const shape = shapeRefusal(given, zones.platform);
  if (shape) return refuse(shape);
  const full = pathOf(zones.platform).resolve(given);
  const info = await lstat(full).catch(() => undefined);
  if (!info) return refuse('it does not exist');
  const link = linkOnWay(full, zones);
  if (link) return refuse(`the way to it passes the link ${link}; I give the path the link points to`);
  const why = refusalOf(full, zones, false);
  if (why) return refuse(why);
  if (info.isSymbolicLink()) {
    if (dryRun) return { ok: true, line: `WOULD DELETE ${full} – a link: the link alone, not what it points to` };
    const removal = await removeTree(full);
    return removal.failed ? { ok: false, line: `FAILED ${full} – ${removal.failed.code}` } : { ok: true, line: `DELETED ${full} – the link alone` };
  }
  const plan = await planTree(full, signal);
  if (plan.marked) return refuse(`it holds a data folder: ${plan.marked} – a company's data or a browser profile, also as a copy, does not go this way`);
  const what = info.isDirectory()
    ? `${plan.files} files in ${plan.folders} folders, ${size(plan.bytes)}${plan.links ? `, ${plan.links} links removed as links` : ''}`
    : `a file, ${size(plan.bytes)}`;
  if (dryRun) return { ok: true, line: `WOULD DELETE ${full} – ${what}` };
  if (signal.aborted) return { ok: false, line: `STOPPED ${full} – nothing deleted` };
  const removal = await removeTree(full);
  if (removal.failed) return { ok: false, line: `FAILED ${full} – ${removal.removed} entries deleted, then ${removal.failed.code} at ${removal.failed.path}` };
  return { ok: true, line: `DELETED ${full} – ${what}` };
}

export async function runDelete(paths: string[], dryRun: boolean, zones: DeleteZones, signal: AbortSignal): Promise<ToolOutput> {
  const lines: string[] = [];
  let failed = false;
  for (const given of paths) {
    if (signal.aborted) { lines.push(`STOPPED ${given} – not reached`); failed = true; continue; }
    const result = await deleteOne(given, zones, dryRun, signal).catch((error: NodeJS.ErrnoException) => ({ ok: false, line: `FAILED ${given} – ${error.code ?? 'error'}` }));
    lines.push(result.line);
    failed ||= !result.ok;
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], ...(failed ? { isError: true } : {}) };
}

const listOf = (args: { path?: string; paths?: string[] }): string[] => [...(args.path !== undefined ? [args.path] : []), ...(args.paths ?? [])];

export const deleteTool: ToolDef = defineTool<{ path?: string; paths?: string[]; dryRun?: boolean }>({
  name: 'files.delete',
  description: 'Deletes files or folders by their exact paths; dryRun first shows what would go. Each path is one absolute path, taken as it is (no shell, so spaces need no quotes); links inside are removed as links, not entered. It refuses company data folders, this PC\'s plan logins, the app\'s installation, browser profiles, any folder holding one of them, a path that passes a link on its way, and a folder with a data copy inside.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 1024, description: 'One absolute path.' },
      paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 1024 }, maxItems: MAX_PATHS, description: 'Several absolute paths.' },
      dryRun: { type: 'boolean', description: 'Only show what would go.' },
    },
    additionalProperties: false,
  },
  category: 'delete', remote: true,
  describe: (args) => {
    const all = listOf(args);
    return { summary: `${args.dryRun ? 'Check delete of' : 'Delete'} ${all[0] ?? 'nothing'}${all.length > 1 ? ` and ${all.length - 1} more` : ''}`, resource: all.join(' | '), reversible: Boolean(args.dryRun), external: false };
  },
  async run(args, ctx) {
    const all = listOf(args);
    if (!all.length) return { content: [{ type: 'text', text: 'No path given: path or paths names what to delete.' }], isError: true };
    if (all.length > MAX_PATHS) return { content: [{ type: 'text', text: `At most ${MAX_PATHS} paths per call.` }], isError: true };
    return runDelete(all, args.dryRun === true, zonesFor(ctx), ctx.signal);
  },
});
