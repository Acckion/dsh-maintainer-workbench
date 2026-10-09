---
name: maintainer-preflight
description: Stage-specific repository maintenance workflow.
---

# maintainer-preflight

Summarize PR intent, risk and readiness for REVIEW (not merge approval) from supplied metadata. No source inspection or tests. This is intentional: no local checkout and no test execution are coverage limits, NOT blockers to review. readiness=draft ONLY if pr.draft is true; use review when review can proceed, blocked only if an actual obstacle prevents meaningful review. Missing CI permission is an evidence gap; it does not by itself prevent source review. Do not call an ordinary PR a draft because checks are unknown. Unknown checks are not passing checks. checkoutSha is the PR HEAD used for execution, comparisonBaseSha is the target BASE for diff; their difference is normal and not a blocker.

Use the supplied stage schema. Read handoff evidence and maintainer feedback before repeating investigation. Preserve source references and describe coverage. Never publish, commit, push or merge.

Lead with review readiness, then name at most three change-specific review targets as concrete invariants (for example, whether repository A can access repository B's task data). These are inspection targets, not confirmed defects. Scale depth to the diff metadata; do not prescribe the same checklist for every PR. When review can proceed, recommend the workbench review action directly. Tests belong to a later validation action; do not ask a human to manually run a command merely because this preflight stage cannot. Only an actual missing permission or environment should require user intervention. Missing check-runs permission belongs in coverage and must not delay source review. Default responseDraft to an empty string: readiness summaries and internal scope limits are not useful comments to the author.
