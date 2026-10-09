# 关联 PR 进度与 GitHub Actions 证据

实现分支：`codex/pr-progress-actions`，起点 `016c300`。验收日期：2026-10-05。

## 使用

创建 PR 后，原 Issue 的“远端交付进度”展示各关联 PR。仓库同步（包含已启用的定时同步）刷新关联状态，也可单独点击“刷新关联 PR 进度”。同时读取源 Issue 的真实 open/closed 状态；不会把 PR 合并推断为 Issue 关闭。草稿、审查要求修改、CI 失败或等待、合并冲突和其他合并状态分别展示。已合并但 Issue 仍开放、未合并就关闭的 PR 均有提示。定时同步关闭时需手动刷新，状态不是实时推送。

快照展示执行版本和最近成功读取时间。失败保留旧快照并标明错误；状态缺失或分页不完整不会显示为条件全部满足。当前每次仓库同步最多刷新 20 个关联事项，每个事项最多 10 个 PR，超过范围显示仓库覆盖警告；其余事项可单独刷新。跟踪中的事项不会因默认分支更新丢失 track 阶段或自动再次分诊。直接查看 PR 时不把 PR 自身关闭状态误当作关联 Issue 已关闭。

在关联卡片点击“读取 PR Actions”，按 PR 当前 head SHA 获取最近 20 个 workflow run，每个 run 最近 3 次 attempt，每次前 100 个 job。独立展示每次执行的结论和失败步骤，可点击读取指定 job 原始日志。刷新期间 head/base 变化拒绝保存混合版本；旧提交记录有提示。读取历史 job 先核对服务端返回的 job ID、run ID 和提交。缺少日志、权限不足、未生成或过期均显示错误，不表示成功。

日志按需读取，最多前 512 KiB，明确标注裁剪。下载只接受 HTTPS GitHub/Actions 或 Azure Blob 日志域名；签名地址不携带 GitHub 凭据，不跟随第二次跳转。不提供 rerun、merge 或关闭 Issue 的自动操作。

## CI 诊断

PR 的“诊断 CI”阶段自动记录固定 head 的 Actions 快照，读取最多 3 个失败/超时 job 的日志摘要，每条最多 16000 字符，保存精确 headSha/runId/attempt/jobId。在阶段详情可查看本次使用的证据，而不是引用之后刷新的快照。模型上下文最多 30 个 job、每个 20 个失败步骤及 3 条日志摘要，裁剪范围明确说明。

原有 classification 区分 regression、baseline、flaky、environment、unknown，界面明确这是诊断判断，并分别显示事实与假设。输入指令要求依据失败步骤和日志判断；单次失败不能证明不稳定，重跑通过不能证明修复。界面与输入限制不等同于真实模型诊断准确率评测。

第一版只覆盖精确 head SHA 的 GitHub Actions。使用 PR 合并测试提交 SHA 的 run、merge queue、其他 CI 平台可能不在本次范围；没有 job 不意味着 CI 通过。GitHub 分支保护、规则集和全部合并许可未完整实现，以 GitHub 为准。

## 接口与验收

依据官方 [PR GraphQL 字段](https://docs.github.com/en/graphql/reference/pulls)、[Actions runs](https://docs.github.com/en/rest/actions/workflow-runs)、[Actions jobs 和日志](https://docs.github.com/en/rest/actions/workflow-jobs)。沿用仓库现有 API 版本和认证方式。

`npm run check` 覆盖代码、类型、构建；`npm run test:browser:maintenance` 覆盖真实客户端、本地 API 和 SQLite 在 1440px/390px 的进度刷新、审查/冲突提示、失败步骤、指定 job 日志及已有维护流程。GitHub 响应和 Agent 是夹具，外部写入及付费调用为零。真实 GitHub 权限、日志下载及真实模型诊断效果仍需实际仓库验收。
