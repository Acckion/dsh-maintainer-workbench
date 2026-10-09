import React from "react";
import { Row, Toggle } from "./GlobalSettingsFields.tsx";
import type { Snapshot } from "../core/types.ts";
import { validationState } from "../core/workflow-state.ts";
export function Attention({
  state,
  open,
}: {
  state: Snapshot;
  open: (repoId: string) => void;
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
        const needs = latest.filter(
          ({ issue, job }) =>
            issue.informationRequests?.some(
              (r) => r.state === "reply_received",
            ) ||
            ["needs_info", "decision", "blocked", "review"].includes(
              issue.processing?.phase ?? "",
            ) ||
            ["failed", "awaiting_review"].includes(job?.status ?? "") ||
            (validationState(job?.artifact)?.state !== undefined &&
              validationState(job?.artifact)?.state !== "passed"),
        );
        return (
          <section className="mw-settings-card" key={repo.id}>
            <div className="mw-section-title">{repo.fullName}</div>
            <p>
              {issues.length} 个开放事项 · {needs.length} 个需要判断
            </p>
            {needs.slice(0, 8).map(({ issue, job }) => (
              <div className="mw-stage-event" key={issue.id}>
                <strong>
                  #{issue.number} {issue.title}
                </strong>
                <p>
                  {job?.error ?? issue.processing?.reason ?? "变更产物等待审核"}
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
  save: (value: unknown) => Promise<unknown>;
}) {
  const repo = state.repos.find((r) => r.id === repoId);
  const defaults = repo?.policy ?? state.settings;
  const [value, setValue] = React.useState({
    syncLimit: defaults.syncLimit ?? state.settings.syncLimit ?? 1000,
    autoPreflight:
      defaults.autoPreflight ?? state.settings.autoPreflight ?? false,
    autoTriage: defaults.autoTriage,
    syncIntervalMinutes: defaults.syncIntervalMinutes,
    timeoutMs: defaults.timeoutMs,
    maxTokens: defaults.maxTokens,
  });
  const identity = JSON.stringify(value);
  const initial = React.useRef(identity), attempted = React.useRef(identity);
  const saveRef = React.useRef(save); saveRef.current = save;
  const [error, setError] = React.useState("");
  const persist = async () => {
    setError("");
    attempted.current = identity;
    try {
      const result = await saveRef.current({repoId, policy:value});
      if (result === undefined) setError("仓库设置未保存，请重试。");
      else initial.current = identity;
    } catch(e) {setError(e instanceof Error ? e.message : "保存失败");}
  };
  const persistRef = React.useRef(persist); persistRef.current = persist;
  React.useEffect(() => {
    if (busy || identity === initial.current || identity === attempted.current) return;
    const timer = setTimeout(() => void persistRef.current(), 600);
    return () => clearTimeout(timer);
  }, [identity, busy]);
  if (!repo) return null;
  const number = (key:"syncLimit"|"syncIntervalMinutes"|"timeoutMs"|"maxTokens", label:string, min:number, max:number, factor=1) =>
    <Row label={label}><input type="number" aria-label={label} min={min} max={max} disabled={busy}
      value={value[key]/factor} onChange={e=>setValue({...value,[key]:Number(e.target.value)*factor})}/></Row>;
  return <section className="mw-settings-card">
    <h3>仓库设置</h3>
    <Toggle label="自动分诊新增或更新的 Issue" description="" value={value.autoTriage} change={autoTriage=>setValue({...value,autoTriage})}/>
    <Toggle label="自动快速预检新增或更新的 PR" description="" value={value.autoPreflight} change={autoPreflight=>setValue({...value,autoPreflight})}/>
    {number("syncLimit","同步记录上限（0 表示无上限）",0,1000000)}
    {number("syncIntervalMinutes","同步间隔（分钟，0 关闭）",0,1440)}
    <details className="mw-preference-details"><summary>高级执行选项</summary>
      {number("timeoutMs","单次任务时间上限（秒）",1,1800,1000)}
      {number("maxTokens","输出 Token 上限",500,32000)}
    </details>
    {error && <div role="alert" className="mw-settings-feedback error">{error} <button type="button" className="mw-button" disabled={busy} onClick={()=>void persist()}>重试保存</button></div>}
  </section>;
}
