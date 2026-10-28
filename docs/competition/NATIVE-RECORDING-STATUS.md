# 原生 App 录制状态

日期：2026-10-26。录制经用户授权，后续按用户要求直接使用已打开的 DeepSeek Harness App。仅演示仓库是独立的自建案例，日用 App profile 不是隔离环境。产品源码未为录制修改。

## 实际演示范围

已安装工作台版本为 `0.4.0-local.budget-20261020`。本地 Repository 入口支持文档、开发指引和 CI 维护，不提供直接创建任意本地代码修复目标的入口。此次选择 README 文档维护，展示目标、范围、计划与执行记录；不能称为已完成分账算法修复。

任务范围仅 `README.md`。目标是让接手者能复现问题，清楚地区分当前 999 分与目标 1000 分，并明确算法尚未修复、原有测试仍有预设失败。基线为 `9125883ffb2e65058f51ed9e3f3660c4e9eb64c4`；相对原案例仅调整 `AGENTS.md` 的文档维护范围，源码、测试和 README 原文未改。

## 首次尝试

- 使用用户当时的默认模型 `xiaomi-token-plan-cn / mimo-v2.6-flash`。
- 任务 `9b2d2041-a440-4893-888f-94ab9e2f4c64`，编排 `fb7db4f7-0b9a-40e2-8f4b-eae157fd5b10`。
- 实际发起一次请求，返回 `401 Invalid API Key`。无模型生成结果、工具调用或补丁，不能称文档维护完成。
- 已停止并保存原生 App 连续录像：[首轮原始 MP4](../../artifacts/video-preparation/recording/native/continuous-window-20261026-194109-621.mp4)。独立核验为 347.687 秒、1920×1080、H.264、15,273,139 字节，无音轨，完整解码通过；见[媒体检查](../../artifacts/video-preparation/recording/native/raw-first-take-check.json)。原始素材时长超过比赛视频上限，不是可直接提交的成片。
- 不录系统音频或麦克风，不录整个桌面。未向 GitHub 写入，未对外提交或发布。

## 第二次尝试与独立文档核对

用户切换宿主默认模型后授权重试。新尝试 `680f730a-661c-4075-91a8-67db24ba740e` 属于同一编排，实际使用 `deepseek-official / deepseek-v4-pro`、low。每阶段 180 秒、每次输出最多 4096 tokens 的仓库设置已通过原生界面保存，并从持久化数据[另行核对](../../artifacts/video-preparation/recording/native/repository-policy-check.json)。

新模型真实读取了案例、运行复现及测试，留下仅修改 README 的候选；随后达到 180 秒上限，任务超时，原编排仍为 blocked，没有进入独立模型验证与审查。第二轮执行期间未取得录像，后期只能标为“运行记录摘要／结果回看”，不能把首轮 MiMo 录像拼成 DeepSeek 执行画面。

候选随后另行完成文档范围的独立本地核对：仅 README 改动，其他全部跟踪文件及源码、测试哈希不变；实际运行仍合计 9.99 元，测试退出码 1、3 通过及 3 失败，与文档表述一致；相对链接及差异格式检查通过。该复核不改变原 App 编排的超时结论，也不是模型验证、审查阶段的替代记录。

本地文件已另存，未调用 App 的导出按钮：

- [完整候选快照中的 README](../../artifacts/video-preparation/recording/native/delivery/candidate-repository/README.md)
- [README 补丁](../../artifacts/video-preparation/recording/native/delivery/README.patch)
- [独立文档验收与费用记录](../../artifacts/video-preparation/recording/native/delivery/acceptance.json)
- [补丁应用检查](../../artifacts/video-preparation/recording/native/delivery/package-check.json)：在原基线的临时副本应用后，README 与候选一致。

App 保留的补丁文本去掉了末尾换行，与正常导出补丁并非逐字节相同；归一末尾换行后变更内容一致。两份原始哈希和差异原因保留在验收记录，未为强行匹配而编辑候选。

## 三分钟试录回看

已导出[三分钟试录回看 MP4](../../artifacts/video-preparation/recording/review-cut/native-trial-review-180s.mp4)：180 秒、1920×1080 / 30fps、5,036,487 字节，H.264＋AAC，含中文字幕及本地离线合成配音。完整音视频解码通过，12 张关键帧及确认按钮、第二轮来源标签画面已抽样查看；[媒体检查记录](../../artifacts/video-preparation/recording/review-cut/qa/review-cut-check.json)保留实际参数与哈希。未完成全片人工听音、团队权利与正式提交验收。

