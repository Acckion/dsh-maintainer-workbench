# 持久化维护流程与模块架构

本轮重构把事项的长期处理状态、单次 Agent 执行和 Git 工作区分开。一个 Issue/PR 可以等待回复、请求输入、暂缓、审核、跟踪交付；进程重启不会要求从头走完整条流水线。

## 模块边界

```text
src/
  domain/                       处理周期、事件、等待、输入请求、工作区与变更快照类型
  workflow/
    definitions.ts              流程定义版本注册
    engine.ts                   纯状态转换函数
    stages.ts                   阶段的工具权限与源码保护策略
    run-state.ts                执行结果到业务阶段的转换
    actions.ts                  后端生成的可执行操作与阻塞原因
    continuation.ts             显式 resolve 目标的自动阶段交接
  application/
    repositories.ts             接入、发现、同步、准备仓库及自动分诊
    tracking.ts                 GitHub 远端状态、Actions 与事项详情
    issues.ts                   分类、目标计划、维护者决定及追问记录
    processing.ts               查询全部处理周期、请求/提交输入、结束等待及环境恢复
    tasks.ts                    派发、取消、重试、继续、审核与发现处置
    reviews.ts                  审查发现复核、讨论串关联及处置
    publication.ts              发布预览、发布互斥及追问回执恢复
    workspaces.ts               工作区检查、人工恢复及受保护的清理
    service.ts                  组合依赖和公共读取/写入辅助
  execution/
    scheduler.ts                持久化队列调度、并发上限、事项串行及仓库轮转
    stage-worker.ts             单次执行、工作区交接、Agent 回调与结果保存
  infrastructure/
    persistence/processing.ts   SQLite 状态、事件与输入
    persistence/workflow-upgrade.ts  显式流程版本迁移
    persistence/legacy-issue.ts  旧字段仅用于初始迁移
    git/workspace-manager.ts    工作区所有权、恢复、冻结补丁与树校验
    git/locks.ts                仓库 Git 管理操作互斥
    github/                     仓库、PR、Actions、讨论及共享传输接口
  plugin/input-tool.ts          原生 ask_user_question 的持久化暂停桥接
  core/workbench.ts             应用组合入口
  core/github.ts                保留原 GitHub API 接口的适配入口
  client/                      Overview/Plan/Work/Review、操作投影、输入/历史、审核和设置
```

`Workbench` 负责实例组合和兼容入口，不再承担各业务模块的实现。GitHub facade 组合各资源客户端；认证、重试及原有发布检查保持兼容。现有补丁发布、证据检查和阶段产物模块继续复用。

领域类型不执行 I/O。工作流转换不调用 GitHub、Git、模型或计时器。应用服务安排操作，基础设施完成持久化和外部访问，执行器消费已保存的 Job。

## 三种独立身份

| 身份                    | 作用                                           | 生命周期                          |
| ----------------------- | ---------------------------------------------- | --------------------------------- |
| Work item（现有 Issue） | GitHub Issue/PR 或本地仓库整理事项的事实与目标 | 可以长期存在                      |
| Processing case         | 当前处理周期、状态、等待和事件历史             | 关闭后重开创建新周期，保留旧周期  |
| Job                     | 一次阶段执行、输入快照、会话、证据和反馈       | 重试/继续建立新的尝试，保留旧运行 |

新的 Job 绑定 `caseId`。旧周期的执行、批准、交接来源及发布不能推进新周期；派发去重也限定在同一周期内。

## 状态机与事件

状态使用两个维度：

- `lifecycle`：`active / waiting / deferred / completed / cancelled`，表示事项是否正在处理、等待或结束。
- `phase`：`triage / preflight / investigate / decision / accepted / fix / docs / validate / review / track / closed` 等业务阶段。保留旧阶段名，便于兼容存量数据。

单次运行的 `queued / running / waiting_input / waiting_environment / completed / awaiting_review / approved / failed` 等状态单独保存在 Job。运行成功不等于验证通过，也不等于事项完成；验证失败投影到 `blocked`。

`workflow/engine.ts` 的输入是当前 case 和一个类型化事件，输出是新的 case。状态保存流程定义版本、单调递增的 `version`、源信息指纹、计划指纹、当前运行和等待记录。

