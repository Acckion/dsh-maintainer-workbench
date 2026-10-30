# 开源维护智能工作台 · Maintainer Workbench

基于开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 AI 维护工作台，面向个人和小团队的开源维护者。

社区问题、代码贡献和仓库文档在这里统一处理。AI 调查、修复和验证，维护者查看进度、改动与依据，再决定是否发布。确认后的回复和补丁回到原 Issue 与 PR，供社区核对、复用和继续改进。

本项目开放插件源码、阶段工作流、测试与打包工具。Harness 提供 Agent、模型、工具、会话和权限能力；本项目实现维护事项组织、阶段编排、证据关联、恢复、交付及界面。我们不训练基础模型，也不将宿主能力作为团队原创。

- [源码与问题反馈](https://github.com/Acckion/dsh-maintainer-workbench)
- [下载安装包](https://github.com/Acckion/dsh-maintainer-workbench/releases/tag/v1.0.0)
- [评审、复现与当前边界](docs/SUBMISSION.md)
- [资源与 AI 辅助使用说明](docs/RESOURCE-INVENTORY.md)
- [参与贡献](CONTRIBUTING.md) · [第三方许可与来源](THIRD_PARTY_NOTICES.md)

## 安装与启动

推荐使用 **DeepSeek Harness 0.2.1-RC3（`0.2.1-rc.3`）**，这是本项目最终演示使用的宿主版本。

| 系统 | 处理器 | RC3 安装包 | 来源 |
| --- | --- | --- | --- |
| Windows | x64（Intel / AMD 64 位） | [下载 EXE](https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.3-win-x64.exe) | DeepSeek 官方 |
| macOS | ARM64（Apple M 系列芯片） | [下载 DMG](https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.1-rc.3-mac-arm64.dmg) | DeepSeek 官方 |

### 直接安装（推荐）

1. 从上表选择适合系统和处理器的安装包，安装并打开 Harness。已有 Harness 可跳过这一步。
2. 在左侧选择 **插件 → 添加插件**，将下面的安装包地址粘贴到输入框：

   ```text
   https://github.com/Acckion/dsh-maintainer-workbench/releases/download/v1.0.0/dsh-maintainer-workbench.tgz
   ```

3. 确认插件来源后点击 **安装**，完成后启用插件；如提示重新加载，按提示操作。
4. 在左侧打开 **维护工作台**，按下方“第一次使用”配置模型并接入仓库。

这条安装路径无需克隆源码或执行构建命令。也可以从 [Release 页面](https://github.com/Acckion/dsh-maintainer-workbench/releases/tag/v1.0.0) 下载 `.tgz` 文件，在“添加插件”的同一输入框中填写该文件的本机绝对路径。

### 开发者从源码运行

准备好 **Node.js 24+ 和 Git**，在终端依次执行：

```sh
git clone https://github.com/Acckion/dsh-maintainer-workbench.git
cd dsh-maintainer-workbench
npm ci --ignore-scripts
npm run build
npm run harness
```

保持终端运行，打开终端打印的本地认证链接，在 Harness 左侧进入 **维护工作台**。首次使用仍需配置模型并接入仓库。

修改源码后，停止开发进程，再执行 `npm run build` 和 `npm run harness`。开发依赖版本见[资源说明](docs/RESOURCE-INVENTORY.md)。

## 第一次使用

1. **配置模型与连接。** 在 Harness 设置中配置模型，再到“设置 → 维护工作台”选择默认模型。阶段设置优先于插件默认，最后继承 Harness 默认。输出 Token 上限、并发与超时可调整；已启动任务保留启动时配置，修改后需明确重试。GitHub Token 在服务端保存，不写入导出结果。
2. **接入仓库。** 选择已有工作区或输入 `owner/repository`。公开仓库可匿名读取；私有读取、评论和推送需要对应权限。代码阶段自动准备固定提交的专用 worktree；不会把分诊当成已经审查源码。
3. **处理事项。** 点击阶段节点查看结果或历史；点击“开始”类操作才会派发任务。页面把当前结果、待决定事项和实际执行记录分开显示。
4. **核对与交付。** 阅读报告、源码位置、命令输出及真实差异，再接受结果。点击“发布回复”即提交当前回复，不再反复弹出内容确认；服务端仍检查权限、输入版本和重复发布。修改代码则使用“更新原 PR”或创建新 PR，工作台不自动合并。

## 主要流程

| 入口 | 处理方式 | 需要维护者判断的地方 |
| --- | --- | --- |
| Issue | 分诊；资料清楚时定位与范围 → 修复 → 验证 → 补丁审查 → 交付；已有关联 PR 或缺资料时进入相应分支 | 是否实施、目标与授权范围、最终结果；缺少报告者资料时向原 Issue 提问并记录回执，等待回复 |
| PR | 预检 → 变更审查 → 发布结论与选择处理方式 → 可选 Agent 修订 → 验证 → 维护者确认与交付 | 接受哪些发现、是否让 Agent 修复、是否发布；对已绑定当前补丁且证据合格的验证结果，不强制再跑一轮相同审查 |
| Repository | 检查 README、Agent 指引、CI 等文件，保存问题与来源；确认范围后实施、验证和审查 | 修改路径、依赖准备、验收条件及最终交付；CI 配置存在不代表远端 CI 已运行 |

以上是按事实与门槛分支的流程，不要求每个 Issue 都机械走完所有节点。只完成分诊或发出补充问题，不能标为已完成修复。

“交付与跟踪”保留已发布评论和后续修改的历史；新的代码或有效输入变化使旧结果过期，本插件自己确认的评论不应被误判为代码变化。报告整理失败时保留原会话、工具记录、补丁和工作区，优先复用这些内容恢复，而非重跑整轮任务。

## 验证与复现

```sh
npm run check                 # 类型检查、行为测试、本地 Git 流程与构建
npm run test:native           # 本地脚本模型 + 真实 Harness 工具链
npm run test:browser:settings # 浏览器设置夹具；需 Playwright Chromium
DISTRIBUTION_CHANNEL=release npm run package:distribution # 构建正式 tgz
```

`npm run check` 不调用收费模型，不向真实 GitHub 发布。测试夹具的通过率衡量工程契约，不能当成真实模型修复率。历史对照评估脚本 `npm run evaluate` 需要完整 Git 历史中的基线提交；赛事源码快照不含 `.git`，运行该项前应从上方地址克隆仓库。其他检查不需要历史基线。

赛事源码与安装包可在验证、提交代码后通过 `python3 scripts/pack-submission.py` 重新检查、构建和整理；额外需要 Python 3 标准库和 Git、tar。脚本拒绝未提交的跟踪文件，只打包明确允许的目录，并检查文件哈希与第三方许可文本。详见[复现说明](docs/SUBMISSION.md)。

## 权限、数据与能力边界

- 公开资料读取不要求令牌属于仓库所有者。评论需对应 Issues / Pull requests 写权限，更新代码需 Contents 写权限及可写目标分支；组织可能要求批准或 SSO。无权读取分支保护时显示未知，未配置保护也不等于检查失败。不要仅为演示提供全权限密钥。
- 模型可能错误、遗漏或受输出限制；报告声明“已执行”必须能关联实际工具记录。测试全绿不代表无缺陷；未运行检查、未知 CI 与失败结果分别保留。
- 维护数据在本机持久化；Git worktree 隔离代码改动，命令权限由 Harness 管理，不是容器或多租户隔离。模型服务会接收任务相关内容，应按仓库授权选择可发送范围。
- 自动化默认关闭；开启后依赖本地进程存活。它不提供云端常驻服务、自动合并或精确金额封顶保证。
- 现有真实演示是自建受控案例，不是社区真实事故或随机样本。PR #41 的修复已提交到远端并有 CI 结果；这不证明模型普遍正确、社区采纳或上游合并。详细版本与证据链接见复现说明。

已知生产依赖告警：Zod 资源耗尽风险及当前运行边界见 [安全说明](docs/SECURITY.md)。工程检查通过不代表无漏洞。

## 许可证与开放协作

原创代码使用 [MIT](LICENSE)。`skills/maintainer-*/SKILL.md` 中改编自 OpenAI Codex / Skills 的工作流文本按 Apache-2.0 保留适用许可、来源、通知及修改说明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `third_party/openai/`。第三方库保留各自许可，不能统称整个包只有 MIT。

欢迎通过 Issue 报告可复现问题、补充失败样本、改进文档或提交 PR。基础 Harness 的问题应尽量在确认来源后向上游反馈；工作台特有的问题留在本仓库。复用时请保留来源与许可，不把模型、GitHub 服务或第三方演示仓库当然纳入本项目 MIT 授权。
