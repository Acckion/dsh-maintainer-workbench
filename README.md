# Maintainer Workbench

面向开源维护者的 DeepSeek Harness 原生插件。把仓库收件箱、批量分诊、代码调查、修复与文档维护、PR 审查、任务队列、证据审核和 GitHub 发布放在一个工作台里。

## 启动

要求 Node.js 24+、Git、Harness `0.2.1-alpha.1` 或提供兼容接口的更新版本。持久化原生提问使用 `@deepseek-ai/dsh-tools@^0.2.1-alpha.1` 的 `concludeTurn()`，旧 `0.2.0-rc.2` 客户端需要升级后使用此版本。

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

`npm start` / `npm run dev` / `npm run harness` 默认启用 `--use-system-ca`（Harness 启动器通过 `NODE_OPTIONS` 传给宿主进程），以便在安装了拦截 HTTPS 根证书（企业代理或安全工具）的机器上连接 GitHub；若改用其他方式启动 Harness（例如已安装的 Harness 桌面版）后导入仓库提示「证书验证失败」，请用 `NODE_OPTIONS=--use-system-ca` 启动，或改用错误提示中的 `NODE_EXTRA_CA_CERTS` 方案。

## 从零完成一次真实维护

1. **配置模型**：先在 Harness「设置 → 模型」配置提供方与凭据，再在「设置 → 维护工作台 → 模型」选择插件默认模型。菜单直接读取 Harness 模型目录，按提供方分组；高级设置可为分诊、预检、调查、实施、审查、文档、验证和 CI 单独选择模型与推理等级。优先级为阶段选择 → 插件默认 → Harness 默认；已启动任务保留原模型，已有结果不会自动重跑。模型被移除时明确报错，重新选择后才能运行，不自动切换提供方。单个聊天的临时模型选择不改变本插件设置。独立预览保留自己的兼容 API 配置。
2. **发现仓库**：优先自动识别 Harness 工作区及 GitHub 远端；其他远程仓库可以输入 `owner/repository` 添加。公开仓库可以匿名读取；私有仓库、写入和更高读取限额需要在“设置与连接”填写 GitHub Token。细粒度令牌的读取需要 Metadata/Issues/Pull requests，发布还需要相应写权限，代码推送需要 Contents write。
3. **准备仓库**：分诊可以直接使用远程仓库资料；调查、审查、修复与文档任务自动克隆到插件管理的目录，并在固定提交创建专用 worktree，无需用户配置路径。也可在设置中点击「自动准备仓库」，或绑定已有 clone。自动准备不安装依赖、不执行仓库脚本。私有仓库仍需 GitHub 凭据。已有用户克隆需要包含同步时提交，缺失时会提示 fetch。
4. **批量派发**：勾选 Issue/PR，执行智能分诊、调查、修复、文档维护或 PR 审查。选中 Issue 时不能使用 PR 专属审查。默认每批 20 个、并发 2 个，可在设置修改。
5. **处理宿主审批**：实际命令遵循 Harness 的权限 preset。调查/审查使用 `read-only`；修复/文档任务默认继承宿主权限预设。需要审批时在对应 Harness 会话中处理。任务详情可点击「打开 Harness 会话 / 审批」，直接进入对应原生会话。
6. **处理结果**：在“处理流程”的横向节点查看历史、当前阶段和下一步条件。下方只显示所选阶段的结论与证据或执行记录，切换节点不会启动任务；Issue 可通过“调整分类与计划”确认目标，当前阶段的独立按钮用于继续、审批和交付。明确启动的修复目标会在改动完成后进入验证，通过验证后进入审查。Tasks 按处理链集中展示需要确认、运行中、完成和失败任务，快速分诊与预检默认隐藏。审核时查看工具结果、测试记录、真实 diff 和输入版本。测试列表是 Agent 的报告，实际执行输出保存在工具证据与 Harness Session 中；二者应一起检查。可以退回并重试、取消运行任务、导出结果 JSON 和补丁。
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
| 阶段导航 | 按 Issue/PR 类型显示阶段与关注点，历史尝试/周期只读，实时更新保留历史选中项；[设计与限制](docs/product/WORKFLOW-UX.md) |
| 事项状态 | 独立处理周期、事件历史、暂缓与等待；GitHub 更新使旧输入/审核过期，关闭重开保留历史 |
| 补充输入 | Agent 结构化问题表单，回答持久化后显式继续；新的运行与工作区保留原证据 |
| 审核 | 结果、工具证据、输入提交、真实 diff、接受/退回、差异变更和输入过期检查 |
| 交付 | JSON / patch 导出，GitHub 回复、标签、草稿 PR；发布去重与状态记录 |
| 自动化 | 可配置定时同步、对新版本问题自动分诊；默认关闭，不自动发布 |
| 图形配置 | 仓库、自动工作区、宿主模型状态、GitHub 令牌、并发与自动化 |
| 仓库理解 | 自动读取固定提交的目录、约定、README、构建配置、CI 与测试入口，展示来源与覆盖范围 |
| 任务工作流 | 分诊、调查、修复、审查、文档五类工作流；参考许可允许的 Codex / OpenAI Skills 并保留来源 |

