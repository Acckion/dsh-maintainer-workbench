# Maintainer Workbench

面向开源维护者的 DeepSeek Harness 原生插件。把仓库收件箱、批量分诊、代码调查、修复与文档维护、PR 审查、任务队列、证据审核和 GitHub 发布放在一个工作台里。

## 启动

要求 Node.js 24+、Git。模型执行使用固定版本的 Harness `0.1.7-alpha.1`。

```sh
npm ci
npm run build
npm run harness
```

打开终端打印的本地认证链接，跳过首次引导或配置模型，在 Harness 左侧点击 **维护工作台**。默认端口 4318。开发启动器默认沿用 `DSH_HOME` 或正常用户 Harness 配置目录，维护数据保存在 `.data/native/`；不会再将插件密钥覆盖到宿主环境。`HARNESS_PROFILE` 可选择已有 profile。需要隔离开发环境时显式运行 `npm run harness:isolated`，使用 `.harness-local/`；为避免大量文件监听，开发启动器关闭宿主 HMR，修改后重新构建并重启。

只体验界面和队列：

```sh
npm start
# http://127.0.0.1:4317
```

独立预览使用 `.data/`，与原生运行的数据隔离。首次启动为空工作区，连接仓库后支持真实 GitHub 资料的分诊、调查与 PR 分析；代码修改必须在原生 Harness 中运行。`npm run dev` 只监视服务端代码，前端修改后运行 `npm run build`。

## 从零完成一次真实维护

1. **配置模型**：只在 Harness 的「设置 → 模型」配置一次默认模型、提供方和凭据。本插件每次真实任务开始读取宿主默认模型与推理设置；原生界面不重复提供 API Key、端点和模型输入。单个聊天的临时模型选择不等于全局默认。独立预览保留自己的兼容 API 配置。
2. **接入仓库**：输入 `owner/repository`。公开仓库可以匿名读取；私有仓库、写入和更高读取限额需要在“设置与连接”填写 GitHub Token。细粒度令牌的读取需要 Metadata/Issues/Pull requests，发布还需要相应写权限，代码推送需要 Contents write。
3. **准备仓库**：分诊可以直接使用远程仓库资料；调查、审查、修复与文档任务自动克隆到插件管理的目录，并在固定提交创建专用 worktree，无需用户配置路径。也可在设置中点击「自动准备仓库」，或绑定已有 clone。自动准备不安装依赖、不执行仓库脚本。私有仓库仍需 GitHub 凭据。已有用户克隆需要包含同步时提交，缺失时会提示 fetch。
4. **批量派发**：勾选 Issue/PR，执行智能分诊、调查、修复、文档维护或 PR 审查。选中 Issue 时不能使用 PR 专属审查。默认每批 20 个、并发 2 个，可在设置修改。
5. **处理宿主审批**：实际命令遵循 Harness 的权限 preset。调查/审查使用 `read-only`；修复/文档任务默认继承宿主权限预设。需要审批时在对应 Harness 会话中处理。任务详情可点击「打开 Harness 会话 / 审批」，直接进入对应原生会话。
6. **审核结果**：查看结论、模型置信度、缺失信息、重复候选、工具结果、测试记录、真实 diff 和输入版本。测试列表是 Agent 的报告，实际执行输出保存在工具证据与 Harness Session 中；二者应一起检查。可以退回并重试、取消运行任务、导出结果 JSON 和补丁。
7. **发布**：接受结果后，点击发布回复、应用标签或创建草稿 PR。二次预览显示即将写入的内容；草稿 PR 会提交已审核差异、推送专用分支并调用 GitHub API。工作台不自动合并 PR。发布记录保存在任务中。


## 功能与实现范围

