// Model chip in the composer: the picked model's short name ("Opus 5.5") + the picked effort; with nothing picked just
// "Auto" (owner F26, 16.11.2026: Auto is the visible default; 26.11.2026: never "Auto · <model>" – a group chat's agents
// do not all run on one). 26.11.2026 (owner): a pick applies to the NEXT message only – the runtime stamps it on that line
// and takes it off the chat when the line is sent (chat/service.ts, sticky-model.ts withoutChoice), so the chip is
// "Auto" again; the pick reaches the agent as a hint on that line and never changes the agent's own model (its agent page
// does). Menu: first "Auto" (nothing picked,
// the AI decides; hint "<routed model> now", only the name while a pick is set), one searchable list of the chat
// models in catalog order – each row's display name, source and full catalog ID (F05) – only the newest of
// each family (owner 09.11.: "immer die aktuellen Modelle"); an older
// version shows when the search names it, or while it is the chosen one, under "Older versions" – the temperature
// row (0.0–1.0 or Auto: settings.temperatures; its title says where a temperature reaches, B-083 live 09.11.) and the effort row.
// Everything here is a suggestion (B-083, owner 08.11.: "nur … ein kleiner Tipp"): a pick writes settings.modelHints –
// 13.11.2026: information for the agent on the person's line (runtime/context/render.ts suggestionTag), never a route;
// the agent or its subconscious set the model with model.set; Auto clears this agent's model, effort and
// temperature (pickPatch). A connection that may not change the chat sees a plain label.
// Owns: the chip and its menu. Never: changes the agent's identity or global defaults, or routes.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConversationSettings, ConversationSummary } from '../../../shared/model/chat.ts';
import type { Effort, ModelInfo } from '../../../shared/model/providers.ts';
import { Icon, Popover } from '../../lib/ui.tsx';
import { messagesFor, models } from '../../lib/store.ts';
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { toastError } from '../../lib/toasts.ts';
import { isChatModel } from '../../lib/model-fit.ts';
import { modelShortName as shortName, pickerDetails } from '../../lib/model-name.ts';
import { AUTO, useRoutePreview } from '../../lib/route-preview.ts';
import { EFFORT_LABEL } from '../live-text.ts';

type Patch = Pick<ConversationSettings, 'models' | 'modelHints' | 'efforts' | 'temperatures'>;

/** The effort cells when the suggested model lists none of its own (nothing suggested, or an API row's ['none']). */
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Where the slider's thumb rests, dimmed, while the temperature is Auto. */
const AUTO_AT = 0.5;
/** B-083 (live 09.11.2026, owner 09.11.: thinking stays on): where a suggested temperature reaches – the runtime's TEMPERATURE_FACT for the person. */
export const TEMPERATURE_TIP = 'Thinking comes first, so a temperature goes only where it costs none: to the API and local models that take one. Claude and Codex keep their own setting – older Claude models take one only without thinking, the newer ones none, Codex not at all; there the agent varies its drafts.';

async function save(chat: ConversationSummary, patch: Patch, failed = 'Model could not be changed'): Promise<boolean> {
  try {
    await rpc.call('chats.update', { id: chat.id, settings: patch });
    return true;
  } catch (error) { toastError(error, failed); return false; }
}

/** `record` without `key`, as a fresh object (chats.update replaces the whole record). */
function without<T>(record: Record<string, T> | undefined, key: string): Record<string, T> {
  const next = { ...(record ?? {}) };
  delete next[key];
  return next;
}

/** The model the person suggested for the agent in this chat (an older chat may still hold it in `models`). */
export function chosenModel(settings: ConversationSettings, agentId: string): string | undefined {
  const id = settings.modelHints?.[agentId] ?? settings.models?.[agentId];
  return id && id !== 'auto' ? id : undefined;
}

/**
 * What picking `modelId` writes: the suggestion for this agent (modelHints; an older chat's `models` entry goes).
 * 'auto' = nothing suggested: this agent's model, effort and temperature go (`temperatures` only when one is stored).
 */
