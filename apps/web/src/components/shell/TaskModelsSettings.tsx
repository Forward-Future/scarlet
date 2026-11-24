import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { TASK_MODELS_MAX, taskModelChoice, taskModelId, type AgentHost, type AgentId, type TaskModelType } from "@scarlet/shared";
import { AGENT_LABEL, onlineAgents, useHostsStore } from "../../stores/hosts";
import { modelChoices, useModelPreferences } from "../../stores/modelPicker";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { Icon, InlineError } from "../ui/primitives";
import { useServerSetting } from "./useServerSetting";

/** A model's plain name, as the hosts signed in to it call it: its label, else its id, else its agent's name. */
export function taskModelName(hosts: readonly AgentHost[], by: { agent: string; model?: string }): string {
  const label = hosts.filter(h => h.online).flatMap(h => h.agents).find(a => a.id === by.agent && a.modelLabels?.[by.model ?? ""])?.modelLabels?.[by.model ?? ""];
  return label ?? by.model ?? AGENT_LABEL[by.agent as AgentId] ?? by.agent;
}

/**
 * Which model does each kind of work (Settings → Models). Every row is a kind of work the editor named, one sentence on
 * what counts as it, which the model running a request reads, and the model that does it: Same as chat, or one of the
 * models signed in. Cutting and Motion graphics come first; the editor adds, renames and deletes their own.
 */
export function TaskModelsSettings() {
  const { hosts, customOpenaiModels, customClaudeModels, customGeminiModels, status } = useHostsStore();
  const { hidden } = useModelPreferences();
  const { value, error, choose } = useServerSetting("taskModels");
  const [focusId, setFocusId] = useState<string>();
  if (!value) return error ? <InlineError>{error}</InlineError> : null;
  const choices = modelChoices(onlineAgents(hosts, customOpenaiModels, customClaudeModels, customGeminiModels));
  const save = (next: TaskModelType[]) => void choose(next);
  const update = (id: string, patch: Partial<TaskModelType>) => save(value.map(t => t.id === id ? { ...t, ...patch } : t));
  const add = () => {
    const id = taskModelId("New task", value.map(t => t.id));
    setFocusId(id);
    save([...value, { id, name: "New task", description: "", model: "same" }]);
  };
  const optionsFor = (type: TaskModelType) => {
    const shown = choices.filter(c => !hidden.includes(c.key) || c.key === type.model);
    const missing = type.model !== "same" && !choices.some(c => c.key === type.model);
    const saved = missing ? taskModelChoice(type) : undefined;
    const savedName = saved && taskModelName(hosts, saved);
    return [
      { value: "same", label: "Same as chat" },
      ...shown.map(c => ({ value: c.key, label: c.label, group: AGENT_LABEL[c.agent] })),
      // A model chosen that isn't signed in now stays chosen, and says so. While the models are read, it's just named.
      ...(saved ? [{ value: type.model, label: status === "loading" ? savedName! : `${savedName} (not signed in)`, group: AGENT_LABEL[saved.agent as AgentId] }] : []),
    ];
  };
  return (
    <section className="card transcription-preferences check-in-preferences task-models-preferences" aria-labelledby="task-models-heading">
      <div className="transcription-header">
        <div className="transcription-heading">
          <span className="transcription-glyph"><Icon name="stack" size={22} /></span>
          <div>
            <h2 id="task-models-heading">Task models</h2>
            <p>Choose which model does each kind of work. The chat’s model hands that work to it.</p>
          </div>
        </div>
      </div>
      <ul className="task-models" aria-label="Task models">
        {value.map(type => (
          <TaskModelRow key={type.id} type={type} options={optionsFor(type)} focus={focusId === type.id}
            onFocused={() => setFocusId(undefined)} onChange={patch => update(type.id, patch)}
            onDelete={() => save(value.filter(t => t.id !== type.id))} />
        ))}
      </ul>
      {value.length < TASK_MODELS_MAX && <div className="task-models-add">
        <button type="button" className="btn-quiet" onClick={add}><Icon name="plus" size={12} />Add task</button>
      </div>}
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}

/** One kind of work: its name and what counts as it, saved when the editor leaves the field or presses Enter, and its model, saved when picked. */
function TaskModelRow({ type, options, focus, onFocused, onChange, onDelete }: {
  type: TaskModelType;
  options: { value: string; label: string; group?: string }[];
  focus: boolean;
  onFocused(): void;
  onChange(patch: Partial<TaskModelType>): void;
  onDelete(): void;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => setName(type.name), [type.name]);
  useEffect(() => setDescription(type.description), [type.description]);
  useEffect(() => {
    if (!focus) return;
    nameField.current?.focus();
    nameField.current?.select();
    onFocused();
  }, [focus, onFocused]);
  const saveName = () => {
    const next = name.trim();
    // A name can't be empty: an emptied one goes back to what it was.
    if (!next) return setName(type.name);
    setName(next);
    if (next !== type.name) onChange({ name: next });
  };
  const saveDescription = () => {
    const next = description.trim();
    setDescription(next);
    if (next !== type.description) onChange({ description: next });
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    else if (e.key === "Escape") {
      // Esc puts the field back as it was saved, and stops there instead of leaving Settings.
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget === nameField.current) setName(type.name);
      else setDescription(type.description);
    }
  };
  const shownName = type.name;
  return (
    <li className="task-model">
      <div className="task-model-text">
        <input ref={nameField} className="task-model-name" aria-label="Task name" value={name} maxLength={40}
          onChange={e => setName(e.target.value)} onBlur={saveName} onKeyDown={onEnter} />
        <input className="task-model-description" aria-label={`What counts as ${shownName}`} placeholder="What counts as this work"
          value={description} maxLength={300} title={description || undefined}
          onChange={e => setDescription(e.target.value)} onBlur={saveDescription} onKeyDown={onEnter} />
      </div>
      <div className="task-model-pick">
        <PreferenceSelect id={`task-model-${type.id}`} label={`Model for ${shownName}`} value={type.model} options={options}
          onChange={model => onChange({ model })} />
      </div>
      <button type="button" className="btn-icon task-model-delete" aria-label={`Delete ${shownName}`} title={`Delete ${shownName}`} onClick={onDelete}>
        <Icon name="x" size={12} />
      </button>
    </li>
  );
}
