// Engine registry: lazy construction of engines from factories, shutdown (each engine ends its idle processes itself).
// Owns: one engine instance per id and the wiring of shared deps (supervisor, finder, keys, the
// ACP agent resolver – which agent command an ACP account starts). The Codex app-server and ACP agents
// start in the empty engine folder (system/paths.ts engineCwd), never in temp: runtime helper turns
// (decisions, compaction) work in temp, and a CLI loads project config from its own process folder.
// B-072: the CLI engines (Codex, Claude Code, ACP) get the agents' env – AUTARK_DATA and the `wf` shim first on
// PATH (wf-shim.ts), built once when the first of them is.
// Never: routes (router does) or starts processes at construction time (engines start lazily).

import path from 'node:path';
import type { EngineId } from '../../shared/model/providers.ts';
import type { AccountLimits, Account } from '../../shared/model/providers.ts';
import type { EngineRegistry as EngineRegistryContract } from '../contracts.ts';
import type { Engine } from './types.ts';
import type { Supervisor } from '../system/supervisor.ts';
import type { ExecutableFinder } from '../accounts/executables.ts';
import { CodexEngine } from './codex/engine.ts';
import { ClaudeEngine } from './claude/engine.ts';
import { OpenAiEngine } from './http/openai.ts';
import { AnthropicEngine } from './http/anthropic.ts';
import { CompatibleEngine } from './http/compatible.ts';
import { FakeEngine } from './fake.ts';
import { AcpEngine, type AcpResolver } from './acp/engine.ts';
import type { SecurityLookup } from './codex/native-gate.ts';
import type { FetchFn } from './http/common.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { engineCwd, homeRoots } from '../system/paths.ts';
import { agentEnv } from './wf-shim.ts';
import type { ManagedPathStore } from './managed-path.ts';

export type EngineFactories = Partial<Record<EngineId, () => Engine>>;

export class EngineRegistry implements EngineRegistryContract {
  private readonly factories: EngineFactories;
  private readonly engines = new Map<EngineId, Engine>();

  constructor(factories: EngineFactories) {
    this.factories = factories;
  }

  get(id: EngineId): Engine {
    let engine = this.engines.get(id);
    if (!engine) {
      const factory = this.factories[id];
      if (!factory) throw new WorkforceError('unavailable', 'This engine is not available.', { details: { engine: id } });
      engine = factory();
      this.engines.set(id, engine);
    }
    return engine;
  }

  all(): Engine[] {
    return (Object.keys(this.factories) as EngineId[]).map((id) => this.get(id));
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.engines.values()].map((engine) => engine.dispose()));
    this.engines.clear();
  }
}

/** B-048 E2: where Claude Code transcripts rebuilt by the app live (<data>/engine-transcripts/claude). */
export function claudeTranscriptsDir(data: string): string {
  return path.join(data, 'engine-transcripts', 'claude');
}

/** Default wiring used by the composition root. */
export function createEngineRegistry(deps: {
  supervisor: Supervisor; finder: ExecutableFinder; paths: { temp: string; data: string; accounts?: string }; version: string;
  apiKey: (account: Account) => Promise<string | undefined>;
  onLimits?: (accountId: string, limits: AccountLimits) => void;
  /** A warning for the runtime log (Codex: why a connection closed). */
  warn?: (message: string, data: Record<string, unknown>) => void;
  fetch?: FetchFn; fake?: boolean;
  /** ACP accounts → the agent to start (undefined: no ACP agent is known yet, turns report it as not installed). */
  acp?: AcpResolver;
  /** Sicher-Runde 19.11.2026: the security service – in Secure mode native tools go through its gate. */
  security?: SecurityLookup;
  /** 0.3.19: the managed-shell marks of native sessions (managed-path.ts) – Claude Code and Codex resume a session after a restart only on a matching mark. */
  managed?: ManagedPathStore;
}): EngineRegistry {
  const http = { apiKey: deps.apiKey, fetch: deps.fetch };
  const processCwd = engineCwd(deps.paths);
  let shared: NodeJS.ProcessEnv | undefined;
  const env = () => (shared ??= agentEnv(deps.paths.data));
  const factories: EngineFactories = {
    codex: () => new CodexEngine({ supervisor: deps.supervisor, finder: deps.finder, cwd: processCwd, version: deps.version, onLimits: deps.onLimits, log: deps.warn, env: env(), security: deps.security, tempDir: deps.paths.temp, managed: deps.managed }),
    // B-048 E2: rebuilt transcripts live in the app's data folder; only the app's own homes may take the 'project' tier.
    claude: () => new ClaudeEngine({
      supervisor: deps.supervisor, finder: deps.finder, tempDir: deps.paths.temp, env: env(),
      transcriptsDir: claudeTranscriptsDir(deps.paths.data), accountsRoots: homeRoots(deps.paths), security: deps.security, // the plans' homes (Paths.accounts) and <data>/accounts
      managed: deps.managed,
    }),
    openai: () => new OpenAiEngine(http),
    anthropic: () => new AnthropicEngine(http),
    compatible: () => new CompatibleEngine(http),
    acp: () => new AcpEngine({ supervisor: deps.supervisor, launch: deps.acp ?? (async () => undefined), cwd: processCwd, version: deps.version, env: env(), security: deps.security }),
  };
  if (deps.fake) factories.fake = () => new FakeEngine();
  return new EngineRegistry(factories);
}
