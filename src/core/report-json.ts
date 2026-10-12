import { ReportParseError } from "./execution-errors.ts";

export function parseObject(text: string, repaired?: () => void): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (trimmed.length > 200000)
    throw new ReportParseError("模型输出过长，请缩小报告范围。", "oversized");
  let value: unknown;
  let changed = false;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Remove redundant punctuation outside strings; never invent missing content.
    let fixed = "",
      quoted = false,
      escaped = false;
    const stack: string[] = [];
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (quoted) {
        fixed += c;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === "{" || c === "[") stack.push(c);
      else if (
        c === "]" &&
        stack.at(-1) === "{" &&
        /^\s*[,}]/.test(trimmed.slice(i + 1))
      )
        continue;
      else if (c === "}" || c === "]") {
        if (stack.at(-1) !== (c === "}" ? "{" : "["))
          throw new ReportParseError("模型结果格式不完整；原始输出已保留。", "syntax");
        stack.pop();
      } else if (c === "," && /^\s*[}\]]/.test(trimmed.slice(i + 1))) continue;
      fixed += c;
    }
    if (quoted || stack.length || !trimmed.endsWith("}"))
      throw new ReportParseError(
        "模型结果可能被截断；原始输出已保留。", "truncated",
      );
    try {
      value = JSON.parse(fixed);
    } catch {
      throw new ReportParseError("模型未返回有效的结果格式；原始输出已保留。", "syntax");
    }
    changed = true;
  }
  if (changed) repaired?.();
  return value;
}
