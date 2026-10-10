import { useState, useEffect, useRef } from "react";
import type { Issue } from "../core/types.ts";
import type { ProcessingWait } from "../domain/processing.ts";

export function ProcessingInput({
  issue,
  busy,
  act,
  runId,
  embedded = false,
}: {
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
          <InputForm
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
