import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { HostModelCatalog, ModelChoice } from "../core/types.ts";

export function ModelPicker({ label, value, catalog, inherit, select }: {
  label: string; value?: ModelChoice; catalog: HostModelCatalog;
  inherit: string; select: (choice?: ModelChoice) => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const element = popup.current;
    if (!element) return;
    const toggled = () => setExpanded(element.matches(":popover-open"));
    element.addEventListener("toggle", toggled);
    return () => element.removeEventListener("toggle", toggled);
  }, []);
  const model = catalog.groups.find(g => g.id === value?.provider)?.models.find(m => m.id === value?.model);
  const text = value ? model?.name ?? `${value.provider}/${value.model}（不可用）` : inherit;
  const choose = (choice?: ModelChoice) => { select(choice); popup.current?.hidePopover(); trigger.current?.focus(); };
  const open = () => {
    const element = popup.current, button = trigger.current;
    if (!element || !button) return;
    if (element.matches(":popover-open")) { element.hidePopover(); return; }
    setSearch("");
    const rect = button.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 300), window.innerWidth - 24);
    element.style.width = `${width}px`;
    element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    element.style.maxHeight = `${Math.max(160, Math.min(360, window.innerHeight - 24))}px`;
    element.showPopover();
    const height = element.getBoundingClientRect().height;
    element.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - height - 12))}px`;
    queueMicrotask(() => (element.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? element.querySelector<HTMLButtonElement>('button'))?.focus());
  };
  return <div className="mw-model-picker">
    <span id={`${id}-label`} className="mw-model-label">{label}</span>
    <button ref={trigger} type="button" className="mw-model-trigger" aria-labelledby={`${id}-label ${id}-value`}
      aria-haspopup="menu" aria-expanded={expanded} aria-controls={id} onClick={open} onKeyDown={e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
      }}>
      <span id={`${id}-value`}>{text}</span><ChevronDown size={16}/>
    </button>
    <div ref={popup} id={id} {...{popover: "auto"}} className="mw-model-menu" role="menu" aria-label={`${label}选择`}
      onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); popup.current?.hidePopover(); trigger.current?.focus(); }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.target instanceof HTMLInputElement) return;
        e.preventDefault();
        const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {catalog.groups.reduce((n, g) => n + g.models.length, 0) > 4 && <input type="search" aria-label="搜索模型"
        placeholder="搜索模型…" value={search} onChange={e => setSearch(e.target.value)} />}
      <button type="button" role="menuitemradio" aria-checked={!value} onClick={() => choose()}>{inherit}{!value && <Check size={17}/>}</button>
      {catalog.groups.map(group => {
        const models = group.models.filter(m => `${group.name} ${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()));
        if (!models.length) return null;
        return <div key={group.id} role="group" aria-label={group.name}>
          <div className="mw-model-provider">{group.name}</div>
          {models.map(m => <button type="button" role="menuitemradio" key={m.id}
            aria-checked={value?.provider === group.id && value?.model === m.id}
            onClick={() => choose({provider: group.id, model: m.id})}>
            <span>{m.name}</span>{value?.provider === group.id && value?.model === m.id && <Check size={17}/>}</button>)}
        </div>;
      })}
    </div>
    {value && !model && <span className="mw-model-unavailable">此模型已不在 Harness 列表中，请重新选择。</span>}
    {!!model?.reasoning?.efforts.length && <label className="mw-model-effort">推理等级
      <select aria-label={`${label}推理等级`} value={value?.reasoningEffort ?? ""} onChange={e => select({provider: value!.provider, model: value!.model,
        ...(e.target.value ? {reasoningEffort: e.target.value} : {})})}>
        <option value="">模型默认{model.reasoning.defaultEffort ? `（${model.reasoning.efforts.find(e => e.id === model.reasoning!.defaultEffort)?.name ?? model.reasoning.defaultEffort}）` : ""}</option>
        {model.reasoning.efforts.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
    </label>}
  </div>;
}
