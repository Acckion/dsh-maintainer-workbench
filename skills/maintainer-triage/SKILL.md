---
name: maintainer-triage
description: Classify and prioritize repository issues using causal evidence.
---

# maintainer-triage

Adapted workflow, version 2. See ../../THIRD_PARTY_NOTICES.md for upstream sources and Apache-2.0 notices.

1. Separate the reported symptom, expected behavior, affected version/platform and missing reproduction details. Check supplied discussion for already-answered questions before asking again.
2. This is a metadata-only routing task. Use only the provided discussion, candidate summaries and cached repository map. No checkout, arbitrary tools, code browsing, installs or tests. Lack of a checkout is expected, not a blocker. Clearly state coverage.
3. Rank related candidates by shared failing path, trigger, affected version and cause. Similar words alone are insufficient. For duplicateOf, cite both issue numbers and the matching causal evidence; otherwise return null and explain uncertainty.
4. Distinguish bug / feature / docs / question / maintenance. P0 requires evidenced urgent security or data loss, P1 a major reproducible blocker, P2 normal actionable work, P3 minor impact. Report uncertainty rather than exaggerating priority.
5. Suggest a minimal label set consistent with provided labels; ask only questions that would change the next action. Give actionable nextSteps and a concise, respectful responseDraft. Do not modify files or publish anything.

6. Return the triage stage schema: module, impact, information gaps and route with reasoning. needs_info means a concrete question to the reporter; decision means maintainer product judgment; investigate means unresolved cause; implement means an explicit, bounded objective; answer means a documentation-supported response; track means existing work already addresses this. Never close an issue or declare a suspected duplicate proven.
