# Third-party resources

| Resource | Version | License | Usage |
|---|---|---|---|
| DeepSeek Harness | 0.1.7-alpha.1 | MIT, Copyright (c) 2026 DeepSeek | Native host, Standard Agent preset, coding tools, model adapters, sessions, permission system; API usage patterns referenced in docs/RESEARCH.md |
| DeepSeek Cordis | 4.0.3 | MIT | Native plugin lifecycle and dependency injection |
| React / React DOM | 18.3.1 | MIT | UI, native build reuses host React |
| Lucide React | 0.468.0 | ISC | UI icons |
| Zod | 3.25.76 | MIT | Request and model output validation |
| React Scheduler | 0.23.2 | MIT | React DOM scheduling in standalone preview |
| esbuild | 0.25.12 | MIT | Development/build only |
| TypeScript | 5.9.3 | Apache-2.0 | Development/type checking only |
| tsx | 4.23.15 | MIT | Development/test execution only |
| Playwright | 1.63.0 | Apache-2.0 | Browser-test tooling; browser UI checks may be separately blocked |

No proprietary GitHub Copilot or closed-source Codex material is copied into this repository. Open-source Codex and OpenAI Skills workflow adaptations are listed below. Each npm distribution retains its upstream license. Native client factory and slot-registration patterns follow the official MIT-licensed implementation, with its notice reproduced below.

## DeepSeek Harness notice

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


## OpenAI workflow adaptations (Apache-2.0)

The workflow text in `skills/maintainer-*/SKILL.md` is adapted and expanded for this project. Changes: Chinese structured output, task-specific read/write scope, pinned-revision repository context, causal duplicate criteria, before/after regression evidence, metadata-only limitations and review-before-publication. These adapted workflow files are distributed under Apache-2.0; the rest of the project's original code remains MIT.

| Source | Pinned revision / path | Use |
|---|---|---|
| [OpenAI Codex review rubric](https://github.com/openai/codex/blob/94174e44cbc54cece45f6052328ca0c2cd7a8a2a/codex-rs/prompts/templates/review/rubric.md) | `94174e44cbc54cece45f6052328ca0c2cd7a8a2a` | Actionable introduced regressions, precise changed locations, proportional severity, no speculative/style-only findings |
| [OpenAI gh-fix-ci](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/gh-fix-ci/SKILL.md) | `49f948faa9258a0c61caceaf225e179651397431` | Inspect failure evidence, distinguish missing/external logs, plan minimal changes, recheck |
| [OpenAI gh-address-comments](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/gh-address-comments/SKILL.md) | `49f948faa9258a0c61caceaf225e179651397431` | Understand and enumerate discussion before acting; identify resolved/stale comments |

OpenAI Codex — Copyright 2025 OpenAI. Unmodified upstream license and NOTICE files are included in `third_party/openai/`. Separate licenses accompanying each referenced skill are retained there as well. The original upstream review JSON schema is replaced with this application's schema; upstream commands that request elevated tool access are not copied into the execution policy. Agent access remains governed by Harness.

Only workflow text is adapted; the referenced Python helper scripts are not bundled. CI log fetching, threaded review publication and live CI rerun are not implied by these prompts and remain separate capabilities. Actual model-quality improvement requires a controlled benchmark.


## Bundled runtime notices and evaluation boundary (2026-10-02)

The unmodified React, React DOM, Scheduler, Lucide and Zod license texts are now retained in `third_party/runtime/`. The accompanying manifest records exact installed versions, upstream sources, use, retained-notice paths and SHA-256 hashes. The `third_party` directory is included in the distributed tarball. This supplements the minified bundle headers, which refer to their upstream LICENSE files. Dependency changes require updating and rechecking this inventory; transitive resolution remains in package-lock.json.

The deterministic evaluation corpus is newly authored for this project with generative-AI assistance, not copied from third-party issue data. It has no real model inference or paid API usage. AI-assisted implementation and review should be disclosed in competition materials together with the team's own review, changes and validation. Team identity, eligibility, ownership approvals and final submission declarations are not supplied by these technical records.

A configured real DeepSeek or other model API and GitHub are external services, not parts relicensed by this repository. Their actual provider/model/version, applicable terms and usage must be added to the final competition resource list once the team selects and authorizes the real demonstration setup.
