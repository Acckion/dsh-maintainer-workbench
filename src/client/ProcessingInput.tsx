import { useState } from "react";
import type { Issue } from "../core/types.ts";
import type { ProcessingWait } from "../domain/processing.ts";

export function ProcessingInput({
  issue,
  busy,
  act,
}: {
  issue: Issue;
  busy: boolean;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
}) {
  return (
    <>
      {issue.processing?.waits
        .filter((w) => w.type === "user_input" && w.state === "open")
        .map((wait) => (
          <InputForm
            key={wait.id}
            wait={wait}
            issue={issue}
            busy={busy}
            act={act}
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
}: {
  wait: ProcessingWait;
  issue: Issue;
  busy: boolean;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <form
      className="mw-callout amber"
      onSubmit={(event) => {
        event.preventDefault();
        void act(
          "/processing/input",
          {
            issueId: issue.id,
            waitId: wait.id,
            values,
            expectedVersion: issue.processing?.version,
          },
          "已保存补充输入，可继续处理",
        );
      }}
    >
      <div>
        <strong>需要补充信息</strong>
        <p>{wait.reason}</p>
        {wait.questions?.map((field) => (
          <label key={field.id}>
            {field.question}
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
              required
              rows={2}
              maxLength={4000}
              value={values[field.id] ?? ""}
              onChange={(event) =>
                setValues({ ...values, [field.id]: event.target.value })
              }
            />
          </label>
        ))}
        <button
          className="mw-button primary"
          disabled={
            busy || wait.requiredFields?.some((id) => !values[id]?.trim())
          }
        >
          保存补充输入
        </button>
      </div>
    </form>
  );
}
