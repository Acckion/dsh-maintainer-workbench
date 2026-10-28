# 参赛证据索引

整理日期：2026-10-26。核查时 HEAD：`235e79875d35093ae0194443d3343e63b6bddec4`，插件版本：`0.4.0`，README 宿主目标：Harness `0.2.1-alpha.1` 或兼容接口的新版本。

本索引区分“存在实现”“历史工程检查”“真实工具与界面”“真实任务效果”。前一轮仅整理文档；随后有限准备见 E15。之后经用户授权实际操作原生 App、调用真实模型并保存首轮录屏，见 E16：首轮认证失败，第二轮留下 README 候选后超时，尚未完成原生完整编排。文档整理前已有 `src/client/Attention.tsx` 未提交修改；录制后核对 182 个源码文件全部保持准备时原样。当前源码、历史证据与最终交付包不能直接视为同一版本。

`artifacts/distribution.json` 的 `0.4.0` 分发元数据仍绑定提交 `5dcb20a31ec8a930d8d9cef1aa8b7a59e78680f6`，SHA-256 为 `2b05e3ffc59a3affcc42ebcaf5d531b3e21371cd4b7e7d6d1cc93cfb9b76a9b6`，与本次 HEAD 不同。这里只核对了元数据，未重打包，也未重新计算或验收包文件；不能仅按版本号认为它就是当前源码的最终包。

配套材料包括[技术报告草稿](TECHNICAL-REPORT-DRAFT.md)、[设计与演示方案](DESIGN-AND-DEMO.md)、[资源清单草稿](RESOURCE-LIST.md)、[视频脚本](VIDEO-SCRIPT.md)和[制作计划](VIDEO-PRODUCTION-PLAN.md)。文稿本身不增加测试或成效证据；随后实际完成的有限准备检查单列为 E15。定稿、最终 PDF、视频、授权和提交状态仍以实际记录、团队确认及平台回执为准。

## 如何使用证据

| 类型 | 可以回答什么 | 不能回答什么 |
| --- | --- | --- |
| 当前实现与测试入口 | 代码与设计在哪里，哪些行为可以进一步运行复核 | 文件存在不代表已通过当前版本验收 |
| 确定性工程评估 | 给定受控输入时，状态、隔离、恢复、证据和交付门槛是否符合契约 | 模型真实推理质量、维护成功率、误报率、用户效率 |
| 原生 Harness 夹具 | 真实 Agent、工具、Git、命令、权限及执行结果能否串联 | 脚本模型的通过不代表收费模型完成了同一任务 |
| 浏览器夹具 | 真实客户端、局部 API/存储下的布局、导航和操作行为 | 合成仓库、模拟 GitHub 和模型数据不是真实维护结果 |
| 真实桌面与连接操作 | 指定历史宿主上的插件加载、设置、配置或真实仓库读取 | 配置可见不等于模型可用；只读同步不等于远端写入成功 |
| 真实任务记录与回放 | 一个真实问题如何失败、被诊断或恢复 | 单一案例、事后回放和历史状态修正不能替代固定样本对照 |

历史证据应随“日期、提交或文件指纹、宿主、模型/数据来源、覆盖场景、限制”一起引用。没有新的同版本记录时，使用“曾在该环境验证”，不要使用“当前全部通过”。

## 当前能力与对应入口

以下是实现复核入口，不表示已完成对应的当前运行。实现范围以当前源码和后端检查为准；设计文档的计划部分不能单独作为完成证明。

