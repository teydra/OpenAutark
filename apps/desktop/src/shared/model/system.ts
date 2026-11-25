// System model: settings, profile, files, feedback, updates, health, the data root.
// Owns: shapes of app-wide configuration and housekeeping data.
// Never: secrets (they live in the secret store and are referenced by id).

import type { ProviderEntry } from './provider-entries.ts';
import { securityDefaults, type SecuritySettings } from './security-settings.ts';

export interface Profile {
  name: string; // the person (CEO)
  company: string; // legal/company name (optional master data)
  avatarFileId?: string;
  language: string; // UI/agent default language, e.g. 'de' or 'en' (B-078: starts as the PC's, the AI sets it when the person speaks another)
  timezone: string; // IANA, default OS zone
  /** B-078 (D17): the AI's own note on how the person wants to be spoken to (≤ 600 characters; the stable prompt's "My environment"). */
  notes?: string;
  // 19.11.2026: pcAccess and forEveryAgent became the section `security` and its topic files (bridge/sicher-1119.ts).
}

/** B-078 (D13): the public skill library (runtime/knowledge, track T3). */
export interface LibrarySettings {
  /** Skills and notes worth sharing go to the public library at library.openautark.com, after the checks (default on). */
  publish: boolean;
}

/** 25.11.2026: the anonymous usage count (runtime/usage, README › What Autark counts). Each PC keeps its own switch: it never travels with the settings sync. */
export interface UsageSettings {
  /** This PC adds 1 to our hourly counter when it is used – no id, no version, no content (default on). */
  count: boolean;
}

export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  sidebarOpen: boolean;
  sidebarWidth: number; // 200..420
  workspaceOpen: boolean; // global right pane
  workspaceWidth: number;
  enterSends: boolean;
  openAtLogin: boolean;
  autoDownloadUpdates: boolean;
  /** 0.3.20: this PC does not go to standby while the app runs and the PC is on mains power (main/keep-awake.ts); the screen may still turn off. */
  keepPcAwake: boolean;
  /** The person's order of the rail's destinations (ui/shell/nav-order.ts); [] or absent = the default order. */
  navOrder?: string[];
  /**
   * The plan logins the person said "Not here" to (accounts.declineFound), as the offer's keys such as "codex:default": one
   * list for the whole company – the settings sync carries it between their PCs, so none of them offers the login again.
   * "Use" / "Add again" take a key out. Absent = none.
   */
  declinedLogins?: string[];
}

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
  /** A line at the bottom while an agent uses this PC, with Watch (default false: feedback 17.11.2026 – agents use the PC all day). */
  computerUse: boolean;
  quietHours?: { from: string; to: string };
  /** What may interrupt: human to-dos, blockers, important messages (always quiet otherwise). */
  pushFor: Array<'todo' | 'blocker' | 'important' | 'done' | 'reply'>;
}

/** Voice (skill app-settings explains every key). Hearing: this PC's model → a transcription service → the free listening model. */
export interface VoiceSettings {
  ttsVoice?: string;
  /** Names and terms the recognizer should know (≤ 1000, each ≤ 120 characters); old {term} objects read as their term. */
  vocabulary: string[];
  /** 'auto': a chat's voice mode uses Realtime voice when an OpenAI or Google key offers it; 'off': this PC's speech. Default 'off' (it bills per minute). */
  realtime: 'auto' | 'off';
  /** A call without a real-time model: the Decisions model answers at once while the agent works (runtime/calls/talker.ts). false: the agent answers every line. Default on. */
  talker?: boolean;
  /** The local speech-to-text model (shared/model/local-speech-models.ts id; '' or unset = none). */
  localStt?: string;
  /** The local text-to-speech voice model (same catalog; '' or unset = none – speechSynthesis reads). */
  localTts?: string;
}

/**
 * settings.json "Models": which model each use takes (shared/model/models-uses.ts – 'auto', a model id
 * '<provider>:<model>', for work also a plan's provider id, for the media uses also 'off'), how 'auto' picks and
 * whether pay-per-use keys may take over.
 */
export interface RoutingSettings {
  work: string;
  decision: string;
  voice: string;
  stt: string;
  tts: string;
  image: string;
  video: string;
  music: string;
  sound: string;
  embeddings: string;
  costMode: 'economy' | 'balanced' | 'best';
  allowPaidFallback: boolean; // may spill over to pay-per-use API keys
}

/**
 * The first run (ui/onboarding): the choice card (step 'tour': new company or my other PC), the AI card, then About
 * you; 'done' once it is through. A stored 'team'
 * or 'voice' (older cards) reads as 'about'. "Set up team again" starts at 'ai'.
 */
