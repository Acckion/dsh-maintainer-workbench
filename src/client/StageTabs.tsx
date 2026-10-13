import type { StageSelection } from "./StagePanel.tsx";

/** Navigation changes the visible content only; it never executes a workflow action. */
export function StageTabs({
  items,
  selected,
  panelId,
  onSelect,
}: {
  items: { id: StageSelection["detail"]; label: string }[];
  selected: StageSelection["detail"];
  panelId: string;
  onSelect: (id: StageSelection["detail"]) => void;
}) {
  return (
    <div className="mw-stage-tabs" role="tablist" aria-label="阶段详情">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`${panelId}-${item.id}`}
          aria-controls={panelId}
          aria-selected={item.id === selected}
          tabIndex={item.id === selected ? 0 : -1}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              );
            buttons?.[next]?.focus();
            onSelect(items[next].id);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
