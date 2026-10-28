import {reporterWait} from "../core/reporter-question.ts";
import { useState, useEffect, useRef } from "react";
import type { Issue,Job } from "../core/types.ts";
import type { ProcessingWait } from "../domain/processing.ts";

export function ProcessingInput({
  issue,
  busy,
  act,
  runId,
  job,
  embedded = false,
}: {
  job?:Job;
  runId?: string;
  embedded?: boolean;
  issue: Issue;
  busy: boolean;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
}) {
  return (
    <>
      {issue.processing?.waits
        .filter(
          (w) =>
            w.type === "user_input" &&
            w.state === "open" &&
            (!runId || !w.requestedByRunId || w.requestedByRunId === runId),
        )
        .map((wait) => (
          reporterWait(wait) && job ? <ReporterInquiryStatus key={wait.id} job={job} issue={issue} wait={wait} busy={busy} act={act}/> : <InputForm
            key={wait.id}
            wait={wait}
            issue={issue}
            busy={busy}
            act={act}
            embedded={embedded}
          />
        ))}
    </>
  );
}
function InputForm({
  wait,
  issue,
  busy,
  act,
  embedded,
}: {
  embedded?: boolean;
  wait: ProcessingWait;
  issue: Issue;
  busy: boolean;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, string>>(()=>Object.fromEntries(Object.entries(wait.answers ?? {}).map(([id,a])=>[id,a.value])));
  const [dispositions,setDispositions]=useState<Record<string,string>>(()=>Object.fromEntries(Object.entries(wait.answers ?? {}).map(([id,a])=>[id,a.state])));
  const dirty=useRef(new Set<string>());
  useEffect(()=>{
    for(const [id,answer] of Object.entries(wait.answers ?? {})) if(!dirty.current.has(id)) {
      setValues(old=>({...old,[id]:answer.value}));
      setDispositions(old=>({...old,[id]:answer.state}));
    }
  },[JSON.stringify(wait.answers)]);
  return (
    <form
      className={embedded ? "mw-stage-input mw-processing-input" : "mw-callout amber mw-processing-input"}
      onSubmit={(event) => {
        event.preventDefault();
        void act(
          "/processing/input",
          {
            issueId: issue.id,
            waitId: wait.id,
            values,
            dispositions,
            expectedVersion: issue.processing?.version,
          },
          "已保存资料；必需信息未齐备时等待保留",
        );
      }}
    >
      <div>
        {!embedded && <strong>需要补充信息</strong>}
        <p>{wait.reason}</p>
        <p className="mw-muted">请求对象：{wait.expectedActor === 'maintainer' || !wait.expectedActor ? '维护者' : wait.expectedActor}。可代填报告者资料，或先保存未知项。保存资料不扩大原有范围，也不代表验证通过。</p>
        {wait.questions?.map((field) => (
          <label key={field.id}>
            {field.question} · {field.purpose==='decision'?'维护者取舍':field.actor==='reporter'?'报告者资料':'事实资料'} · {wait.requiredFields?.includes(field.id)?'当前阶段必需':'可选'}
            <select aria-label={`${field.question}资料状态`} value={dispositions[field.id] ?? 'provided'} onChange={event=>{dirty.current.add(field.id);setDispositions({...dispositions,[field.id]:event.target.value});}}>
              <option value="provided">提供资料</option><option value="unknown">暂时未知</option><option value="unavailable">无法提供</option><option value="reporter">等待报告者提供</option>
            </select>
            {field.options?.length ? (
              <small>
                可选：
                {field.options
                  .map(
                    (option) =>
                      `${option.label}${option.description ? `（${option.description}）` : ""}`,
                  )
                  .join("；")}
              </small>
            ) : null}
            <textarea
              aria-label={field.question}
              rows={2}
              maxLength={4000}
              value={values[field.id] ?? ""}
              onChange={(event) =>
                (dirty.current.add(field.id),setValues({ ...values, [field.id]: event.target.value }))
              }
            />
          </label>
        ))}
        <button
          className="mw-button primary"
          disabled={
            busy || (!Object.values(values).some(v=>v.trim()) && !Object.values(dispositions).some(v=>v!=="provided"))
          }
        >
          保存资料与未解决项
        </button>
      </div>
    </form>
  );
}


export function ReporterInquiryStatus({job,issue,wait,busy,act}:{job:Job;issue:Issue;wait?:ProcessingWait;busy:boolean;act:(path:string,data:unknown,message:string)=>Promise<unknown>}) {
 const inquiry=job.reporterInquiry;
 if(!inquiry&&!wait)return null;
 const request=issue.informationRequests?.find(r=>r.id===inquiry?.requestId);
 const questions=wait?.questions?.map(q=>q.question)??job.artifact?.inputRequest?.fields.filter(q=>q.actor==='reporter').map(q=>q.question)??[];
 return <section className="mw-callout mw-reporter-inquiry" aria-label="向 Issue 报告者补充提问">
  <h4>{inquiry?.status==='published'?(request?.state==='reply_received'?'报告者已回复，正在重新分诊':'已向报告者提问，等待回复'):inquiry?.status==='publishing'?'正在向 Issue 发布补充问题':'向报告者补充提问'}</h4>
  <p>这些资料由 @{issue.author} 在原 Issue 中补充，维护者无需代填。</p>
  <ol>{questions.map(q=><li key={q}>{q}</li>)}</ol>
  {inquiry?.url&&<a href={inquiry.url} target="_blank" rel="noreferrer">查看 Issue 中的补充问题 ↗</a>}
  {inquiry?.status==='published'?<p className="mw-muted">同步仓库检测到报告者回复后，会重新分诊并核对资料是否足够；收到回复不代表问题已解决。</p>:<>
   {inquiry?.error&&<p role="alert">提问未确认发布：{inquiry.error}</p>}
   <button className="mw-button primary" disabled={busy||inquiry?.status==='publishing'} onClick={()=>void act('/processing/ask-reporter',{id:job.id},'已向 Issue 报告者发布补充问题，等待回复')}>{inquiry?.status==='failed'?'重试发布补充问题':'向 Issue 报告者提问'}</button>
  </>}
 </section>;
}