| 功能 | 实现 |
|---|---|
| Issue/PR 统一收件箱 | 搜索、类型筛选、优先级、未分诊、疑似重复、已关闭记录、批量选择 |
| 智能分诊 | 分类、优先级、置信度、缺失信息、建议标签、相关问题检索、带理由的重复建议 |
| 问题调查 | 原生模式读取代码；独立模式明确限定为远端资料分析 |
| 修复 / 文档维护 | 复用 Harness Standard preset 和原生工具，在专用 worktree 运行，返回实际差异 |
| PR 审查 | 获取 PR base/head 和变更，结合报告及代码分析，明确覆盖边界 |
| 队列 | SQLite 持久化、版本绑定、幂等派发、并发上限、超时、取消、保留历史的重试 |
| 审核 | 结果、工具证据、输入提交、真实 diff、接受/退回、差异变更和输入过期检查 |
| 交付 | JSON / patch 导出，GitHub 回复、标签、草稿 PR；发布去重与状态记录 |
| 自动化 | 可配置定时同步、对新版本问题自动分诊；默认关闭，不自动发布 |
| 图形配置 | 仓库、自动工作区、宿主模型状态、GitHub 令牌、并发与自动化 |
| 仓库理解 | 自动读取固定提交的目录、约定、README、构建配置、CI 与测试入口，展示来源与覆盖范围 |
| 任务工作流 | 分诊、调查、修复、审查、文档五类工作流；参考许可允许的 Codex / OpenAI Skills 并保留来源 |

## 安装为分发插件

```sh
npm run build
npm pack
# 在已有 Harness 环境：
dsh plugin --profile web add /absolute/path/dsh-maintainer-workbench-0.1.0.tgz
dsh web
```

也可以从宿主 Plugins 页面安装本地 tarball。包包含 host entry、原生 client factory、bundle patch；不是只有 Skill/MCP 配置。原生接口与实测版本见 [开发核查](docs/RESEARCH.md)。

## 检查与证据

```sh
npm run check          # strict TypeScript + 行为/本地 Git 流程测试 + 构建
npm run test:native    # 本地 Messages 模型夹具 + 真正的 Harness Agent / Shell 联调
```

新增 `npm run evaluate` 可对固定基线和当前源码运行八案例工作流对照，并生成 JSON/Markdown 证据；默认同时进行本地模型驱动的真实 Harness 联调。使用方式与未测边界见 [可复现评估](docs/EVALUATION.md)。这不是模型质量或修复成功率评测。

浏览器回归脚本为 `scripts/browser-smoke.mjs`；需要先启动独立预览，并安装 Playwright Chromium。已记录的证据范围见 [验证记录](docs/VALIDATION.md)。本地模型夹具验证协议和工具链，不代表真实模型的智能评测。

## 数据与限制

- 原生模型凭据由 Harness 管理。GitHub 令牌以及独立预览凭据单独保存在 `credentials.json`（权限 0600），不返回浏览器、不包含在任务导出中。环境变量也可配置：`DEEPSEEK_API_KEY`、`MAINTAINER_API_KEY`、`MAINTAINER_BASE_URL`、`GITHUB_TOKEN`。启动器不会自动读取 `.env`，如使用 `.env`，由运行环境加载。
- 每个数据目录只允许一个 worker 进程。崩溃中的任务转为失败，保留 worktree，人工决定是否重试；不会静默重放代码修改。
- worktree 隔离 Git 修改，命令执行隔离由宿主提供。不要把它当成容器或多租户安全系统。
- 当前同步上限为最近更新的 1000 个 Issue/PR，并在界面提示部分覆盖。分析最多获取前 30 条讨论、PR 前 100 个文件，GitHub 还可能截断 patch；结果需要说明范围。
- 默认不开启自动化；开启后按进程存活期间的分钟轮询执行。它不是云端常驻服务。
- 并发、超时、每次请求输出上限均可配置；暂不提供精确的总金额预算、跨仓库权限分级、自动合并、依赖升级机器人或长期向量记忆。
- 真实模型质量、真实 GitHub 写入尚需接入用户凭据验收。不能把模拟演示或本地测试的成功率当作真实维护成功率。

原创代码 MIT，改编工作流 Apache-2.0；上游使用范围与许可证见 [第三方清单](THIRD_PARTY_NOTICES.md)。


## 通用性与仓库理解

