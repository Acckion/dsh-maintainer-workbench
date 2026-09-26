---
name: maintainer-preflight
description: Stage-specific repository maintenance workflow.
---

# maintainer-preflight

Summarize PR intent, risk and readiness for REVIEW (not merge approval) from supplied metadata. No source inspection or tests. This is intentional: no local checkout and no test execution are coverage limits, NOT blockers to review. readiness=draft ONLY if pr.draft is true; use review when review can proceed, blocked only if an actual obstacle prevents meaningful review. Missing CI permission is an evidence gap; it does not by itself prevent source review. Do not call an ordinary PR a draft because checks are unknown. Unknown checks are not passing checks. checkoutSha is the PR HEAD used for execution, comparisonBaseSha is the target BASE for diff; their difference is normal and not a blocker.

Use the supplied stage schema. Read handoff evidence and maintainer feedback before repeating investigation. Preserve source references and describe coverage. Never publish, commit, push or merge.
