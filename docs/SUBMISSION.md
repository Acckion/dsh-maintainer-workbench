# 评审与复现说明

本页描述源码与可安装插件的交付范围。源版本为 `1.0.0`；最终提交号、构建版本、依赖锁及校验值由赛事包 `submission.json` 和安装包 `distribution.json` 记录，避免手写版本漂移。

## 包内有什么

- `source/`：原始源码、测试、工作流、构建与验证脚本、固定 npm 锁文件、README、贡献说明和许可文件。
- `plugin/`：同一提交构建的预编译 tgz、发布元数据与校验值。该包需要兼容的 Harness 宿主及运行依赖，不是宿主安装程序。
- `verification.json`：本次实际运行检查的摘要及范围。`SHA256SUMS` 覆盖包内文件，`submission.json` 记录来源与精简规则。

不包含本机数据库、凭据、Git 历史、依赖目录、用户仓库工作区、原始录像/配音、剪辑工程、过时试录稿或未定稿报告。原文件在制作环境保留。正式技术报告 PDF 与完整演示 MP4 是赛事单独要求的材料，应另外提交，不把本源码 ZIP 当成全部材料已提交。

## 最短复现路径

1. 解压赛事 ZIP，进入 `source/`，确认 Node.js 24+ 与 Git 可用。
2. 执行 `npm ci --ignore-scripts`，再运行 `npm run check`。安装依赖需要网络，构建无需模型密钥。
3. 运行 `npm run harness:isolated`，按 README 配置自己的模型与 GitHub 权限。真实模型调用可能收费，自动测试不会调用收费模型。
4. 也可以直接在已有 Harness 的插件安装界面选 `plugin/dsh-maintainer-workbench.tgz`。不要把 `.zip` 当成插件安装文件。
5. 检查“维护工作台”的 Issues、Pull Requests、Repository 和 Tasks；选择自己的测试仓库。真实发布是独立操作，检查通过不会自行发布或合并。

源码快照没有 `.git`。打包工具、按历史提交的对照评估和 master 版本生成依赖完整 Git 克隆；如需重建发行流程，请克隆 README 中的源码地址并切到 `submission.json` 的提交。

## 实现复核入口

| 设计 | 源码 | 主要回归检查 |
| --- | --- | --- |
| 维护事项、状态、历史与阶段编排 | `src/domain/`、`src/workflow/`、`src/application/orchestration.ts` | `tests/orchestration.test.ts`、`tests/workflow-events.test.ts` |
| 工具证据关联、报告恢复 | `src/core/execution-evidence.ts`、`src/execution/` | `tests/review-evidence.test.ts`、`tests/report-evidence-recovery.test.ts` |
| 固定版本工作区和补丁交接 | `src/infrastructure/git/` | `tests/dirty-workspace.test.ts`、`tests/binary-handoff.test.ts` |
| 评论、修复交付与远端跟踪 | `src/application/publication.ts`、`src/application/tracking.ts` | `tests/delivery-flow.test.ts`、`tests/publication-freshness.test.ts`、`tests/reporter-inquiry.test.ts` |
| 工作台与阶段界面 | `src/client/`、`src/plugin/` | `scripts/browser-*-fixture.mjs`；按场景独立运行 |
| 第三方许可留存 | `third_party/`、`THIRD_PARTY_NOTICES.md` | `tests/runtime-notices.test.ts`、`scripts/verify-distribution.mjs` |

测试名以本包实际文件为准。工程测试和本地 Git/API 夹具验证契约；脚本模型、模拟 GitHub 和浏览器夹具不能用来声称真实模型成功率。

## 已有远端案例与边界

案例仓库 [LovelyFlash/dsh-acceptance-suite](https://github.com/LovelyFlash/dsh-acceptance-suite) 是用户指定的自建验收仓库，预设缺陷已披露。这里仅提供核对链接，不随插件再分发该仓库代码；其根目录未提供 LICENSE，不能自动套用本项目 MIT。

- [支付通知 PR #41](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/41)：基线 `39b3f6374eac1106af186a5384c3d3d88902c718`；修复提交 `1f97c80cbb469efef2eb604eb12167f2f3e395ed`。同一订单重复通知导致库存多扣，修复后重复通知短路，并补回归用例。
- [修复提交的 CI](https://github.com/LovelyFlash/dsh-acceptance-suite/actions/runs/40673878716)：monorepo、Python、Rust 三个作业成功；对应上述修复提交。这不等于 PR 已合并。
- [Issue #22 的补充提问](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/22#issuecomment-6468483060)：说明缺资料时把问题交回报告者；它不是完整修复案例。

视频操作、评论回执、代码提交与 CI 应按各自实际时间解释。仅凭远端提交存在，不能认定某个特定界面按钮是该提交的唯一来源；单个受控样例也不代表跨仓库模型质量、人工节省时间或社区采纳。

## 重新生成赛事包

在完整、干净的 Git 克隆中执行：

```sh
npm ci --ignore-scripts
# 先提交代码与文档，再由打包器实际检查、构建和导出
python3 scripts/pack-submission.py
```

打包器不会读取 `.env` 或用户数据；只从当前 Git 提交提取允许的源码路径。检查摘要只保存测试总数、退出信息与工具版本，不夹带会话或私人路径。它验证 ZIP 结构、安装包提交绑定及许可哈希，不替代人工权利确认、真实模型端到端验收或赛事平台提交回执。

## 已知依赖告警

本次生产依赖审计报告 Zod 的高危资源耗尽告警 GHSA-mrhx-c7xc-m3w5；当前 v3 依赖范围没有兼容自动修复。详情及运行边界见 [安全说明](SECURITY.md)，不能将全部工程测试通过表述为无安全风险。