## 安装为分发插件

每次 `master` 更新，GitHub Actions 自动构建预编译包，在 [GitHub Releases](https://github.com/Acckion/dsh-maintainer-workbench/releases) 发布按提交区分的 `master-<commit>` 预发布版本。下载其 `dsh-maintainer-workbench.tgz` 后，在 Harness 插件安装入口选择本地文件，或使用该 Release 附件的完整下载 URL。包内包含 `dist`，没有安装构建脚本，因此不需要为本插件配置 Git 构建白名单；直接安装源码 Git URL 仍需授权。

自动发布规则、npm 可选配置和校验方式见 [自动分发说明](docs/AUTOMATED-DISTRIBUTION.md)。本地生成同样的包：

```sh
npm ci --ignore-scripts
npm run package:distribution
dsh plugin --profile web add /absolute/path/artifacts/dsh-maintainer-workbench.tgz
```

```sh
npm run build
npm pack
# 在已有 Harness 环境：
dsh plugin --profile web add /absolute/path/dsh-maintainer-workbench-0.4.0.tgz
dsh web
```

也可以从宿主 Plugins 页面安装本地 tarball。包包含 host entry、原生 client factory、bundle patch；不是只有 Skill/MCP 配置。原生接口与实测版本见 [开发核查](docs/RESEARCH.md)。

## 检查与证据

```sh
npm run check          # strict TypeScript + 行为/本地 Git 流程测试 + 构建
npm run test:native    # 本地 Messages 模型夹具 + 真正的 Harness Agent / Shell 联调
npm run test:browser:settings # 原生设置注册、保存、重开、冲突与失败恢复的浏览器夹具
```

新增 `npm run evaluate` 可对固定基线和当前源码运行八案例工作流对照，并生成 JSON/Markdown 证据；默认同时进行本地模型驱动的真实 Harness 联调。使用方式与未测边界见 [可复现评估](docs/EVALUATION.md)。这不是模型质量或修复成功率评测。

浏览器回归脚本为 `scripts/browser-smoke.mjs`；需要先启动独立预览，并安装 Playwright Chromium。已记录的证据范围见 [验证记录](docs/VALIDATION.md)。本地模型夹具验证协议和工具链，不代表真实模型的智能评测。

## 数据与限制

- **全局设置入口**：Harness「设置 → 维护工作台」，包含模型、自动化、执行、连接和任务工作区。工作台右上角按钮保留快捷页面，两处使用同一表单与 SQLite 配置；保存前核对配置版本，冲突时保留草稿。仓库策略与本地路径仍在工作台的「仓库设置」。当前 SDK 未公开打开指定设置 section 的服务，因此快捷按钮不操纵宿主私有状态，也不替换原生设置启动器。

- 原生模型凭据由 Harness 管理。GitHub 令牌以及独立预览凭据单独保存在 `credentials.json`（权限 0600），不返回浏览器、不包含在任务导出中。环境变量也可配置：`DEEPSEEK_API_KEY`、`MAINTAINER_API_KEY`、`MAINTAINER_BASE_URL`、`GITHUB_TOKEN`。启动器不会自动读取 `.env`，如使用 `.env`，由运行环境加载。
- 每个数据目录只允许一个 worker 进程。崩溃中的任务转为失败，保留 worktree，人工决定是否重试；不会静默重放代码修改。
- worktree 隔离 Git 修改，命令执行隔离由宿主提供。不要把它当成容器或多租户安全系统。
- 同步上限可在设置中调整，也可选择无上限；默认读取最近更新的 1000 个 Issue/PR。分析最多获取前 30 条讨论、PR 前 100 个文件，GitHub 还可能截断 patch；结果需要说明范围。
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

分诊与预检仅处理元数据，不创建代码工作区、不开放 shell；代码任务在固定版本的隔离工作区执行，继续通过 Harness 运行，按阶段解析模型并继承权限。设置中可按仓库调整同步、自动分诊与预算。发布仍需预览并确认，不自动合并。

具体实现、验证与能力边界见 [工作流实现记录](docs/product/IMPLEMENTATION.md)。

模块划分、持久化状态机、事件与人工输入、worktree 所有权、冻结补丁交接和旧数据迁移见 [架构说明](docs/product/ARCHITECTURE.md)。

2026-10-02 安装包试用发现并修复了两处维护流程断点：失败验证仍保留为待处理事项；接受独立审查后可定位同版本、同补丁的原实施产物，继续单独批准与发布。完整十步试用、复现脚本和未测边界见 [安装包维护试用](docs/product/INSTALLED-TRIAL.md)，参赛剩余材料见 [准备状态](docs/product/COMPETITION-READINESS.md)。

随后收敛为“维护者判断台”，默认详情加入同补丁的统一审阅摘要及明确恢复状态。产品目标与非目标见 [产品定义](docs/product/PRODUCT-FOCUS.md)，个人试用时建议检查的五个场景见 [个人试用说明](docs/product/PERSONAL-TRIAL.md)。后续验证可见性与过期发布预览的补充修正、已知限制见 [补充复核](docs/product/RECOVERY-REVIEW.md)。

### Fresh profile compatibility

The current manifest targets DSH `0.2.1-alpha.1` and declares shared host peers for Cordis `^4.0.5-alpha.1`, dsh-home-paths `^0.2.1-alpha.1`, dsh-llm `^0.2.1-alpha.1`, dsh-api-session-controller `0.2.0-rc.2 || ^0.2.1-alpha.1`, and dsh-tools `^0.2.1-alpha.1` (the durable question bridge requires `concludeTurn()`). The source lockfile resolves Cordis `4.0.5-alpha.1`. Git dependency installs build the package through `prepare`. The earlier isolated DSH `0.1.7-alpha.1` / Cordis `4.0.4` installed-package workflow evidence below describes the previous dependency contract; it does not verify the current host runtime.

Harness profiles use `autoInstallPeers: false` and resolve Cordis from the host. A standalone `pnpm peers check` in that profile may therefore report a missing peer even when the runtime shares the host instance. This command requires pnpm 11 or later: before running it, verify `pnpm --version`; use an isolated pnpm 11+ tool directory if the user's PATH provides an older version. Our fresh-install check explicitly linked that exact host Cordis directory and verified realpath equality, then obtained a clean peer check. This diagnostic link is not a general install script for every Harness distribution. Do not hide peer errors or install a separate private Cordis copy. Exact evidence: [installation check](docs/evidence/install-peer-2026-10-02.json).

### 类型化事项与当前版本复核

Issue 详情现支持类型化目标与验收计划、已提出的问题和等待用户记录；同步后提示新回复，维护者核对后再继续。后续审查显式追踪历史发现，支持批量处置和经预览确认的 GitHub 讨论串状态更新。原生测试报告可直接关联工具调用、实际退出码、执行基线、补丁指纹和原始日志。用法、证据限制和浏览器复现见 [本轮实现说明](docs/product/ISSUE-REVIEW-EVIDENCE.md)。

关联 PR 的审查、CI、合并和源 Issue 关闭进度，以及 GitHub Actions 失败步骤和日志读取，见 [远端跟踪与 Actions 说明](docs/product/REMOTE-PR-ACTIONS.md)。

0.2.0 的导航、处理目标与回滚说明见 [界面与处理目标](docs/product/UI-0.2.0.md)。

### 事项详情面板（0.3.0 的旧入口）

以下描述 0.3.0 的原有入口；当前版本统一为“处理流程”与可点击阶段导航，旧深链接继续映射，详见 [阶段导航设计](docs/product/WORKFLOW-UX.md)。原来同一行左侧是 **Overview / Plan / Work / Review**，右侧是 **Summary / Activity / Diff**。Plan 仅用于 Issue；提问且没有计划时不显示。小屏幕使用两个选择器，不增加第二层页签。

- Overview：已保存的结论、分类、缺少的信息及启动操作。
- Plan：编辑目标、范围、复现和验收草稿；明确确认后才更新正式计划；也可一键确认并启动实施。运行中的任务阻止确认新计划，草稿仍保留。
- Work：当前任务状态、失败与重试、真实工具日志、补充要求和处理历史。
- Review：PR 发现与逐项处置，或实施产物的验收、同补丁验证和交付。失败或没有产物的任务在 Work 处理。
- Summary：原始 Markdown、元数据；PR 的 Commits 与 Checks 按需展开。
- Activity：原始讨论与本机回复草稿。使用已有回复建议无需再次调用模型；接受结果后可预览发布编辑后的回复。
- Diff：GitHub PR 变更和本机产物分别显示，支持从审查位置跳转并返回。

计划草稿、回复草稿、补充要求和上次查看的面板按事项保存到本机 SQLite 的 `item_drafts` 表。保存草稿不启动 Agent，也不覆盖已确认计划。回复预览绑定具体草稿内容；预览后修改草稿会阻止旧预览发布。

本轮验证使用本机浏览器、合成仓库和模拟模型，没有产生真实 GitHub 写操作或收费模型调用。详见 [详情面板验收记录](docs/product/ITEM-PANELS.md)。

### 后续工作流编排计划

后续改造按 [工作流编排计划](docs/product/WORKFLOW-ORCHESTRATION-PLAN.md) 推进：系统整理带来源的计划草稿，确认后自动衔接实施、验证与审查，界面集中呈现计划确认、异常决定和最终审核；交付区分新建 PR、更新已有 PR 与补丁导出。首版已接入计划草稿、事项编排与对应界面，操作与验证范围见 [编排实现记录](docs/product/ORCHESTRATION-IMPLEMENTATION.md)。自动修复审查发现暂留后续。
模型目录复用 Harness 官方 `buildModelCatalog(ctx)`，与宿主对话选择器使用同一来源；菜单是插件自身的紧凑界面，不读取宿主私有 React 状态。模型 ID 与阶段覆盖存入既有 SQLite 设置行，两处设置入口共享版本冲突保护。推理等级仅使用所选模型声明的值，切换模型后恢复该模型默认。公开接口说明：[Harness model selection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-model-selection/README.md)。