export type OnboardingStep = 'tour' | 'ai' | 'about' | 'done';
export const ONBOARDING_STEPS: readonly OnboardingStep[] = ['tour', 'ai', 'about', 'done'];

export interface Settings {
  profile: Profile;
  preferences: Preferences;
  notifications: NotificationSettings;
  voice: VoiceSettings;
  routing: RoutingSettings;
  /**
   * `step`: the first-run layer's card – 'done' once it is through (installs finished before it existed read
   * 'done', migration 69); `completed`: the Manager finished the setup interview.
   */
  onboarding: { completed: boolean; step: OnboardingStep };
  /**
   * Where reports go is the team's receiver shipped with the build (resources/feedback/receiver.json, B-055), never a
   * setting: the old repo/privateRepo/endpoint values were removed (migration 55, 23.10.2026).
   */
  feedback: { includeDiagnostics: boolean };
  pwa: { enabled: boolean; bind: 'localhost' | 'lan' | 'tailscale' };
  devices: DeviceSettings;
  /** B-078: the public skill library; absent in settings read before it existed (then publish counts as on). */
  library?: LibrarySettings;
  /** 25.11.2026: the anonymous usage count; absent in settings read before it existed (then it counts as on). */
  usage?: UsageSettings;
  /** The API connections, by id (shared/model/provider-entries.ts); absent while there are none. */
  providers?: Record<string, ProviderEntry>;
  /** Owner 19.11.2026: the security mode and its switches (shared/model/security-settings.ts); read it with securityOf. */
  security?: SecuritySettings;
}

/** The company's security settings: the stored section, or Trust AI mode's defaults when a file has none yet. */
export function securityOf(settings: Pick<Settings, 'security'> | undefined): SecuritySettings {
  return settings?.security ?? securityDefaults('trust');
}

/** Linked PCs: the dedicated peer listener other PCs reach this PC on (runtime/http/peer-server.ts). */
export interface DeviceSettings {
  /** 'lan' every interface, 'tailscale' only this PC's tailnet addresses, 'off' never opens. */
  peer: 'lan' | 'tailscale' | 'off';
  /** Port of the peer listener (another free port when it is taken). */
  peerPort: number;
  /**
   * Remote: other PCs find this PC by its Remote ID or name and may ask to connect (the person
   * accepts each request); keeps the peer listener open. Absent = on (older settings files).
   */
  findable?: boolean;
  /**
   * The meeting server (wss://…, shared/model/relay.ts relayAddress) linked PCs in other networks find
   * each other at. Absent = Autark's own (DEFAULT_RELAY); empty = off.
   */
  relay?: string;
  /** F25: a phone app may reach this PC over a WebRTC data channel it sets up through its tunnel. Absent = on. */
  rtc?: boolean;
  /** F25: the STUN servers ("stun:host:port", ≤ 4) offered for it; empty = none (then only on the same network or
   * tailnet). Absent = DEFAULT_STUN (shared/model/relay.ts). */
  stun?: string[];
  /**
   * 0.3.19 (23.11.2026): "Wake while closed" – while the app is closed a small helper waits, so Wake from my phone or
   * another PC and scheduled work start it again (Windows: kept alive by the desktop broker service). Absent = on.
   */
  wakeHelper?: boolean;
}

/** Partial deep update accepted by settings.update. */
export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

export interface FileRef {
  id: string; // sha256
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  textPreview?: string; // extracted text head (pdf/text)
  width?: number;
  height?: number;
  durationMs?: number;
}

export type FeedbackKind = 'bug' | 'idea' | 'change' | 'praise';
export type FeedbackVisibility = 'public' | 'private';

export interface FeedbackReport {
  id: string;
  /** Agent reports always; a person's report only when one was chosen (16.11.2026: the menu no longer claims "bug"). */
  kind?: FeedbackKind;
  text: string;
  author: string; // 'human' or agent id (agent reports are untrusted)
  /**
   * Owner 21.11.2026: the report's images in order (each as it goes – a person's marks are painted in). A row stored by an
   * older build has its one image (the annotated screenshot, else the screenshot) here too (store/feedback.ts).
   */
  imageFileIds?: string[];
  /** A person's report whose text was dictated: the text is the transcript (owner 20.11.2026: never a recording). */
  dictated?: true;
  /**
   * `runId`: agent reports only – the run that filed the report. `version`/`os`: this PC's runtime. 16.11.2026:
   * `client` – where the person wrote it (the writing page's own facts, redacted); `company` – this company's data
   * folder ('first', 'company-2'); `clientId` – the writing device's id for the report (feedback.create dedupe);
   * `clientDiagnostics` – that device's own diagnostics (an Android crash report), redacted.
   */
  context: {
    view?: string; conversationId?: string; version: string; os: string; runId?: string;
    client?: string; company?: string; clientId?: string; clientDiagnostics?: string;
  };
  /**
   * B-055: 'sent' = the sealed report is in the team's mailbox (only the team can open it). Older states stay
   * readable: queued = an older browser draft, received = an older receiver's receipt with GitHub pending.
   */
  status: 'draft' | 'queued' | 'sent' | 'received' | 'local' | 'dismissed';
  url?: string; // older reports only: a created GitHub issue / prefilled url
  createdAt: number;
  sentAt?: number;
  /** The mailbox document id of the sealed report (older reports: the receiver's receipt). */
  receiptId?: string;
  /** B-055: every report is sent 'private' (sealed for the team); 'public' only on older GitHub reports. */
  visibility?: FeedbackVisibility;
  /** The report arrived, but without something it had (SCREENSHOT_DROPPED in feedback-delivery.ts; older builds: a recording left behind). */
  deliveryWarning?: string;
  /** Agent reports: how often the same text was reported within 24 h (absent = once). */
  count?: number;
}