片中第一轮原生录像明确标为 MiMo；第二轮使用明确标注的运行记录摘要图卡，没有伪造执行期录像。另行本地核对与文件保存也分别标明来源。视频定位为本次试录回看，不能作为完整流程成功或正式参赛成片。录制助手已关闭，目前没有录制进行中，日用 Harness 保持运行。

## 费用与限制

用户授权单次上限 10 元。首轮使用现有 TokenPlan 专用接口，未升级、充值或切换按量接口。第二轮已确认的 20 次响应记录输入 311,507 tokens（含缓存）、输出 6,864 tokens；按[官方高峰价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)且不计缓存折扣保守估算约 2.99 元。这不是账单，最后一次未完成请求缺少 usage，可能的额外计费未取得。没有继续追加模型调用。

隔离浏览器环境的预算代理没有保护原生 App，不宣称原生 App 已有“10 元硬限额”。已停止本次另建的隔离浏览器后端和预算代理，日用原生 App 未停止。

仓库自动分诊、自动预检、自动审查与同步已关闭。首次尝试的实际保存值仍为 30 分钟和 6000 输出 tokens，并非最初拟设的 180 秒和 4096；第二轮已修正并核验。产品源码 182 个文件相对准备基线[全部未变](../../artifacts/video-preparation/checks/recording-source-integrity.json)，原有 Attention.tsx 修改保留。

最新机器可读记录见[录制登记](../../artifacts/video-preparation/recording/manifest.json)。当前有经文档范围复核的候选补丁、首轮录像及三分钟试录回看，原生完整编排和正式参赛成片仍未验收。

## 2026-10-27：改用有远端的验收仓库，用户手动录制

上一版纯本地演示副本没有远端，不能把“在 Harness 中打开工作区”直接等同于能在本次维护工作台中同步 Issue/PR。按用户纠正，现已改用 [LovelyFlash/dsh-acceptance-suite](https://github.com/LovelyFlash/dsh-acceptance-suite)。该仓库 main `e0d5bf7` 的干净本地副本已导入原生 App，远端已识别并同步：11 条开放 Issue、5 个开放 PR，另有 1 条已关闭 Issue。

本次主线为 [PR #13](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/13) 的只读审查。固定 head `7088f91` 上已另行实跑根 `npm test`，5 通过、0 失败；同一版本实际 `average([10,20])` 为 30、期望为 15。复现属于独立准备，不是模型结果；PR 正文已经说明预设问题，因此本片不是未知缺陷盲测。

已为这个仓库保存并核对：自动分诊、预检、审查关闭，定时同步 0，单次时间 600 秒，输出 4096 tokens。原生 App 已选中 PR #13 的“处理流程 → 预检 · 待开始”，实际按钮为“开始预检”。本次该仓库模型任务数为 0，尚未录制、接受或导出报告。之后已按用户“取消这些任务”的明确授权，关闭 openclaw/openclaw 与 anomalyco/opencode 的自动分诊、预检和审查，核对无运行中或排队任务。停止请求处理期间，最后两项任务因原 1800-token 输出额度不足结束，仍保留失败状态。全局快速分诊/预检额度已从 1800 对齐至 4096，其他全局执行设置未改；录制交接时再核对恢复。历史和产物未删除。PR #13 Diff 已正常载入三个文件；Mac 再次锁屏，用户解锁后按新指引录制。

用户允许按演示需要修改这个验收仓库或创建 Issue/PR；当前复用已有种子，没有额外创建、评论、推送或合并。产品源码未改。新操作步骤见[手动录制指引](MANUAL-RECORDING-GUIDE.md)，分镜与结果分支见[新四分钟脚本](VIDEO-SCRIPT-ACCEPTANCE.md)，版本、原始输出和原生设置见[准备记录](../../artifacts/video-preparation/recording/acceptance-20261027/preparation.json)。

## 2026-10-27：按用户要求扩充远端演示数据

已向原验收仓库创建 16 条 Issue（#18–#33，其中 #33 准备清单已关闭）及 6 个 PR（#34–#39，#39 为草稿）。因上游只读权限，PR 通过 Acckion 的 Fork 分支提交，未推送上游 main、未合并。远端文件 blob 与本地已验证内容逐项一致。新增 PR 的 CI 均为 action_required，等待维护者批准 Fork 工作流，不冒充 CI 已通过或失败。

原生工作台已同步显示 Issues 26、Pull Requests 11，该仓库实际模型任务仍为 0。新增资料全部标为演示，真实状态与推荐镜头见[场景清单](DEMO-SCENARIO-CATALOG.md)。原主拍 PR #13 与历史试录不因新数据创建而改变结果。
