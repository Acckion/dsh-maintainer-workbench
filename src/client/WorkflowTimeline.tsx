import {
  Check,
  Circle,
  Clock3,
  Loader2,
  Pause,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";

export function WorkflowTimeline({
  timeline,
  selected,
  select,
}: {
  timeline: ProcessingTimeline;
  selected?: string;
  select: (node: TimelineNode) => void;
}) {
  const navigation = useRef<HTMLElement>(null);
  const reveal = (button?: HTMLElement | null) => {
    const nav = navigation.current;
    if (!nav || !button) return;
    const target = button.getBoundingClientRect(),
      bounds = nav.getBoundingClientRect();
    nav.scrollBy({
      left:
        target.left < bounds.left
          ? target.left - bounds.left
          : target.right > bounds.right
            ? target.right - bounds.right
            : 0,
    });
  };
  useEffect(() => {
    reveal(
      navigation.current?.querySelector<HTMLElement>('[aria-pressed="true"]'),
    );
  }, [selected]);
  return (
    <nav
      ref={navigation}
      className="mw-workflow-timeline"
      aria-label="处理阶段"
    >
      <ol>
        {timeline.nodes.map((node, index) => {
          const Icon =
            node.status === "running"
              ? Loader2
              : node.status === "queued"
                ? Clock3
                : node.status === "waiting"
                  ? Pause
                  : ["blocked", "stale"].includes(node.status)
                    ? TriangleAlert
                    : ["saved", "completed"].includes(node.status)
                      ? Check
                      : Circle;
          return (
            <li key={node.id} className={`mw-timeline-node ${node.status}`}>
              <button
                type="button"
                aria-label={`${node.label} · ${node.result}`}
                aria-current={
                  node.id === timeline.currentNodeId ? "step" : undefined
                }
                aria-pressed={node.id === selected}
                onClick={() => select(node)}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? timeline.nodes.length - 1
                        : Math.max(
                            0,
                            Math.min(
                              timeline.nodes.length - 1,
                              index + (event.key === "ArrowRight" ? 1 : -1),
                            ),
                          );
                  const button =
                    navigation.current?.querySelectorAll<HTMLButtonElement>(
                      "button",
                    )[next];
                  button?.focus({ preventScroll: true });
                  reveal(button);
                }}
              >
                <span className="mw-timeline-dot">
                  <Icon
                    size={15}
                    className={
                      node.status === "running" ? "mw-spin" : undefined
                    }
                  />
                </span>
                <strong>{node.label}</strong>
                <small>
                  {node.result}
                  {node.attemptIds.length > 1
                    ? ` · ${node.attemptIds.length} 次`
                    : ""}
                </small>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