运行时代码、提示词和默认界面没有特定仓库名称或专用构建命令。Agent 从仓库自己的文件识别语言、构建与测试方式，支持混合语言和 monorepo；没有足够证据时保留未知，不强行假定 `npm test`。初始摘要不是完整语义索引：本地最多读取 12 份配置/约定摘要、远程最多 6 份，每份最多 6000 字符，所有裁剪和缺失会提示。Agent 应继续使用 Harness 工具读取任务相关实现及更细粒度的约定。摘要按提交缓存，源码未变时复用；提交变化后重建。

工作流是随插件分发、按任务自动加载的版本化 SKILL.md，不要求用户手动安装五个技能或重新写提示词。宿主默认 Agent preset 的工具/Skills 仍通过原生 preset 机制加载。只有维护工作流覆盖范围和输出格式由插件补充。

测试仓库与评估计划见 [通用验收方案](docs/ACCEPTANCE.md)。

正式运行不包含演示数据或模拟执行器。旧版本数据库在启动时自动清除 mode=demo 的仓库、关联问题、任务及演示审计；真实 GitHub 数据和连接配置保留。测试夹具只位于 tests/ 与测试脚本中，不随插件分发。

### 私有 GitHub 仓库

公开和私有仓库使用相同的“接入仓库”入口。服务端优先使用已配置的 GitHub Token / GITHUB_TOKEN，其次 GH_TOKEN；没有显式令牌时自动复用本机 GitHub CLI 登录（gh auth login）。界面会验证并显示当前账号，未安装 CLI 也可在连接窗口直接保存令牌。令牌仅保存在服务端，CLI 凭据不复制到插件配置。

细粒度令牌需选择目标仓库，并允许读取 Contents、Issues、Pull requests；发布评论、标签或 PR 才需要对应写权限。组织仓库可能还需管理员批准和 SSO 授权。API 同步、私有仓库克隆、fetch 与审核后的 push 使用统一认证来源；无权访问会显示错误，不会生成替代数据。

### 多仓库工作区

“接入仓库”支持每行一个仓库名称或 GitHub URL，每批最多 20 个；重复输入自动合并，失败逐项显示。设置页列出全部已连接仓库，可切换当前仓库或同步全部。切换会清空勾选项、详情和发布预览，并记住上次选择。收件箱、任务、审核和克隆按仓库隔离；活动记录、模型、执行策略和 GitHub 登录在工作台共享。目前不支持为各仓库配置不同 GitHub 身份。


## 阶段化维护流程

默认首页汇总跨仓库需要判断的事项。Issue 使用“快速分诊 → 调查 / 实施 → 验证 → 审查 → 发布”；PR 使用“变更预检 → 审查此版本 → 逐项处理发现 → 更新原 PR”。详情页根据产物给出下一步，其他阶段收在快捷操作中。目标、验收条件、历史证据和反馈会自动交接，无需重复输入完整提示词。

分诊与预检仅处理元数据，不创建代码工作区、不开放 shell；代码任务在固定版本的隔离工作区执行，继续继承 Harness 模型和权限。设置中可按仓库调整同步、自动分诊与预算。发布仍需预览并确认，不自动合并。

具体实现、验证与能力边界见 [工作流实现记录](docs/product/IMPLEMENTATION.md)。

### Fresh profile compatibility

The plugin accepts host Cordis `>=4.0.3 <4.1.0`; the source lockfile still tests `4.0.3`. Freshly resolved DSH `0.1.7` utility packages can require `~4.0.4`, so a fresh npm-style host should supply `4.0.4`. An isolated `0.1.7-alpha.1` host with `4.0.4` passed installed-package native workflows.

Harness profiles use `autoInstallPeers: false` and resolve Cordis from the host. A standalone `pnpm peers check` in that profile may therefore report a missing peer even when the runtime shares the host instance. Our fresh-install check explicitly linked that exact host Cordis directory and verified realpath equality, then obtained a clean peer check. This diagnostic link is not a general install script for every Harness distribution. Do not hide peer errors or install a separate private Cordis copy. Exact evidence: [installation check](docs/evidence/install-peer-2026-10-02.json).
