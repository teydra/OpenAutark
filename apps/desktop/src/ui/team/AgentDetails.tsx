// Agent page, working setup: the model – B-083 (owner 08.11.2026): row "Now" says what it really runs on (its live
// run's model · where it runs (F05: "Opus 5.5 · Claude Code") · effort and temperature – "T 0.3", "T ≈0.3" with a title
// where the model samples at its own setting – from
// the activity feed, else its last turn's from agents.runs, read when shown and after every reconnect (lib/use-load.ts,
// like the agent's folder below); a run that ends while
// the page is open leaves its live values there). 26.11.2026: the one "Model" row shows that model and a click opens the
// choice ("Auto" = chosen per task; chat models only, in catalog order – the catalog comes with the shell's load,
// store.loadAll), then "From next context" (stored as the start model, applied when its context is next rebuilt) or
// "Now" (asks "Switch model now?" first; the agent reads the whole conversation again) – a start value it changes
// itself when the work needs another,
// and the runtime tells it who set it (models.setPolicy stores pinBy). Then the agent's two files that open in
// the pane's file tab (SYSTEM.md, last-prompt.md; B-081: a missing SYSTEM.md opens in the editor, a missing
// last-prompt.md on the not-found page), the agent folder with its skills (the agent and the AI write
// SKILL.md files; here only their names and "Open folder") and the schedules it owns (each row has the schedule menu:
// pause or resume, delete) – F06: the active ones by their next run, the paused ones under one fixed "Paused (n)" toggle
// at the end (opening it only adds rows below), ended one-shots not at all (tasks/schedule-state.ts; Chat details
// still lists them as "Ended"). Owner 15.11.2026: "From you" – the agent's HUMAN.md as one fixed-height field the person
// edits (saved when it loses focus, agents.setHuman); it stands last in the agent's prompt and nothing but the person
// changes it; HUMAN.md also opens as a file. Nothing else is set here – whom it reports to, effort limits or budgets are things the AI
// changes on request. Both model rows are always there, each with its one-line hint and its value slot, so nothing
// moves when a run starts or ends.
// Owns: these sections. Never: invents data – the folder and skills come from the runtime; never polls.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import '../../shared/api/methods-agent-core.ts'; // agents.core (module augmentation)
import type { Agent } from '../../shared/model/org.ts';
import { HUMAN_FILE, MAX_HUMAN_MD, SYSTEM_FILE, type AgentCoreInfo } from '../../shared/model/agent-core.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { Schedule } from '../../shared/model/tasks.ts';
import { Icon, Popover } from '../lib/ui.tsx';
import { confirm } from '../lib/dialog.tsx';
import { pendingModel, SWITCH_HINT, SWITCH_LABEL, SWITCH_NOW_CONFIRM, switchRequest, type SwitchWhen } from './agent-model.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { models } from '../lib/store.ts';
import { useLoad } from '../lib/use-load.ts';
import { platform } from '../lib/platform.ts';
import { isChatModel } from '../lib/model-fit.ts';
import { modelShortName, nameWithSource } from '../lib/model-name.ts';
import { modelLine, shownOf, temperatureTitle, withTemperature } from '../chat/live-text.ts';
import { AUTO } from '../lib/route-preview.ts';
import { liveByAgent } from './org-state.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { openFileTab, pathMenu } from '../workspace/file-tabs.ts';
import { fullDate } from '../lib/format.ts';
import { toastError } from '../lib/toasts.ts';
import { skillTitle } from './agent-core-model.ts';
import { ensureSchedules, scheduleMenu, schedules } from '../tasks/schedules.ts';
import { agentSchedules, scheduleState } from '../tasks/schedule-state.ts';