| 事件                    | 触发来源                                     | 处理方式                                                                |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `source.observed`       | GitHub/本地事项同步                          | 更新源指纹；输入变化使旧输入请求和产物审核等待过期                      |
| `decision.recorded`     | 接受目标、暂缓、恢复、保存计划               | 保存明确决定；接受时绑定当前源指纹                                      |
| `information.observed`  | 记录追问、收到回复、核对追问                 | 保存等待报告者回复的状态；收到回复仍需重新评估                          |
| `run.observed`          | 派发、执行、权限等待、完成或审核             | 更新活动运行；旧输入或旧运行的迟到结果仅保留证据                        |
| `input.requested`       | 原生提问工具、Agent 结构化报告或本地请求接口 | 保存具体问题、必填字段、来源运行及目标指纹                              |
| `input.submitted`       | 维护者提交表单                               | 校验版本、字段和指纹，保存回答，不自动启动 Agent                        |
| `remote.activity`       | CI、远端 PR/审查/讨论串变化                  | 校验目标 URL、HEAD、BASE 和证据完整性；结束对应等待，记录失败或修订方向 |
| `publication.confirmed` | 发布回执                                     | PR/Review 交付创建 CI/作者修订等待；提问答复完成本地处理                |
| `environment.observed`  | 仓库准备失败/准备完成                        | 持久化环境等待；环境就绪后仍需显式继续                                  |
| `wait.cancelled`        | 维护者填写原因并结束等待                     | 保存取消原因，与追问事实同步；不代替宿主权限审批                        |
| `workflow.upgraded`     | 版本迁移                                     | 保留身份、历史和回答，记录升级事件，不执行 Agent                        |

处理已关闭事项时保留历史；重新打开开始新周期。暂缓不会被后续同步或旧 Agent 结果自动解除。新的信息不会自动等同于目标已接受、问题已解决或 PR 可合并。

CI 和审查活动不会自动批准或合并。缺少检查、部分覆盖、读取失败均保留为未知；不同版本的结果不能满足交付等待。当前版本 CI 失败进入阻塞，重跑结果继续跟踪；作者更新版本后进入重新评估。活动运行期间保存远端证据，不用它覆盖当前执行阶段。关联 PR 合并不直接完成仍开放的 Issue；PR 本身关闭/合并通过事项同步驱动终态。重复轮询时间戳不产生新事件，状态从失败到通过再失败会分别记录。

## 等待、人工输入与继续

等待包含类型、状态、创建原因、目标指纹、来源运行，以及可选问题和期望回复者。等待状态包括 `open / satisfied / cancelled / superseded`。已接入报告者回复、产物审核、宿主权限、用户输入、作者修订、CI 完成和环境准备等待。取消/拒绝运行会结束其等待，避免长期阻塞。界面可展开所有周期的事件历史，并填写原因结束适用等待。宿主权限审批在 Harness 中完成。

原生执行器在会话局部覆盖 `ask_user_question`：保存问题和选项，调用宿主 `concludeTurn()` 结束当前 turn，阻止继续调用执行工具。执行器在每次等待 Agent 空闲后检查提问，保存暂停状态及部分补丁，不强求 Agent 再输出完整最终报告。这需要 `@deepseek-ai/dsh-tools@^0.2.1-alpha.1` 的工具结束 turn 接口。

Agent 也可以在阶段报告中返回：

```json
{
  "inputRequest": {
    "reason": "需要确认兼容性要求",
    "fields": [
      { "id": "compatibility", "question": "需要保留哪些旧版本行为？" }
    ]
  }
}
```

其余报告字段仍遵循该阶段 schema。执行器先处理输入请求，不把暂时缺少补丁判为实施失败；已有补丁会冻结为快照。运行保存为 `waiting_input`，释放调度槽和工作区写入所有权。

界面显示问题表单。回答持久化后，维护者点击“根据补充信息继续”，创建新的 Job，携带回答、历史产物和已有补丁。代码阶段创建新的 worktree，并验证重建后的文件树。旧会话/运行仍可查看，不要求进程持续挂起。

源信息更新会使绑定旧指纹的输入请求过期，过期回答不能恢复旧运行。仓库准备失败保存为 `waiting_environment`，释放槽位；准备完成只满足等待，点击继续创建新运行。等待期间不自动重试，不持有 Agent 会话。

