import type { JobKind } from "../core/types.ts";

interface StagePolicy {
  metadataOnly: boolean;
  producesChanges: boolean;
  preserveSource: boolean;
  permission: "inherit" | "read-only";
}
export const stagePolicies: Record<JobKind, StagePolicy> = {
  triage: {
    metadataOnly: true,
    producesChanges: false,
    preserveSource: true,
    permission: "read-only",
  },
  preflight: {
    metadataOnly: true,
    producesChanges: false,
    preserveSource: true,
    permission: "read-only",
  },
  investigate: {
    metadataOnly: false,
    producesChanges: false,
    preserveSource: false,
    permission: "inherit",
  },
  fix: {
    metadataOnly: false,
    producesChanges: true,
    preserveSource: false,
    permission: "inherit",
  },
  docs: {
    metadataOnly: false,
    producesChanges: true,
    preserveSource: false,
    permission: "inherit",
  },
  validate: {
    metadataOnly: false,
    producesChanges: false,
    preserveSource: true,
    permission: "inherit",
  },
  review: {
    metadataOnly: false,
    producesChanges: false,
    preserveSource: true,
    permission: "read-only",
  },
  ci: {
    metadataOnly: false,
    producesChanges: false,
    preserveSource: true,
    permission: "read-only",
  },
};
