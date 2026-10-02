# Maintainer workflow evaluation

**Deterministic contract checks, not a model-quality benchmark.**

Baseline: 853bc5a75cc2823e407d8a0a6123cabca85d3985
Candidate: 6d56648a0075966613be1c396b516639a735744f
Corpus SHA-256: c3c99650c54e8accbc859a090216a92aa87a385242876bb8bf9dfb3123085748

Workflow expectations: baseline 5/8; candidate 8/8
Native Harness integration: passed (real agent/tools, local scripted model; fix and triage only)

| Case | Baseline | Candidate |
|---|---|---|
| bug-lifecycle | PASS | PASS |
| clean-review | PASS | PASS |
| missing-context | PASS | PASS |
| mutation-retry | FAIL | PASS |
| unexecuted-test-claim | FAIL | PASS |
| binary-handoff | FAIL | PASS |
| unsupported-duplicate | PASS | PASS |
| format-recovery | PASS | PASS |

Detailed observed states, local command outputs, elapsed times and patches are in baseline.json and candidate.json. Single-run elapsed times include fixture setup and are not speed comparisons.

Real model acceptance, false-positive rate, tokens and API cost are not measured. Fixture cases and responses must not be presented as real model performance.

Paid API requests: 0. No external GitHub writes. Original fixtures are MIT-licensed; runtime/resource attribution remains in THIRD_PARTY_NOTICES.md.