export interface UpdateState {
  status: 'development' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'current' | 'error';
  version: string;
  availableVersion?: string;
  percent: number;
  restartAt?: number;
  message?: string;
  /** Failed update step; background check failures need no global retry control. */
  failure?: 'check' | 'download' | 'open' | 'restart';
  automaticInstall: boolean;
  downloadURL?: string;
}

export interface SystemInfo {
  version: string;
  platform: string;
  arch: string;
  dataDir: string;
  deviceId: string;
  deviceName: string;
  packaged: boolean;
  startedAt: number;
  /** Whether linked PCs can reach this PC right now (Settings › Devices shows it). */
  peer?: PeerListenerState;
  /** RC1: what this start did after an update or a crash ("Updated to X · N tasks continued"), shown once. F25: `failed` – an
   *  install did not land ("The update to X did not install · …"): its line stays until Dismiss and Settings › About shows it;
   *  `to` – the version it would have brought (main's updater does not install that one by itself again). */
  notice?: { id: string; text: string; at: number; failed?: true; to?: string };
}

/** The dedicated peer listener: open while a pairing is in flight or a PC is linked. */
export interface PeerListenerState {
  /** 'closed' until a PC is linked or a pairing is open; 'error' when it could not listen. */
  status: 'open' | 'closed' | 'off' | 'error';
  mode: DeviceSettings['peer'];
  /** Port it listens on (while open). */
  port?: number;
  /** Base URLs other PCs dial (http://<ip>:<port>), tailnet first; empty unless open. */
  addresses: string[];
  /** Why it could not listen: a socket error code (EADDRINUSE, EACCES …) or NO_TAILNET. */
  error?: string;
}

export interface ResourceState {
  freeMemoryMb: number;
  totalMemoryMb: number;
  cpuCount: number;
  heavySlots: number; // B-080: the parts an agent runs at once (SPLIT_LIMITS.runningPerAgent); no lane has a global limit
  heavyInUse: number; // running heavy processes (engine CLIs)
  queued: number; // due wakes not run yet
  processes: Array<{ kind: string; pid: number; accountId?: string; idleMs: number }>;
  /** Added by MM9: the runtime process itself. */
  runtime?: RuntimeUsage;
}

/** Added by MM9: memory and CPU of the runtime process, and its resident knowledge vector index. */
export interface RuntimeUsage {
  pid: number;
  rssMb: number;
  heapUsedMb: number;
  /** V8's reserved heap and the memory outside it (Buffers, native objects such as SQLite's cache): with rss they say where the process's size sits. */
  heapTotalMb?: number;
  externalMb?: number;
  /** CPU time (user + system) since the process started. */
  cpuMs: number;
  uptimeMs: number;
  /** CPU share of one core since the previous system.resources read (or since start), in percent. */
  cpuPercent: number;
  /** Resident vector index worker threads (0 after 10 idle minutes) and their vector memory. */
  vectorWorkers: number;
  vectorIndexMb: number;
}

/** B-044 open file system: the one documented data route `<data>` (Electron userData or WORKFORCE_TEST_DATA). */
export interface RootInfo {
  /** Absolute path of `<data>`. */
  path: string;
  /** Absolute path of the workspace (projects, shared skills). */
  workspace: string;
  /** Absolute path of the generated map `<data>/README.md` (every folder, who writes it, what it does). */
  readme: string;
  /** Quiet notices of the folder's files right now (e.g. a section of settings.json that was not used); absent = none. */
  notices?: string[];
}

declare module '../api/methods.ts' {
  interface Methods {
    /** B-044 (OPEN-FS), owner: where `<data>` and its map are (Settings › About "Autark folder"); B-081 `device`: that linked CEO PC's. */
    'system.root': { params: { device?: string } | void; result: RootInfo };
  }
}