function Section(props: { title: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="agent-section" aria-label={props.title}>
      <div class="agent-section-head"><h3 class="agent-section-title">{props.title}</h3>{props.action}</div>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; hint?: string; children?: ComponentChildren; menu?: ReturnType<typeof useContextMenu> }) {
  return (
    <div class="agent-row" {...props.menu}>
      <span class="agent-row-text"><span class="agent-row-label">{props.label}</span>{props.hint && <small class="agent-row-hint">{props.hint}</small>}</span>
      {props.children}
    </div>
  );
}

type Route = Pick<AgentActivity, 'model' | 'modelName' | 'effort' | 'temperature' | 'temperatureSent'>;

/**
 * What the agent runs on: its live run's route, else its last turn's ("Opus 5.5 · High · T 0.3"). Owner 26.11.2026: a click
 * opens the model list; a picked model comes with "From next context" and "Now" (agent-model.ts) – "Now" asks first. A start
 * model that waits for the next context is named under the label.
 */
function NowRow(props: { agent: Agent; readOnly: boolean }) {
  const { agent } = props;
  const agentId = agent.id;
  const live = liveByAgent.value.get(agentId);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | undefined>(); // the model whose timing is being chosen ('' = Auto never gets here)
  useEffect(() => { if (!open) setPicked(undefined); }, [open]);
  const [last, setLast] = useState<Route | undefined>();
  useEffect(() => setLast(undefined), [agentId]); // another agent: never the last one's turn
  useLoad(() => {
    let alive = true;
    if (!can('agents.runs')) return; // a device without the runs: the live run only
    rpc.call('agents.runs', { id: agentId, limit: 5 })
      .then((runs) => {
        const run = runs.find((entry) => entry.model);
        if (!alive || !run) return;
        const route: Route = { model: run.model, effort: run.effort, temperature: run.route?.temperature, temperatureSent: run.route?.temperatureSent };
        // while a live run shows, its route (the effect below) stays the newer one; otherwise the answer replaces it, so a
        // turn run while this page was disconnected shows after the reconnect
        setLast((seen) => (liveByAgent.peek().get(agentId)?.model ? seen ?? route : route));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [agentId]);
  // a run that ends leaves its last route here (the feed updates it after a failover or an in-turn switch)
  useEffect(() => {
    if (live?.model) setLast({ model: live.model, modelName: live.modelName, effort: live.effort, temperature: live.temperature, temperatureSent: live.temperatureSent });
  }, [agentId, live?.model, live?.modelName, live?.effort, live?.temperature, live?.temperatureSent]);
  const shown = live?.model ? live : last;
  const line = shown?.model ? modelLine({ ...shown, modelName: nameWithSource(shown.modelName || modelShortName(shown.model) || '', shown.model) }) : '';
  const warmth = shownOf(shown); // B-083: "T 0.3" in the same label – the row keeps its height
  const choosing = Boolean(live && !live.model); // the last turn's route stays out of the value and its title
  const value = choosing ? 'Choosing a model' : withTemperature(line, warmth) || '–';
  const stance = !choosing && line ? temperatureTitle(warmth) : '';
  const pin = agent.modelPolicy?.pin;
  const pending = pendingModel(pin, shown?.model);
  const pendingName = pending ? models.value.find((model) => model.id === pending)?.name ?? modelShortName(pending) ?? pending : undefined;
  const hint = pendingName ? `${pendingName} from its next context` : live ? 'Working now' : last ? 'Its last turn' : 'Not working now';
  const locked = props.readOnly || !can('models.setPolicy');
  const apply = async (model: string, when: SwitchWhen) => {
    setOpen(false);
    if (when === 'now' && model && !(await confirm(SWITCH_NOW_CONFIRM))) return;
    try { await rpc.call('models.setPolicy', switchRequest(agentId, agent.modelPolicy, model, when)); } catch (error) { toastError(error, 'Could not save the model'); }
  };
  // the catalog's order (newest of each family first, older versions below)
  const chat = models.value.filter((model) => (model.available && isChatModel(model)) || model.id === pin);
  const title = stance ? `${line} · ${stance}` : value;
  const name = (id: string) => models.value.find((model) => model.id === id)?.name ?? id;
  return (
    <Row label="Model" hint={hint}>
      {locked ? <span class="agent-row-label" title={title}>{value}</span> : (
        <>
          <button ref={anchor} type="button" class="chip model-chip agent-model" aria-haspopup="menu" aria-expanded={open} title={title} onClick={() => setOpen(!open)}>
            <span class="chip-label">{value}</span>
            <Icon name="caret-down" size={12} class="chip-caret" />
          </button>
          <Popover anchor={anchor.current} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={300} class="menu model-menu" role="menu" label="Model">
            {picked === undefined ? (
              <div class="model-list">
                <button type="button" class="menu-item" role="menuitemradio" aria-checked={!pin} onClick={() => void apply('', 'next')}>
                  <span class="menu-label"><span>{`${AUTO} – chosen per task`}</span></span>
                  {!pin && <Icon name="check" size={16} class="menu-check" />}
                </button>
                {chat.map((model) => (
                  <button key={model.id} type="button" class={`menu-item model-option${model.available ? '' : ' unavailable'}`} role="menuitemradio" aria-checked={pin === model.id}
                    title={model.id} onClick={() => setPicked(model.id)}>
                    <span class="menu-label">
                      <span>{model.available ? model.name : `${model.name} (unavailable)`}</span>
                      {model.newer && <small class="model-option-details">Older version</small>}
                    </span>
                    {pin === model.id && <Icon name="check" size={16} class="menu-check" />}
                  </button>
                ))}
              </div>
            ) : (
              <div class="model-list">
                <p class="menu-title" role="presentation">{name(picked)}</p>
                {(['next', 'now'] as const).map((when) => (
                  <button key={when} type="button" class="menu-item" role="menuitem" onClick={() => void apply(picked, when)}>
                    <span class="menu-label"><span>{SWITCH_LABEL[when]}</span><small class="model-option-details">{SWITCH_HINT[when]}</small></span>
                  </button>
                ))}
                <button type="button" class="menu-item" role="menuitem" onClick={() => setPicked(undefined)}>
                  <span class="menu-label"><span>Back</span></span>
                </button>
              </div>
            )}
          </Popover>
        </>
      )}
    </Row>
  );
}

function ModelSection(props: { agent: Agent; readOnly: boolean }) {
  return (
    <Section title="Model">
      <NowRow agent={props.agent} readOnly={props.readOnly} />
    </Section>
  );
}

/** One file of the agent's folder, opened in the pane's file tab; `create`: a file meant to be made opens in the editor
 *  while it is missing (B-081), instead of the not-found page. */
function FileRow(props: { folder: string; name: string; hint: string; create?: boolean }) {
  const file = `${props.folder}${props.folder.includes('\\') ? '\\' : '/'}${props.name}`;
  const menu = useContextMenu(() => pathMenu(file));
  return <Row label={props.name} hint={props.hint} menu={menu}><button type="button" class="text-button" onClick={() => openFileTab(file, undefined, undefined, undefined, props.create ? { create: true } : undefined)}>Open</button></Row>;
}

/** "From you": HUMAN.md in a fixed field – saved on leaving it; a save that fails keeps the typed text and says so. */
function HumanSection(props: { agentId: string; text: string; readOnly: boolean }) {
  const [draft, setDraft] = useState(props.text);
  const [saved, setSaved] = useState(props.text);
  useEffect(() => { setDraft(props.text); setSaved(props.text); }, [props.agentId, props.text]);
  const save = async () => {
    if (draft.trim() === saved.trim()) return;
    try { const { human } = await rpc.call('agents.setHuman', { agentId: props.agentId, text: draft }); setSaved(human); } catch (error) { toastError(error, 'Could not save the text'); }
  };
  return (
    <Section title="From you">
      <textarea class="input agent-human" rows={4} maxLength={MAX_HUMAN_MD} value={draft} readOnly={props.readOnly} aria-label="From you"
        placeholder="What this agent should always know from you" onInput={(event) => setDraft(event.currentTarget.value)} onBlur={() => void save()} />
      <small class="agent-human-hint">Near the end of its instructions; your lines for every agent (Settings › Security) come last. Updates never change it.</small>
    </Section>
  );
}

function FolderSection(props: { agent: Agent }) {
  const { agent } = props;
  const [info, setInfo] = useState<AgentCoreInfo | null>(null);
  useLoad(() => {
    let alive = true;
    const load = () => { rpc.call('agents.core', { agentId: agent.id }).then((core) => { if (alive) setInfo(core); }).catch(() => undefined); };
    load();
    const offCore = rpc.on('agentCore.changed', (event) => { if (event.agentId === agent.id) load(); });
    const offSkills = rpc.on('skills.changed', load);
    return () => { alive = false; offCore(); offSkills(); };
  }, [agent.id, agent.instructions]);
  const main = info?.mainSkills ?? [];
  const own = agent.skills.filter((skill) => !main.some((entry) => entry.name === skill));
  if (!info && !own.length) return null;
  const folder = info?.folder;
  const open = () => { if (folder) void rpc.call('files.openPath', { path: folder }).catch((error) => toastError(error, 'Could not open the folder')); };
  return (
    <>
    {info?.human !== undefined && <HumanSection agentId={agent.id} text={info.human} readOnly={agent.archivedAt !== undefined || !can('agents.setHuman')} />}
    {folder && can('files.readPath') && (
      <Section title="Files">
        <FileRow folder={folder} name={SYSTEM_FILE} hint="Its instructions" create />
        <FileRow folder={folder} name={HUMAN_FILE} hint="Your own lines to it, near the end of its instructions" create />
        <FileRow folder={folder} name="last-prompt.md" hint="The whole system prompt the app sent on its last turn" />
      </Section>
    )}
    <Section title="Skills" action={platform === 'desktop' && folder ? <button type="button" class="text-button" onClick={open}>Open folder</button> : undefined}>
      {!main.length && !own.length && <Row label="No skills yet" />}
      {main.map((skill) => <Row key={skill.name} label={skillTitle(skill.name)} hint={skill.description} />)}
      {own.map((skill) => <Row key={skill} label={skillTitle(skill)} />)}
    </Section>
    </>
  );
}

function ScheduleRow(props: { item: Schedule }) {
  const { item } = props;
  const menu = useContextMenu(() => scheduleMenu(item));
  const state = scheduleState(item);
  const hint = state === 'next' ? `Next ${fullDate(item.nextAt!)}` : state === 'none' ? 'No next run' : 'Paused';
  return <Row label={item.title} hint={hint} menu={menu} />;
}

/** F06: the active schedules by their next run; the paused ones under one fixed "Paused (n)" toggle at the end. */
function SchedulesSection(props: { agentId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { ensureSchedules(); }, []);
  const { active, paused } = agentSchedules(schedules.value, props.agentId);
  if (!active.length && !paused.length) return null;
  return (
    <Section title="Schedules">
      {active.map((item) => <ScheduleRow key={item.id} item={item} />)}
      {paused.length > 0 && (
        <button type="button" class="agent-fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'caret-down' : 'caret-right'} size={12} />
          <span>Paused ({paused.length})</span>
        </button>
      )}
      {open && paused.map((item) => <ScheduleRow key={item.id} item={item} />)}
    </Section>
  );
}

export function AgentDetails(props: { agent: Agent }) {
  const { agent } = props;
  const live = agent.archivedAt === undefined;
  return (
    <>
      <ModelSection agent={agent} readOnly={!live} />
      <FolderSection agent={agent} />
      <SchedulesSection agentId={agent.id} />
    </>
  );
}
