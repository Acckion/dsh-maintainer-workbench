---
name: maintainer-ci
description: Stage-specific repository maintenance workflow.
---

# maintainer-ci

Diagnose supplied CI evidence and inspect relevant workflow/source. Distinguish regression, baseline failure, flaky tests and environment. Missing logs are a blocker; do not infer root cause from red status. Do not fix source or publish.

Use the supplied stage schema. Read handoff evidence and maintainer feedback before repeating investigation. Preserve source references and describe coverage. Never publish, commit, push or merge.
