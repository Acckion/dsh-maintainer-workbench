import { ReportParseError } from "./execution-errors.ts";

/** Extract one complete object, never a nested fragment or one of several reports. */
function reportEnvelope(text: string): unknown | undefined {
  const start = text.search(/[\[{]/);
  if (start < 0 || text[start] !== "{") return undefined;
  const stack: string[] = [];
  let quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      if (stack.pop() !== (c === "}" ? "{" : "[")) return undefined;
      if (stack.length) continue;
      const prefix = text.slice(0, start).replace(/```(?:json)?\s*$/i, "").trim();
      const suffix = text.slice(i + 1).replace(/^\s*```/, "").trim();
      if (!prefix && !suffix && start === 0 && i === text.length - 1) return undefined;
      // Any extra object/array, partial report or extra fence makes the envelope ambiguous.
      if (prefix.length > 1000 || suffix.length > 1000 || /[{}\[\]]|```/.test(prefix + suffix))
        throw new Error("模型输出包含多个或不明确的结果格式，请重试任务；原始输出已保留。");
      try { return JSON.parse(text.slice(start, i + 1)); }
      catch { return undefined; }
    }
  }
  return undefined;
}
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
    const envelope = reportEnvelope(trimmed);
    if (envelope !== undefined) { repaired?.(); return envelope; }
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