| 能力/主张 | 实现或设计入口 | 已有检查入口与历史证据 | 适合在材料中说明的边界 |
| --- | --- | --- | --- |
| 维护者集中判断、阶段推进 | [产品定义](../product/PRODUCT-FOCUS.md)、[架构](../product/ARCHITECTURE.md)、`src/application/orchestration.ts`、`src/workflow/engine.ts` | `tests/orchestration.test.ts`、`tests/workflow-events.test.ts`；[编排记录](../product/ORCHESTRATION-IMPLEMENTATION.md) | 系统整理与推进；目标、异常和最终结果仍需维护者判断 |
| 不把失败或报告完成误写成问题解决 | `src/workflow/run-state.ts`、`src/core/workflow-state.ts` | [安装包十步试用](../product/INSTALLED-TRIAL.md)、[前后观察](../evidence/product-trial-2026-10-02/comparison.json) | 历史受控案例可展示产品行为，不能称真实模型修复率提升 |
| 同版本、同补丁的实施/验证/审查交接 | [证据门槛](../ACCEPTANCE.md)、`src/core/execution-evidence.ts` | `tests/review-evidence.test.ts`、`tests/delivery-flow.test.ts`、`tests/publication-freshness.test.ts`；[Issue 证据摘要](../evidence/issue-review-2026-10-04/summary.json) | 核查来源关联与执行记录；不能自动证明推理正确、测试充分或审查完整 |
| 固定提交的独立工作区与恢复 | `src/infrastructure/git/workspace-manager.ts`、[架构](../product/ARCHITECTURE.md) | `tests/dirty-workspace.test.ts`、`tests/binary-handoff.test.ts`；[脏工作区记录](../evidence/DIRTY-WORKSPACE-20261009.md) | 隔离 Git 修改；命令沙箱来自宿主，不是容器或多租户隔离 |
| 缺资料、环境等待、人工输入与显式继续 | [缺口与阶段门槛](../product/GAPS-AND-STAGE-GATES.md)、`src/plugin/input-tool.ts` | `tests/gaps-and-input.test.ts`、`tests/planning-input.test.ts`；[模型路由与原生暂停记录](../evidence/model-routing-2026-10-09.json) | 保存资料不等于扩大授权；未知信息不能充当已获得证据 |
| 可解释的阶段与历史导航 | [阶段设计](../product/WORKFLOW-UX.md)、`src/client/WorkflowTimeline.tsx`、`src/client/StagePanel.tsx` | `tests/timeline.test.ts`；[时间线摘要](../evidence/workflow-timeline-2026-10-09/summary.json) | 查看节点只读；执行、批准与发布有单独操作 |
| 模型设置与 Harness 原生接入 | `src/client/ModelSettings.tsx`、[README](../../README.md) | [模型路由记录](../evidence/model-routing-2026-10-09.json)、[原生设置记录](../evidence/NATIVE-SETTINGS-20261009.md) | 历史原生设置实测宿主为 `0.2.0-rc.2`；不能替代当前 `0.2.1-alpha.1` 完整流程验收 |
| GitHub 交付与后续跟踪 | `src/application/publication.ts`、`src/application/tracking.ts`、[远端跟踪说明](../product/REMOTE-PR-ACTIONS.md) | [PR/Actions 摘要](../evidence/pr-actions-2026-10-05/summary.json)、相关本地 Git/API 夹具 | 历史测试主要用模拟 GitHub，不据此声称真实账号的发布权限及远端流程已验收 |
| 开放成果、自研与上游边界 | [研发核查](../RESEARCH.md)、[第三方通知](../../THIRD_PARTY_NOTICES.md)、[分发说明](../AUTOMATED-DISTRIBUTION.md)、`skills/`、`third_party/` | 源码、工作流、分发配置和资源清单可逐项复核 | 最终模型/服务/素材、共同权利人和开放范围仍需团队确认；源码链接存在不等于评审权限已核验 |

## 已保存的原始与历史证据

