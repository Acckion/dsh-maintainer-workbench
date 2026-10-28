# 视频演示场景清单

日期：2026-10-27。已按用户要求向 [LovelyFlash/dsh-acceptance-suite](https://github.com/LovelyFlash/dsh-acceptance-suite) 新增 **16 条 Issue、6 个 PR**，并已同步到原生工作台。当前有 **26 条开放 Issue、11 个开放 PR**，另有 2 条已关闭 Issue。全部新增内容带 `[演示]` 标题与 `acceptance:VIDEO-20261027-*` 标记。

## 录制怎么用

先用 10–15 秒展示 Issues 和 Pull Requests 的列表与数量，再回到 PR #13 完成原定审查主线。新增场景用于补充收件箱、重复识别、缺信息、草稿与证据处置画面，不必把全部条目逐一操作。

新 PR 均从 [Acckion 的 Fork](https://github.com/Acckion/dsh-acceptance-suite) 提交到原仓库。原连接账户对上游无内容写入权限，因此未推送上游 main，也未合并任何 PR。原来的验收 Issue、PR 和故意缺陷保持原样。

## 新增 Issue

| 编号 | 标题 | 用途 | 状态 |
|---|---|---|---|
| [#18](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/18) | [演示] 分组大小为 NaN 时，三条记录变成了空分组 | bug | 开放 |
| [#19](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/19) | [演示] 中文标题生成的链接标识为空 | enhancement | 开放 |
| [#20](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/20) | [演示] 分组大小允许小数，应该明确输入约定 | maintenance | 开放 |
| [#21](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/21) | [演示] 中文文章保存后，生成的地址是空的（疑似重复） | duplicate | 开放 |
| [#22](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/22) | [演示] 导入文件后页面一直停着，需要协助定位 | needs-info | 开放 |
| [#23](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/23) | [演示] 给新维护者一份第一次运行测试的指南 | documentation | 开放 |
| [#24](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/24) | [演示] 十元分给三个人时，保留全部一千分 | enhancement | 开放 |
| [#25](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/25) | [演示] 金额显示统一保留两位小数 | enhancement | 开放 |
| [#26](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/26) | [演示] 分账人数为零或小数时，应明确报错 | boundary | 开放 |
| [#27](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/27) | [演示] 分账测试也要覆盖不能整除的金额 | testing | 开放 |
| [#28](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/28) | [演示] 让分账回归失败能在 CI 中被看到 | ci | 开放 |
| [#29](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/29) | [演示] clamp 示例应明确上下界和非法输入约定 | documentation | 开放 |
| [#30](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/30) | [演示] 复现记录中补上版本、命令和退出状态 | maintenance | 开放 |
| [#31](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/31) | [演示] 大列表分组的性能测试先确定测量口径 | investigation | 开放 |
| [#32](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/32) | [演示] 测试已经通过，为什么还要审查这份贡献？ | question | 开放 |
| [#33](https://github.com/LovelyFlash/dsh-acceptance-suite/issues/33) | [演示] 录制准备清单：仓库接入与固定版本复现 | closed-checklist | 已关闭：准备清单已完成 |

## 新增 PR

| PR | 内容 | 本地根测试 | 适合展示 |
|---|---|---|---|
| [#34](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/34) | [演示] feat: 十元三人分账保留全部金额并覆盖边界 | 10 通过 / 0 失败，退出 0 | 正常实现与边界验证；1000 分 → 334/333/333 |
| [#35](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/35) | [演示] fix: 分组大小非法时明确报错，避免静默丢数据 | 7 通过 / 0 失败，退出 0 | 针对实际复现缺陷的修复与回归 |
| [#36](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/36) | [演示] feat: 增加基础等额分账及测试 | 7 通过 / 0 失败，退出 0 | 现有测试通过但分账少一分；核对实际行为、覆盖和文档 |
| [#37](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/37) | [演示] test: 补充分账回归，保留失败基线供 CI 诊断 | 8 通过 / 2 失败，退出 1 | 本地预设失败基线；CI 诊断需等真实检查运行 |
| [#38](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/38) | [演示] docs: 补充第一次运行测试与结果交接指南 | 5 通过 / 0 失败，退出 0 | 文档贡献与命令来源核对 |
| [#39](https://github.com/LovelyFlash/dsh-acceptance-suite/pull/39) | [演示] draft: 按权重分账的接口与验收方案 | 5 通过 / 0 失败，退出 0 | 草稿／未就绪状态，不是已实现功能 |

## 实际验证与边界

- 六份 PR 的远端文件清单和 Git blob SHA 均与本地已验证的提交内容一致。
- 原生工作台已显示 Issues 26、Pull Requests 11。该仓库实际模型任务仍为 0；没有因为新增数据自动消耗模型额度。列表中的概括标签不作为模型执行凭据，是否运行以阶段详情和任务记录为准。
- 新 PR 的上游 CI 当前均为 `action_required`，须由上游维护者批准 Fork 工作流后才会运行；不能把本地结果称为 GitHub 结果。原主拍 PR #13 的已有检查与这些新 PR 分开记录。
- 每项都是专用验收样例，没有虚构真实用户事故、贡献者群体或项目采纳。带有预设问题的分支不能作为已验收的生产实现。

机器记录：[远端回执](../../artifacts/video-preparation/recording/acceptance-20261027/batch-demo/remote-manifest.json)、[本地检查](../../artifacts/video-preparation/recording/acceptance-20261027/batch-demo/validation.json)、[远端核对](../../artifacts/video-preparation/recording/acceptance-20261027/batch-demo/remote-verification.json)、[完成核对](../../artifacts/video-preparation/recording/acceptance-20261027/batch-demo/completion-check.json)。