追问草稿经维护者确认发布后，发布服务依据已确认回执创建报告者等待；稳定请求 ID、事务和回执标记支持重启恢复且不重复创建追问。回执保存实际发布回复；维护者编辑过回复时，需要核对并登记实际追问，不按旧报告自动创建等待。普通评论不完成事项；已确认的提问答复可以完成本地处理，GitHub 状态保持独立。

## 一致性与并发

SQLite 新增：

- `processing_cases`：每事项只有一个 current case，历史周期保留。
- `processing_events`：按顺序保存事件，case 内的去重键唯一。
- `processing_inputs`：绑定 case 和 wait 的结构化回答。
- `schema_migrations`：幂等迁移记录。
- `workspaces` 和 `change_snapshots`：工作区所有权及不可变交接快照。

事项/Job 写入与状态事件在同一事务中保存，嵌套操作使用 savepoint；失败全部回滚。等待输入的报告、Job 状态和请求也是一个事务。事件存储不调用模型，启动迁移不重放已完成任务。

单事项操作可提交 `expectedVersion`；输入和继续接口要求版本。过期窗口返回 HTTP `409` 和 `VERSION_CONFLICT`，不能覆盖较新的决定。旧接口仍支持省略版本，便于兼容原调用者。发布保持原有 SHA、补丁、批准和预览校验，并增加周期检查。

队列保持每数据目录一个 worker 进程、同事项串行、跨仓库轮转和全局并发限制。事件持久化不等于整个系统具备跨进程 exactly-once 执行；尚未加入通用 effect outbox 或多 worker 租约。

流程定义当前为 `maintainer/2`。启动时将已知 `maintainer/1` 周期逐个显式迁移，记录升级事件和版本增量，保留等待、输入和运行身份；迁移幂等且不重放执行。程序不认识已保存版本时停止该转换并保留记录。后续版本需要保留旧转换，或提供同样明确、可验证的迁移。

## Worktree 与不可变变更

仓库准备仍兼容现有 managed clone / 用户绑定 clone。每次代码执行使用 `dataDir/worktrees/<jobId>`，分支使用完整 Job ID，避免短 UUID 碰撞。Git worktree 创建及 PR revision fetch 在仓库管理锁内执行，避免共享 ref/FETCH_HEAD 的竞态；不同工作区的 Agent 可以并行操作。

工作区记录包含仓库、周期、所有者运行、固定提交、用途、路径、分支和状态。新执行不能覆盖已有工作区。进程中断的 `preparing / in_use / ready / cleaning` 工作区标记为 `interrupted`；不默认假设原 Agent 已经停止，不静默重新占用。

阶段完成或请求输入时，冻结：

- 从固定 checkout SHA 到当前内容的完整补丁，包含未跟踪文件与二进制变更。
- 补丁 SHA-256、Git 文件树 hash、原运行/周期、来源快照及补丁文件路径。
- 通过临时文件 rename 保存的补丁文件和 SQLite 快照记录。

验证、审查及后续实施从固定提交创建新工作区，读取冻结补丁，校验 hash，应用到 index，再核对重建文件树。不会只依赖仍可被改动的上一阶段目录。旧任务没有快照时，先核对其已释放工作区、原 HEAD 和补丁，再迁移为冻结快照；无法核对时拒绝交接，不回退到未校验的可变目录。

格式恢复是受限制的例外：只复用已登记、`retained` 的工作区，独占期间标记 `in_use`，继续验证原 HEAD 和补丁。中断状态需要人工处理或新尝试，不自动复用。

全局设置提供工作区检查、处置预览和确认清理。检查使用临时 Git index，保留原 Agent 的暂存区。核对目标路径、符号链接、Git common directory、登记分支、HEAD、补丁和文件树，以及活动任务、审核/输入、格式恢复和交付状态。预览戳绑定当前检查结果；确认时重新校验，任何漂移都会拒绝操作。中断目录需明确确认原 Harness 会话和进程停止后恢复所有权，不自动继续执行。