| 编号 | 来源与绑定范围 | 实际验证内容 | 不应扩大为 |
| --- | --- | --- | --- |
| E01 | [原生执行记录](../evidence/native-execution.json)，Harness `0.1.7-alpha.1` | 本地 Messages 脚本模型驱动真实 Agent、沙箱工具、worktree 与回归命令，保存修复前失败、修复后通过及真实补丁 | 真实模型完成修复、当前宿主完整兼容 |
| E02 | [原生继承记录](../evidence/native-inheritance.json)，历史宿主模型继承夹具 | 分诊与修复使用宿主 Agent/模型配置；分诊自报测试按 `not_run` 保存，修复保留真实工具输出 | 提供方凭据有效、真实分诊正确率 |
| E03 | [最终八案例摘要](../evidence/evaluation-final-2026-10-02/SUMMARY.md)、[机器对照](../evidence/evaluation-final-2026-10-02/comparison.json)，2026-10-02；基线 `853bc5a`，候选 `6d56648`，宿主目标 `0.1.7-alpha.1` | 八个确定性契约案例为 5/8 → 8/8；覆盖越界验证、虚报已测、二进制交接等；另有真实 Harness fix/triage 工具夹具 | 模型成功率从 62.5% 升至 100%、八案例均经过真实模型推理、速度提升 |
| E04 | [十步试用说明](../product/INSTALLED-TRIAL.md)、[before](../evidence/product-trial-2026-10-02/before.json)、[after](../evidence/product-trial-2026-10-02/after.json)、[comparison](../evidence/product-trial-2026-10-02/comparison.json)；2026-10-02，已安装旧 tarball、DSH `0.1.7-alpha.1`/Cordis `4.0.4` | 真实安装包后端、Agent/工具、本地 Git、命令和存储；GitHub 元数据与模型回复为脚本。暴露并修复失败验证不可见、审查后找不到精确实施产物 | 前后均为 10 次 API 驱动操作，不能称减少了点击；当轮无云浏览器可视验收，也无真实模型效果或外部写入 |
| E05 | [统一审阅摘要](../evidence/unified-review-2026-10-02/summary.json)、[安装试用原始记录](../evidence/unified-review-2026-10-02/installed-trial.json)；代码 `b73c780`、旧宿主 `0.1.7-alpha.1` | 同补丁验证来源、实施限制及审阅投影；已安装后端十步试用与组件检查；文件明确记录 `visualUIVerified: false` | 当前页面已获真人可用性验证、当前版本全部覆盖 |
| E06 | [旧安装 peer 核查](../evidence/install-peer-2026-10-02.json)、[0.2 兼容试验](../evidence/harness-0.2-compatibility-2026-10-02.json) | 指定旧安装环境的依赖共享与隔离兼容试验 | 将旧 peer/加载成功当成当前包生命周期与 UI 全部通过 |
| E07 | [Issue 审阅摘要](../evidence/issue-review-2026-10-04/summary.json)及同目录截图；2026-10-04，基线 `d8c527d`，附源码指纹 | 真实客户端、API、SQLite；1440px/390px 浏览器维护/导航夹具；真实 Harness Bash 及脚本模型验证退出码、执行 ID 和补丁关联 | 真实讨论权限、真实模型审查质量或真实 GitHub 写入 |
| E08 | [PR/Actions 摘要](../evidence/pr-actions-2026-10-05/summary.json)及同目录截图；2026-10-05，基线 `016c300`，附源码指纹 | 真实客户端/API/存储和原生 Bash；模拟 GitHub 下的 PR/CI/Actions 与日志展示，独立验证绑定 | 真实账号权限、真实 Actions 日志读取覆盖、模型 CI 归因准确率 |
| E09 | [时间线摘要](../evidence/workflow-timeline-2026-10-09/summary.json)及同目录截图；2026-10-09，基线 `2ba01e3`，多次界面修订分别附指纹 | 桌面 1440px/手机 390px，阶段、历史、输入恢复、主题及导航竞态；真实客户端/本地 API/SQLite，合成审查资料 | 截图中真实 PR 标题对应任务已被实际执行；新一轮原生或真实模型端到端通过 |
| E10 | [阶段操作布局记录](../evidence/workflow-stage-ux-2026-10-09/README.md)，合入 `2dad9e1`；[阶段内容记录](../evidence/workflow-progress-2026-10-09/README.md)，合入 `525260a` | 独立后续浏览器夹具及截图：按钮位置、历史只读、状态/执行详情、输入继续与手机布局 | 与 E09 汇总成一次更大测试；合成截图不能当真实 PR 审查结论 |
| E11 | [原生设置记录](../evidence/NATIVE-SETTINGS-20261009.md)；2026-10-09，Harness `0.2.0-rc.2`、插件 `0.3.9` | 原生插槽浏览器夹具；用户 Mac 实际打开设置、保存未变配置、重开并核对值。记录安装产物与当轮构建哈希一致 | 真实模型调用、当前 `0.4.0`/新宿主全部验收；真实截图在本机忽略目录，不在该仓库 |
| E12 | [脏工作区记录](../evidence/DIRTY-WORKSPACE-20261009.md)；2026-10-09，Harness `0.2.0-rc.2` | 合成 Git 场景的隔离执行/恢复、真实 UI→API→工作区链路；Mac 上只读检查真实按钮可用 | 已启动真实模型任务、已修改真实用户仓库或已向 GitHub 发布 |
| E13 | [模型路由记录](../evidence/model-routing-2026-10-09.json)；插件 `0.4.0`，桌面实测宿主 `0.2.0-rc.2` | 8 阶段模型优先级、10 次本地协议请求、原生暂停/显式继续、独立工作区、浏览器设置与真实桌面菜单 | 模型名称出现在请求或菜单中即代表调用了该真实模型；记录明确为本地脚本提供方，收费调用为 0 |
| E14 | [克隆恢复记录](../evidence/CLONE-RECOVERY-20261009.md)；2026-10-09，插件 `0.3.8`，固定 OpenClaw 提交 `77cecb5449650c8efd3c261fecb4be08f82e7eed` | Mac 上完成真实公开仓库浅克隆、固定提交获取和 worktree 创建，读取 52,596 个跟踪路径；另有隔离/恢复工程检查 | 两次不同传输耗时不构成协议性能对照；真实仓库准备成功不等于真实模型任务或远端写入已通过 |
| E15 | [视频准备包](../../artifacts/video-preparation/README.md)，2026-10-26；当前 HEAD `235e798` 加既存用户改动；自建案例基线 `1429dbfdfb0ebb0c4e4b18d6438460ae267081c3`。原始记录：[基线](../../artifacts/video-preparation/checks/baseline-check.json)、[临时构建](../../artifacts/video-preparation/checks/isolated-build.json)、[组件彩排](../../artifacts/video-preparation/checks/ui/run-20261026-WMgQjr/check.json)、[图卡渲染](../../artifacts/video-preparation/graphics/render-check-20261026-7E2jBP/check.json)、[录制登记](../../artifacts/video-preparation/recording/manifest.json) | 自建分账基线实际输出 999/1000 分；六项测试三通过、三预期失败，退出码 1；当前源码临时副本构建成功，不覆盖产品 `dist`。补齐验证/环境等待 × 1440/390 的四项合成组件彩排通过，三张说明图卡渲染并留查看记录；隔离启动环境与脚本已准备但未启动 | 基线失败不是 AI 修复后通过；临时构建不是产品全量检查、安装包或原生完整流程验收。彩排采用合成数据与动作替身，图卡仅解释缺陷与目标，均不是分账任务的真实模型结果。尚无实际修复、人工接受、补丁导出、录像、成片、最终包或公开/提交证明 |
| E16 | [原生试录状态](NATIVE-RECORDING-STATUS.md)，2026-10-26；用户已安装 App 插件 `0.4.0-local.budget-20261020`，自建 README 任务基线 `9125883`；[原始录屏检查](../../artifacts/video-preparation/recording/native/raw-first-take-check.json)、[真实模型尝试](../../artifacts/video-preparation/recording/native/run-evidence-retry-20261026.json)、[候选文档独立核对](../../artifacts/video-preparation/recording/native/delivery/acceptance.json)、[补丁应用核对](../../artifacts/video-preparation/recording/native/delivery/package-check.json)、[三分钟试录回看及检查](../../artifacts/video-preparation/recording/review-cut/README.md) | 原生 App 完成目标、范围与计划确认，首轮 MiMo 请求因 401 失败并留下连续录像。用户换为 DeepSeek V4 Pro 后重试，仅修改 README，180 秒超时，保留候选。另行本地核对 README 与实际 9.99 元、3 通过/3 失败的基线一致，代码测试哈希不变；本地导出补丁可应用回原基线 | 不是算法修复，不是原生完整编排通过；没有独立模型验证/审查或第二轮执行期录像。本地文件导出不是 App 导出按钮记录；单个自建样例不能代表修复率或效率。费用为已持久化 usage 的保守估算，不是完整账单；正式参赛成片及外部提交仍未验收 |
| E17 | [2026-10-27 远端验收仓库准备](../../artifacts/video-preparation/recording/acceptance-20261027/preparation.json)、[固定 PR 与 GitHub 检查](../../artifacts/video-preparation/recording/acceptance-20261027/remote-snapshot.json)、[原生保存设置](../../artifacts/video-preparation/recording/acceptance-20261027/repository-policy-check.json) | 已接入 LovelyFlash/dsh-acceptance-suite，打开 PR #13；固定 head 7088f91 现有 5 项测试通过，但实际平均值 10、20 算成 30，独立复现已保存；只读审查录制指引已重写 | 准备核对不是模型执行；本轮尚无模型任务、录像、处置或导出。预设问题在 PR 正文中说明，不是盲测；其他仓库队列与锁屏需按实际状态处理 |

