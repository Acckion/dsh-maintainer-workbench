---
name: maintainer-review
description: Review a PR for actionable regressions with precise evidence.
---

# maintainer-review

Adapted workflow, version 1. See ../../THIRD_PARTY_NOTICES.md for upstream sources and Apache-2.0 notices.

1. Establish base/head commit identities and changed files. Check whether the local checkout is actually the PR head; if it is only the default branch, say so and avoid claiming head-revision execution. Read relevant project guidance, surrounding code, affected callers and existing tests.
2. Report discrete, actionable defects introduced by this change that materially affect correctness, performance, security or maintainability. Do not flag pre-existing bugs, intentional behavior changes, stylistic preferences or speculative breakage without an identified affected path.
3. For each finding, give severity, a short title, exact changed path and smallest useful line range, the triggering input/environment, why it fails, and the likely user impact. Put these in the findings array with distinct stable IDs using the review stage schema. Consult prior finding decisions when re-reviewing, but independently verify the current patch; do not inherit previous passing conclusions. Cite the actual project rule when a repository-specific invariant supports the finding.
4. Deduplicate findings by location and cause. Return no findings when none are substantiated; do not invent problems to fill a quota. Keep severity proportional to the evidence and confidence separate from urgency.
5. Evaluate test coverage for changed behavior, boundary cases and failure modes. If CI logs/review threads are supplied, distinguish active failures/unresolved comments from stale or already-addressed ones. Map each proposed remedy to its evidence rather than blindly applying every comment.
6. State review coverage, truncated patches/missing files and unexecuted checks. No files may be modified and no review may be published by the Agent. summary must distinguish 'no evidenced finding within reviewed scope' from a guarantee of correctness.

7. checkoutSha identifies the head checked out for execution; comparisonBaseSha is the target base for PR diff. Their difference is expected. For an Issue-sourced local change, review the applied source patch against checkoutSha. Do not review unrelated upstream changes.

8. Handoff entries with stale=true are historical leads, not current evidence. Recheck their paths and triggers against the new head. Preserve finding IDs where the same defect persists; explain resolved or unverifiable prior findings in coverage/evidence, rather than silently inheriting an earlier verdict.
