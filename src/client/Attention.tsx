import React from "react";
import type { Snapshot } from "../core/types.ts";
import { validationState } from "../core/workflow-state.ts";
export function Attention({
  state,
  open,
}: {
  state: Snapshot;
  open: (repoId: string, issueId?: string) => void;
}) {
  return (
    <div className="mw-attention-grid">
      {state.repos.map((repo) => {
        const issues = state.issues.filter(
          (i) => i.repoId === repo.id && i.state === "open",
        );
        const latest = issues.map((i) => ({
          issue: i,
          job: state.jobs.find((j) => j.issueId === i.id),
        }));
        const needs = latest.filter(({ issue, job }) => issue.processing?.status
          ? ['plan','blocked','review','stale'].includes(issue.processing.status) && (!!issue.orchestration?.draft || !!issue.orchestration?.run || ['failed','awaiting_review'].includes(job?.status ?? '') || (job?.kind === 'validate' && validationState(job.artifact)?.state !== 'passed') || issue.informationRequests?.some(r=>r.state==='reply_received'))
          : ['needs_info','decision','blocked','review'].includes(issue.workflow?.stage ?? '') || ['failed','awaiting_review'].includes(job?.status ?? ''));
        return (
          <section className="mw-settings-card" key={repo.id}>
            <div className="mw-section-title">{repo.fullName}</div>
            <p>
              {issues.length} 个开放事项 · {needs.length} 个需要判断
            </p>
            {needs.slice(0, 8).map(({ issue, job }) => (
              <div className="mw-stage-event" key={issue.id}>
                <button className="mw-text-button" onClick={()=>open(repo.id,issue.id)}>#{issue.number} {issue.title}</button>
                <strong>{issue.processing?.status === "plan" ? "待确认计划" : issue.processing?.status === "review" ? "待最终审核" : "需要补充或解除阻塞"}</strong>
                <p>
                  {issue.processing?.reason ?? job?.error ?? issue.workflow?.reason ?? "变更产物等待审核"}
                </p>
              </div>
            ))}
            {!needs.length && (
              <p className="mw-muted">
                暂无等待判断的事项，可进入队列处理新问题。
              </p>
            )}
            <button className="mw-button" onClick={() => open(repo.id)}>
              进入维护队列
            </button>
          </section>
        );
      })}
    </div>
  );
}
export function RepositoryPolicy({
  state,
  repoId,
  busy,
  save,
}: {
  state: Snapshot;
  repoId: string;
  busy: boolean;
  save: (value: unknown) => void;
}) {
  const repo = state.repos.find((r) => r.id === repoId);
  const defaults = repo?.policy ?? state.settings;
  const [value, setValue] = React.useState({
    syncLimit: defaults.syncLimit ?? state.settings.syncLimit ?? 1000,
    autoPreflight:
      defaults.autoPreflight ?? state.settings.autoPreflight ?? false,
    autoTriage: defaults.autoTriage,
    autoReview: defaults.autoReview ?? false,
    syncIntervalMinutes: defaults.syncIntervalMinutes,
    timeoutMs: defaults.timeoutMs,
    maxTokens: defaults.maxTokens,
  });
  if (!repo) return null;
  return (
    <section className="mw-settings-card">
      <h3>当前仓库策略</h3>
      <p>
        模型继承
        Harness；这里仅调整该仓库的同步与执行预算。远端发布仍使用具体内容预览。
      </p>
      <label>
        <input
          type="checkbox"
          checked={value.autoTriage}
          onChange={(e) => setValue({ ...value, autoTriage: e.target.checked })}
        />{" "}
        自动整理新增或更新 Issue 的处理建议与计划草稿
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.autoPreflight}
          onChange={(e) =>
            setValue({ ...value, autoPreflight: e.target.checked })
          }
        />{" "}
        自动整理新增或更新 PR 的预检与审查建议
      </label>
      <label><input type="checkbox" checked={value.autoReview} onChange={e=>setValue({...value,autoReview:e.target.checked})} /> 自动审查预检已就绪的 PR（只读，不自动修订或发布）</label>
      <label>
        同步记录上限（0 表示无上限）
        <input
          type="number"
          min={0}
          max={1000000}
          value={value.syncLimit}
          onChange={(e) =>
            setValue({ ...value, syncLimit: Number(e.target.value) })
          }
        />
      </label>
      <label>
        同步间隔（分钟，0 关闭）
        <input
          type="number"
          min={0}
          max={1440}
          value={value.syncIntervalMinutes}
          onChange={(e) =>
            setValue({ ...value, syncIntervalMinutes: Number(e.target.value) })
          }
        />
      </label>
      <label>
        单次任务时间上限（秒）
        <input
          type="number"
          min={1}
          max={1800}
          value={value.timeoutMs / 1000}
          onChange={(e) =>
            setValue({ ...value, timeoutMs: Number(e.target.value) * 1000 })
          }
        />
      </label>
      <label>
        输出 Token 上限
        <input
          type="number"
          min={500}
          max={32000}
          value={value.maxTokens}
          onChange={(e) =>
            setValue({ ...value, maxTokens: Number(e.target.value) })
          }
        />
      </label>
      <button
        className="mw-button"
        disabled={busy}
        onClick={() => save({ repoId, policy: value })}
      >
        保存仓库策略
      </button>
    </section>
  );
}
