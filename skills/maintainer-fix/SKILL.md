---
name: maintainer-fix
description: Reproduce, minimally fix and verify a repository defect in an isolated worktree.
---

# maintainer-fix

Adapted workflow, version 2. See ../../THIRD_PARTY_NOTICES.md for upstream sources and Apache-2.0 notices.

1. Consume the handoff, accepted review findings and maintainer scope/acceptance criteria first. Resolve conflicting product requirements by reporting a blocker, not inventing scope. Read relevant AGENTS/project guidance, build manifests and the actual CI workflow. Identify the affected implementation, callers, environment and tests before editing. Inspect the current worktree and preserve changes not created by this task.
2. For a new feature, implement the accepted behavior and acceptance tests; an old failing bug baseline is not mandatory. For a bug, reproduce the reported failure at the recorded base revision. Add a focused regression test where practical, run it BEFORE changing the implementation, and preserve the actual command, exit status and relevant failure output. If the failure cannot be reproduced, explain the blocker instead of inventing a red baseline.
3. Implement the smallest change addressing the evidenced cause, following local conventions. Avoid unrelated refactors, formatting churn, dependency upgrades or production-data access. Do not install software or access a live account outside the host's approved policy.
4. Run the same regression AFTER the fix, then the affected existing tests and relevant lint/build checks. Discover platform-specific commands from the repository; when required tools or environment are absent, mark those checks not_run with the precise limitation. Never present a successful build as a passed test suite.
5. Self-review the final diff: check callers, edge cases, error paths, accidental generated files and whether the test would fail against the original implementation. Record the before/after evidence separately; a failing baseline is expected, a failing final regression is not success.
6. Leave changes uncommitted for human review. Never commit, push, publish comments, modify remote issues or create/merge PRs. Return changed-file evidence, actual test outputs and remaining risks. Read-only credentials must not appear in outputs.

7. If a source patch is already applied, iterate on that change rather than starting over. Address accepted findings individually, explain unresolved ones, and record which acceptance criteria remain unmet. Use the fix stage schema, not a triage report.
