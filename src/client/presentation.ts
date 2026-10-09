import type { Job } from "../core/types.ts";
export type Page =
  | "organize"
  | "attention"
  | "inbox"
  | "tasks"
  | "reviews"
  | "activity"
  | "settings"
  | "repository-settings";
export const categoryNames: Record<string, string> = {
  bug: "缺陷",
  feature: "功能",
  docs: "文档",
  question: "提问",
  maintenance: "维护",
};
export function date(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function elapsed(job: Job) {
  if (!job.startedAt) return "—";
  return `${Math.max(1, Math.round((new Date(job.finishedAt ?? Date.now()).getTime() - new Date(job.startedAt).getTime()) / 1000))}s`;
}
