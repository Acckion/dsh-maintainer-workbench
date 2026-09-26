---
name: maintainer-investigate
description: Investigate bug reports and identify reproducible causes.
---

# maintainer-investigate

Adapted workflow, version 2. See ../../THIRD_PARTY_NOTICES.md for upstream sources and Apache-2.0 notices.

1. Establish the checked-out revision, affected version and environment. Read relevant project instructions and CI/build manifests to identify the actual test commands; never assume a JavaScript or Python project.
2. Read the failing path, callers, invariants and focused tests. List competing explanations internally, then seek evidence that distinguishes them. A stack trace is a clue, not proof of cause.
3. Use the dedicated experimental worktree. Temporary reproduction tests and build artifacts are permitted under host policy; do not change the maintained branch. Ask through the host approval mechanism when required. Experiments are evidence, not publishable implementation; distinguish expected and actual results. Do not silently change permissions.
4. Record concrete path:line evidence, minimal trigger, expected versus observed behavior, environment limitations and which hypothesis remains unverified. Distinguish pre-existing failures from the reported regression.
5. If CI evidence is supplied, name the failed check, commit, job URL and relevant log excerpt. A failed status alone does not establish root cause. Treat inaccessible/external logs as missing evidence and do not fabricate them.
6. Return the smallest next experiment or fix boundary, not a broad rewrite. Do not commit, push or publish. Return investigation facts, hypotheses, reproduction, root-cause uncertainty, proposed changes, acceptance criteria and blockers using the supplied schema.
