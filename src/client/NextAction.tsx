import type { ReactNode } from "react";
import type { ProcessingTimeline } from "../domain/timeline.ts";

/** Keep the live task discoverable while the reader browses saved stages. */
export function NextAction({
  timeline,
  back,
  tools,
  showBack = true,
}: {
  timeline: ProcessingTimeline;
  back: () => void;
  tools?: ReactNode;
  showBack?: boolean;
}) {
  const current = timeline.nodes.find((n) => n.id === timeline.currentNodeId);
  return (
    <aside className="mw-workflow-current" aria-label="当前处理与下一步">
      <span>
        {timeline.historical
          ? "历史周期仅供查看"
          : `当前进度：${current?.label} · ${current?.result}`}
      </span>
      <div className="mw-workflow-current-actions">
      {tools}
      {showBack && <button type="button" className="mw-text-button" onClick={back}>
        返回当前阶段
      </button>}
      </div>
    </aside>
  );
}