清理只有已结束或已交付工作区才可执行；删除目录，保留分支、冻结快照、日志和事件。删除前保存清理意图；若进程在 Git 删除完成后、回执保存前中断，重启通过目录缺失及 Git 登记检查恢复完成状态。没有自动 GC。worktree 隔离文件和 index，运行时/网络/依赖缓存隔离继续由宿主负责。

## 兼容迁移

原 `issues / jobs / repos / settings / audit / triage_cache / item_drafts` 表保留。本地草稿与已确认计划独立保存，草稿编辑不产生处理事件；正式计划确认携带当前状态版本，运行中的事项禁止确认新计划。启动时为旧事项建立首个处理周期，把原 workflow/plan/追问转成初始状态；存量 Job 补充周期身份，恢复排队/运行状态记录，但不调用 Agent。已经运行而进程中断的任务继续使用原失败恢复策略，保留目录和提示。

已知旧 worktree 只在路径严格位于当前数据目录的 `worktrees/<安全标识>` 且分支为 `maintainer/` 时登记，不遍历、不删除用户其他目录。迁移重复执行不会新增周期或重复登记。

`Issue.processing` 是唯一权威处理状态。已移除运行时 `Issue.workflow` 及重复的旧下一步判断；旧磁盘字段仅由迁移适配器读取，之后不再保存。客户端保留 Overview / Plan / Work / Review 分栏、原始 GitHub 内容与本地草稿持久化，移除不可达的 Triage/Execution 和旧单页渲染。等待输入展示在 Overview 和 Work，完整周期事件历史在 Work；审核操作独立为 ReviewActions。`actionsAvailable` 由后端生成，界面展示相同操作策略和阻塞原因，避免自行维护另一套下一步规则。历史 Analysis、阶段报告、导出和发布入口仍可使用。

## 扩展方法

新增事件：在 `domain/processing.ts` 定义 payload，在 engine 增加纯转换，再由应用服务/适配器发出；为重复事件、旧输入、重启和回滚增加行为测试。

新增阶段：定义阶段报告 schema 和 `JobKind`，在 `workflow/stages.ts` 声明工具权限和源码保护策略，补充 `run-state/actions/continuation` 规则和执行入口。GitHub 分类器、Agent runner 和队列不应包含另一份重复状态机。

变更流程：新增定义版本，并保留旧定义或实现显式版本迁移。当前注册方式是 TypeScript 配置，不是任意 JSON 工作流解释器；新增复杂分支仍需要代码与验证。

接入 webhook / 多 worker / 自动 GC 可分别增加可靠 inbox/outbox、持久化租约及 fencing、自动保留策略。当前产品使用单 worker、轮询和显式工作区清理；不会因等待就绪自动执行外部写入。

## 验证入口

`npm run check` 覆盖严格类型检查、全部行为测试和插件/客户端构建。新增状态测试覆盖重启等待、乐观版本、事件去重、事务回滚、输入过期、迟到结果、暂缓、关闭重开、旧周期隔离、文档验证失败及旧数据迁移。新增真实本地 Git 测试覆盖同文件并发隔离、冻结/重建树、补丁损坏、补丁漂移、所有权恢复、清理证据保留和删除中断恢复。

`npm run test:browser:maintenance` 覆盖桌面和窄屏界面，包括填写结构化输入、保存后不自动执行、显式继续、保留旧运行、周期事件历史及工作区清理。`npm run test:browser:navigation` 检查导航并发；`npm run test:native` 使用本地模型夹具和真实 Harness 工具，验证修复、分诊工具限制、补丁绑定的验证证据，以及原生提问暂停、填写后显式继续与独立工作区。真实模型质量和真实 GitHub 写入不包含在这轮本地验证中。

导航夹具需先启动独立预览，并通过 `WORKBENCH_TEST_URL=http://127.0.0.1:<端口>/` 指定实际服务根路径；浏览器可通过 `PLAYWRIGHT_CHROMIUM_PATH` 指定已安装的 Chromium。

2026-10-09 合并版本验证：严格类型检查、287 项行为测试及完整构建通过；真实 Harness 的本地模型夹具验证提问暂停/显式续跑、修复和补丁绑定验证；维护与导航浏览器夹具在 1440px / 390px 通过。上述验证使用模拟 GitHub/模型响应，不包含真实仓库外部发布或模型质量评估。