export function pickPatch(settings: ConversationSettings, agentId: string, modelId: string): Patch {
  const rest = without(settings.models, agentId);
  if (modelId !== 'auto') return { models: rest, modelHints: { ...(settings.modelHints ?? {}), [agentId]: modelId } };
  const patch: Patch = { models: rest, modelHints: without(settings.modelHints, agentId), efforts: without(settings.efforts, agentId) };
  if (settings.temperatures?.[agentId] !== undefined) patch.temperatures = without(settings.temperatures, agentId);
  return patch;
}

/** Model the agent last used in this chat (the chip's name while nothing is chosen and the preview has not answered). */
function lastUsed(chatId: string, agentId: string): string | undefined {
  const list = messagesFor(chatId).value;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].authorId === agentId && list[i].meta.model) return list[i].meta.model;
  }
  return undefined;
}

function ModelRow(props: { model: ModelInfo; selected: boolean; onPick: () => void }) {
  const { model } = props;
  const details = pickerDetails(model);
  return (
    <button type="button" class={`menu-item model-option${model.available ? '' : ' unavailable'}`} role="menuitemradio" aria-checked={props.selected}
      title={model.id} onClick={props.onPick}>
      <span class="menu-label">
        <span>{shortName(model.id) ?? model.name}</span>
        <small class="model-option-details">{details}</small>
      </span>
      {props.selected && <Icon name="check" size={16} class="menu-check" />}
    </button>
  );
}

const tempText = (value: number | undefined) => (value === undefined ? AUTO : value.toFixed(1));
const tenths = (event: Event) => Math.round(Number((event.target as HTMLInputElement).value) * 10) / 10;

/**
 * The suggested temperature: a slider 0.0–1.0 in tenths, saved when it is let go (not while it moves; a tap on Auto's
 * resting point saves 0.5, which fires no change), its value in a fixed cell beside it, and "Auto" (no value).
 * `draft` is what the slider shows until the saved value arrives (null = Auto).
 */
function TemperatureRow(props: { value: number | undefined; onSave: (value: number | undefined) => Promise<boolean> }) {
  const [draft, setDraft] = useState<number | null | undefined>();
  useEffect(() => setDraft(undefined), [props.value]);
  const shown = draft === undefined ? props.value : draft ?? undefined;
  const commit = (value: number | undefined) => {
    setDraft(value ?? null);
    void props.onSave(value).then((saved) => { if (!saved) setDraft(undefined); });
  };
  return (
    <div class={`temp-row${shown === undefined ? ' auto' : ''}`} role="group" aria-label="Temperature" title={TEMPERATURE_TIP}>
      <span class="temp-label">Temperature</span>
      <input class="temp-slider" type="range" min={0} max={1} step={0.1} value={shown ?? AUTO_AT} aria-label="Temperature"
        aria-valuetext={tempText(shown)} onInput={(event) => setDraft(tenths(event))} onChange={(event) => commit(tenths(event))}
        onPointerUp={(event) => { if (shown === undefined) commit(tenths(event)); }} />
      <span class="temp-value">{tempText(shown)}</span>
      <button type="button" class="temp-auto" disabled={shown === undefined} onClick={() => commit(undefined)}>{AUTO}</button>
    </div>
  );
}

