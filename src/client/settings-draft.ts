import type { Settings } from "../core/types.ts";

function canonical(value: unknown, row = false): unknown {
  if (Array.isArray(value)) return value.map(v => canonical(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key, value]) => (!row || key !== "id") && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
  return value;
}
/** Persistence metadata and nested map order do not constitute a draft change. */
export function settingsIdentity(settings: Settings): string {
  return JSON.stringify(canonical(settings, true));
}