同一天可能保存了不同候选提交和独立回归轮次。例如 `evaluation-2026-10-02/`、`evaluation-final-2026-10-02/`、`unified-review-2026-10-02/evaluation/` 分别保留自己的机器报告；引用时应选定一个明确版本，不拼接为同一次运行。上表优先使用有提交标识的 `evaluation-final`，其余保留作历史溯源。

E15 的案例、组件彩排与图卡不能剪成同一次模型执行。E16 后按用户要求改用已打开的日用原生 App，只有案例仓库独立；不能把早期[隔离环境登记](../../artifacts/video-preparation/recording/environment.json)当成实际录制配置。两轮模型尝试、首轮录像、第二轮结果回看及另行本地核对分别标明来源。准备目录在项目忽略的 `artifacts/` 下，不会自动进入 Git 提交或插件分发；保留及对外提供前需核对临时路径、脱敏、许可与访问范围。

## 后续工程记录与真实试用线索

[验证记录](../VALIDATION.md)持续追加了阶段导航、模型选择、输入缺口、协议错误恢复、筛选等后续检查，也保留真实 Session 输出回放和实际失败的诊断。应按具体日期和小节引用，而不是把文件中最大的测试数当作当前统一验收结果。

- 2026-10-19 的 Issue/PR 分类与组合筛选小节记录了测试与浏览器夹具；浏览器仍使用合成资料，且当时因本机存在执行中的任务，没有热替换后端。该记录不是当前最终包运行证明。
- 真实公开/私有仓库连接记录说明读取和克隆可在历史环境成功，不证明评论、标签、草稿 PR 或原 PR 更新已在真实 GitHub 账号完成。
- 真实 Issue/PR 的报告格式、重复调用、证据关联等失败回放，见验证记录及[编排实施记录](../product/ORCHESTRATION-IMPLEMENTATION.md)。这些是产品调试与案例证据；部分原始记录仅在本机，提交前须明确可提供的脱敏证据范围。
- [通用验收方案](../ACCEPTANCE.md)已写明真实模型的任务与指标；[评估说明](../EVALUATION.md)已区分确定性评估与真实模型验收。方案存在不代表实验已执行。