export function ModelChip(props: { chat: ConversationSummary; agentId: string | null; openSignal?: number }) {
  const { chat, agentId } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => { if (props.openSignal) setOpen(true); }, [props.openSignal]);
  useEffect(() => { if (!open) setQuery(''); }, [open]); // the catalog comes with every (re)connect (store.loadAll)
  const used = agentId ? lastUsed(chat.id, agentId) : undefined;
  const route = useRoutePreview(agentId, chat.id, [used, models.value]); // asked anew after a turn on another model
  if (!agentId) return <span class="chip model-chip placeholder" aria-hidden="true" />;

  const { settings } = chat;
  const chosen = chosenModel(settings, agentId);
  // what answers with nothing suggested: the routed model, its last run here until the preview answers
  const routed = route?.modelId ?? (chosen ? undefined : used);
  const routedName = shortName(routed);
  const effort = settings.efforts?.[agentId] as Effort | undefined;
  const stored = settings.temperatures?.[agentId];
  const temperature = typeof stored === 'number' ? stored : undefined;
  const chosenInfo = chosen ? models.value.find((model) => model.id === chosen) : undefined;
  const sub = effort ? EFFORT_LABEL[effort] : undefined;
  // 26.11.2026 (owner): nothing picked reads "Auto" and nothing else – no routed model after it (a group chat's agents do not
  // all run on one); a picked effort stays beside it
  const after = sub;
  const listed: readonly Effort[] = chosenInfo?.efforts.filter((value) => value !== 'none') ?? [];
  // a suggested effort the model lacks keeps its cell (lit, so a tap takes it back)
  const efforts = listed.length && (!effort || listed.includes(effort)) ? listed : EFFORTS;
  const pick = (id: string) => { setOpen(false); void save(chat, pickPatch(settings, agentId, id)); };
  const saveTemperature = (value: number | undefined) => save(chat, {
    temperatures: value === undefined ? without(settings.temperatures, agentId) : { ...(settings.temperatures ?? {}), [agentId]: value },
  }, 'Temperature could not be changed');
  const label = (
    <span class="chip-label">
      {chosen ? shortName(chosen) : AUTO}{after && <span class="sub">{` ${after}`}</span>}
    </span>
  );
  if (!can('chats.update')) return <span class="chip model-chip static">{label}</span>;
  const q = query.trim().toLowerCase();
  // Specialists (embeddings, decision, media) are no chat models – a stored choice stays visible; older versions only by search.
  const list = models.value.filter((model) => (model.id === chosen || (isChatModel(model) && (q || !model.newer)))
    && (!q || model.name.toLowerCase().includes(q) || pickerDetails(model).toLowerCase().includes(q)));
  const rows = list.map((model) => <ModelRow key={model.id} model={model} selected={chosen === model.id} onPick={() => pick(model.id)} />);
  // the catalog lists the newest of each family first, the older versions after them (runtime/models/order.ts)
  const older = list.findIndex((model) => model.newer);
  if (older >= 0) rows.splice(older, 0, <p key="older" class="menu-title" role="presentation">Older versions</p>);

  return (
    <>
      <button ref={ref} type="button" class="chip model-chip" aria-haspopup="menu" aria-expanded={open} title="Model" onClick={() => setOpen(!open)}>
        {label}
        <Icon name="caret-down" size={12} class="chip-caret" />
      </button>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="top-end" width={300} class="menu model-menu" role="menu" label="Model">
        <input class="input menu-search" type="text" placeholder="Search models" aria-label="Search models" value={query} autoFocus
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)} />
        <div class="model-list">
          {!q && (
            <button type="button" class="menu-item" role="menuitemradio" aria-checked={!chosen} onClick={() => pick('auto')}>
              <span class="menu-label"><span>{AUTO}</span></span>
              {routedName && <span class="menu-hint">{chosen ? routedName : `${routedName} now`}</span>}
              {!chosen && <Icon name="check" size={16} class="menu-check" />}
            </button>
          )}
          {rows}
          {q && !list.length && <p class="empty-state">No models</p>}
        </div>
        <TemperatureRow key={agentId} value={temperature} onSave={saveTemperature} />
        <div class="menu-section effort-row" role="group" aria-label="Effort">
          {efforts.map((value) => (
            <button type="button" key={value} class={`effort${effort === value ? ' on' : ''}`} aria-pressed={effort === value}
              onClick={() => void save(chat, { efforts: effort === value ? without(settings.efforts, agentId) : { ...(settings.efforts ?? {}), [agentId]: value } })}>
              {EFFORT_LABEL[value]}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
