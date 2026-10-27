import {AnalysisEvidence} from './AnalysisEvidence.tsx';
import {useEffect,useState,type ReactNode} from "react";
import {analysisEvidence} from "./evidence-presentation.ts";
import type { Audit, Job } from "../core/types.ts";
import { ExecutionEvidence } from "./ExecutionEvidence.tsx";

export function StageExecutionDetails({
  job,
  audit,
  tools,
  openEvidence,
  openSession,
  showOpenEvidence = true,
}: {
  job?: Job;
  audit: Audit[];
  tools: ReactNode;
  openEvidence: (id: string) => void;
  openSession?: (id: string) => void;
  showOpenEvidence?: boolean;
}) {
  const [view,setView]=useState<'commands'|'evidence'>('commands'),[selected,setSelected]=useState(0);
  useEffect(()=>{setView('commands');setSelected(0);},[job?.id]);
  if (!job) return <p>暂无执行记录。</p>;
  const logs = audit
    .filter((a) => a.jobId === job.id)
    .sort((a, b) => b.at.localeCompare(a.at));
  return (
    <section className="mw-stage-execution" aria-label="执行详情">
      {job.sessionId && openSession && <div className="mw-stage-execution-toolbar"><button className="mw-text-button" onClick={()=>openSession(job.sessionId!)}>打开执行会话</button></div>}
      {['queued','running'].includes(job.status) && logs.length>0 && <section className="mw-stage-log" aria-label="运行日志"><h4>运行日志</h4>{logs.slice(0,20).map(a=><p key={a.id}>{a.detail}</p>)}</section>}
      {!!(job.executionRecords?.length || analysisEvidence(job).length) && <>
        <div className="mw-execution-tabs" role="tablist" aria-label="执行记录内容">
          {!!job.executionRecords?.length&&<button role="tab" aria-selected={view==='commands'} onClick={()=>setView('commands')}>命令与输出 · {job.executionRecords.length}</button>}
          {!!analysisEvidence(job).length&&<button role="tab" aria-selected={view==='evidence'||!job.executionRecords?.length} onClick={()=>setView('evidence')}>分析依据 · {analysisEvidence(job).length}</button>}
        </div>
        {view==='commands'&&job.executionRecords?.length ? <section className="mw-command-browser" aria-label="命令与输出">
          <nav aria-label="执行命令">{job.executionRecords.map((record,index)=><button key={record.id} aria-pressed={index===Math.min(selected,job.executionRecords!.length-1)} onClick={()=>setSelected(index)}><code>{record.command??record.tool}</code><span>{record.isError||record.signal||record.exitCode!==null&&record.exitCode!==0?'执行失败':record.exitCode===0?'退出码 0':'退出码未知'}</span></button>)}</nav>
          {(()=>{const record=job.executionRecords[Math.min(selected,job.executionRecords.length-1)];return <div className="mw-command-output"><p className="mw-muted">{record.recordedAt}{record.truncated?' · 输出已裁剪':''}</p><pre tabIndex={0} aria-label="选中命令输出">{record.output||'此工具未返回文本输出。'}</pre></div>;})()}
        </section>:<AnalysisEvidence job={job} collapsible={false}/>}
      </>}
      {!job.executionRecords?.length&&!analysisEvidence(job).length&&!logs.length&&<p className="mw-muted">此任务没有保存命令输出或分析依据。</p>}
      <details className="mw-execution-technical">
        <summary>技术详情</summary>
        <h4>来源与执行环境</h4>

        <dl className="mw-stage-facts">
          <dt>来源提交</dt>
          <dd>
            <code>{job.baseSha || "未保存"}</code>
          </dd>
          <dt>输入版本</dt>
          <dd>{job.revision}</dd>
          <dt>创建时间</dt>
          <dd>
            {new Date(job.createdAt).toLocaleString("zh-CN", { hour12: false })}
          </dd>
          <dt>产物状态</dt>
          <dd>
            {job.artifactState === "stale"
              ? "已过期"
              : "请以阶段结论及审核状态为准"}
          </dd>
        </dl>
        {job.toolDiagnostics && (
          <>
            <p>
              {job.toolDiagnostics.provider}/{job.toolDiagnostics.model} ·{" "}
              {job.toolDiagnostics.preset} · {job.toolDiagnostics.permission}
            </p>
            {job.toolDiagnostics.toolBudget&&<p>工具预算 {job.toolDiagnostics.toolBudget.used}/{job.toolDiagnostics.toolBudget.limit} · 搜索 {job.toolDiagnostics.toolBudget.searches} · {job.toolDiagnostics.toolBudget.phase==='report'?'已进入收尾':'查阅阶段'} · 收尾请求 {job.toolDiagnostics.toolBudget.reportRequests}/2</p>}
            {job.budgetStopped&&<p>已保存部分结果；任务未完成，不能作为验收通过依据。</p>}
            <p>挂载工具：{job.toolDiagnostics.mountedTools.join(", ")}</p>
            <p>
              请求 {job.toolDiagnostics.requests.length} · 调用{" "}
              {job.toolDiagnostics.calls} · 宿主结果{" "}
              {job.toolDiagnostics.canonicalResults} · 错误{" "}
              {job.toolDiagnostics.errors}
            </p>
            <p>Token {job.tokens ?? "未采集"}</p>
          </>
        )}
        {!!logs.length && !['queued','running'].includes(job.status) && <section className="mw-stage-log" aria-label="运行日志"><h4>运行日志</h4>{logs.map(a=><div className="mw-job-log" key={a.id}><time>{new Date(a.at).toLocaleString('zh-CN',{hour12:false})}</time><p>{a.detail}</p></div>)}</section>}
        {!!job.executionRecords?.length&&<section aria-label="原始工具记录"><h4>原始工具记录</h4>{job.executionRecords.map(record=><ExecutionEvidence key={record.id} job={job} record={record}/>)}</section>}
      {job.rawOutput && !job.result && (
        <details>
          <summary>未解析的原始输出</summary>
          <pre>{job.rawOutput}</pre>
        </details>
      )}
      {tools}
      </details>
    </section>
  );
}