2026-10-02 的“当轮没有云浏览器可视验收”仍是准确的历史边界。后续已有浏览器夹具和真实桌面设置操作，因此不能据此写成整个项目始终没有界面验收；也不能反过来用后续局部证据补写旧轮次或当前版本为全部通过。

## 六项评分应引用什么

| 评分项 | 可用已有材料 | 仍需补齐或确认 |
| --- | --- | --- |
| 问题与场景价值 15 | 产品定义、真实维护失败及中断案例 | 目标维护者的实际做法、痛点记录或反馈，说明为何值得解决 |
| 创新性与方案设计 20 | 研发核查、自主模块、E03–E05、E09–E10 | 基础 Harness 与工作台的责任/体验对照，避免只列实现名词 |
| AI 与开源融合 20 | 研发核查、工作流、第三方通知、E01–E02/E13 | 最终模型/服务来源与条款、团队人工审核及全部自主边界 |
| 实现完成度与可验证效果 25 | E01–E14 的明确历史范围及测试入口 | 最终包安装与完整流程；有限真实任务对照、失败样本、人工介入和实际费用 |
| 开放成果与复用价值 15 | 源码、插件、工作流、评估脚本、安装与分发说明 | 评审有效访问、全新安装、开放范围、权利确认和维护计划 |
| 材料规范与表达 5 | 本索引、准备状态、报告与演示依据 | 最终报告/视频/附件/链接的版本一致、匿名、格式与平台回执 |

## 当前不能填写为“已验证”的结论

1. 当前 HEAD、未提交工作树、构建产物、安装包、宿主与视频已全部一致，且完整流程验收通过。
2. 真实模型修复成功率、审查误报率、采纳率、Token/实际费用、人工操作次数或节省时间已有足够样本。
3. 工作台的模型能力优于 Copilot、Codex 或基础 Harness，或某次单样本耗时代表性能领先。
4. 真实 GitHub 评论、标签、创建草稿 PR、更新原 PR 及远端 CI/作者修订回流已完成最终版本的完整验收。
5. 团队资格、报名缴费、共同权利人授权、最终材料提交、成果访问与公开计划已经确认。

补证时先保存一个明确的版本与样本范围，再记录实际观察及失败。真实任务对照至少保持模型、推理设置、输入和提交一致，由团队独立审阅结果；不能让同一模型自行作最终成效评判。新增证据应列出可支持的主张和未测范围，再更新本索引与[准备状态](../product/COMPETITION-READINESS.md)。
