import type { Settings } from "../core/types.ts";

/** Persistence may include the row id and reorder fields without changing values. */
export function settingsIdentity(settings: Settings): string {
  return JSON.stringify(Object.entries(settings)
    .filter(([key]) => key !== "id")
    .sort(([a], [b]) => a.localeCompare(b)));
}
