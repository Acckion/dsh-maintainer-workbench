---
name: maintainer-docs
description: Correct evidenced documentation drift against current code.
---

# maintainer-docs

Adapted workflow, version 1. See ../../THIRD_PARTY_NOTICES.md for upstream sources and Apache-2.0 notices.

1. Read project guidance, source/configuration declarations and the relevant docs. Build a small claim-to-source checklist for commands, arguments, defaults, paths, examples and supported behavior.
2. Identify exact contradictions, missing setup steps or broken internal references. Do not invent capabilities, supported platforms, benchmark numbers or API options. Prefer a focused correction over rewriting the whole documentation set.
3. Modify only relevant documentation or necessary example files inside this worktree. Preserve localization and the project's established style. Do not change application behavior simply to match outdated prose.
4. Validate local links and executable examples using repository-defined checks when available and permitted. For unavailable tools, remote services or platform prerequisites, record not_run and the reason. Distinguish inspected examples from executed ones.
5. Inspect the diff and return each corrected claim with its implementation evidence, actual checks and remaining inconsistencies. Never commit, push or publish from the Agent.
