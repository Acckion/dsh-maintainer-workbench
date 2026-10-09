# Installed maintenance workflow trial

Checked 2026-10-02. The plugin was installed from its tarball into a fresh, isolated Harness web profile. The running backend used that installed host/client package, not a source override. Both built asset hashes matched the installed copies. The host was DSH `0.1.7-alpha.1`, sharing one Cordis `4.0.4` instance; `peers check` reported no issues. The source development lock remains Cordis `4.0.3`.

## What was tried

An original disposable cycling-summary repository contains deliberately incomplete code and three Node tests. It includes no code, health records, coordinates, credentials or activity data from the user's cycling application. No remote repository exists. GitHub metadata and model replies are scripted fixtures; the installed Harness Agent, native tools, local Git worktrees, test commands, persistence and authenticated product API are real.

The same ten API-driven operator actions were replayed before and after the fix, against the same demo commit `ac32738fb7e5e0af40d2b2ef459b0ec63e6f6be2`:

1. Connect the synthetic repository through sync.
2. Bind its owned local clone as trial setup.
3. Batch-classify three reports: a concrete defect, a documentation request, and an under-specified report.
4. Investigate the concrete defect with a real failing test.
5. Implement only the reported zero-duration symptom; its targeted test passes.
6. Run the full validation suite; invalid-input handling still fails.
7. Revise the implementation using that failure.
8. Repeat full validation; all three tests now pass.
9. Independently review the exact revised patch in a separate worktree.
10. Accept that review locally, without publishing anything.

The original demo checkout stayed unchanged in both runs. The deliberately partial first fix and deterministic patch helpers are part of the disclosed fixture, not evidence that a real model solved or missed a defect.

## Product findings and changes

**A failed validation disappeared into a successful-looking state.** The task's report had completed, but its test had failed. Previously the issue workflow nevertheless became `validate` with a completion label, and the attention list could omit it. Now failed or incomplete validation remains actionable. The workflow explains the failure and proposes correction or further validation. A passed report is labeled as a report, with a reminder to check actual tool evidence.

**Accepting a review stranded the maintainer on a non-publishable artifact.** The review job correctly could not publish code, but the original implementation had to be located again. The approval API now returns the exact validated implementation; the client selects it and explains the handoff. This navigation is implemented and covered through API/state/render tests, but has not been visually exercised in this cloud browser. The implementation still requires its own acceptance and an explicit publication action.

**That shortcut needs a trustworthy target.** Handoff verifies the review, validation, implementation, issue revision, exact patch, independent worktrees, local branches and HEADs, and remote base/head/target. Publication checks the binding again, including approval changes during asynchronous checks. Ordinary PR reviews also recheck their approved content before writes. A retry may recognize only its own recorded published commit; it does not accept a different target branch or stale review.

## Measured result and limits

| Observation | Before | After |
|---|---|---|
| Identical trial actions | 10 | 10 |
| Failed full-validation report | `completed`, test `failed` | Same honest report status |
| Issue action state after failure | `validate` | `blocked`, with correction reason |
| Approved review returns exact implementation | No | Yes |
| Implementation automatically approved | No | No |
| Original checkout changed | No | No |
| External writes / paid model calls | 0 / 0 | 0 / 0 |

Recorded elapsed time was 6,951 ms before and 7,440 ms after. These single-run orchestration times include local scripted-provider/tool execution and polling. They do not measure real-model latency, human clicks, thinking time, speed improvement, acceptance rate or repair quality. The eight-case deterministic evaluation is a separate workflow-contract regression corpus, not a quality benchmark.

The cloud browser rejected the localhost UI under its URL policy. No bypass or alternative publication was used. Installed backend operation and server-rendered component tests passed; real browser navigation, responsive layout and human usability remain unverified in this round.

## Reproduce from the source delivery

The portable delivery contains the plugin source, package, patches and the separate synthetic demo archive/bundle. Use only the disposable provided demo with a clean Git checkout. Its placeholder origin is `https://github.com/fixture/cycling-trial.git`; it is not a real hosted repository.

Install the tarball into an isolated web profile using the official DSH plugin CLI. For the tested npm-style host, make the profile resolve the host's **same** Cordis directory as described in the README; do not install a second Cordis copy or suppress peer checks. Then run from the plugin source with Node 24+:

```sh
node scripts/installed-workflow-trial.mjs \
  --host /absolute/host/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --installed-home /absolute/isolated/dsh \
  --repo /absolute/maintainer-trial-cycling \
  --out /absolute/fresh-output-directory
```

The output directory must be empty. Port 4325 must be available. The script starts a local Messages fixture and the installed Harness host, runs the ten actions through the authenticated API, records the results and asset hashes, and stops both processes. Host credentials are excluded from the fixture environment; fixture GitHub reads are local, and external HTTP writes are refused. Use `--expect-before` only when replaying the original pre-handoff package.

Raw synthetic observations: [before](../evidence/product-trial-2026-10-02/before.json), [after](../evidence/product-trial-2026-10-02/after.json), [comparison](../evidence/product-trial-2026-10-02/comparison.json). Absolute scratch paths are replaced with portable labels.

## Next acceptance gate

Stop expanding features until the current entry, failure and approval flow can be tried visually and a bounded real-model run can be authorized. That run should use representative real issues, an explicit provider/model and spending limit, independent human acceptance of outputs, false-positive analysis, tokens/cost, and actual maintainer steps. Any external GitHub write or repository publication needs its separately agreed target and scope.
