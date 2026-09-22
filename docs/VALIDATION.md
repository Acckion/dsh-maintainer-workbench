# MVP 验证记录

验证日期：2026-09-22；Node 25.9.0，macOS arm64。Harness 0.1.7-alpha.1 / Cordis 4.0.3。

## 已完成

- Strict TypeScript 检查与两种构建：独立预览、Harness Host + Client factory。
- 13 项自动化测试：批量原子派发、同输入版本去重、取消与重试、并发控制、过期输入禁止批准、进程恢复、HTTP 来源与输入校验、GitHub 读取适配器、0600 密钥存储、本地修改隔离与差异变更检测、完整本地发布链路、相关问题检索、模糊发布失败后的评论去重、进程互斥。
- 浏览器操作：选择多个 Issue、执行分诊、打开审核、接受结果、查看重复建议、模型配置入口；1512px 桌面与 390px 手机宽度没有横向溢出。
- 真实公开 GitHub 只读同步：`octocat/git-consortium` 成功获取 54 条记录（39 Issue、15 PR），代码基线 `b33a9c7c02ad93f621fa38f0e9fc9e867e12fa0e`，无截断提示。
- 原生 Harness：最终 tarball 经 `dsh plugin --profile web add` 安装成功；以已安装包（不使用源码覆盖）启动宿主，业务 API 返回 200、`harness: true` 和 10 条演示记录。宿主实际侧栏出现“维护工作台”，页面可以读取后端、发起两条分诊任务、收到完成结果，并显示证据与审核按钮。不是把独立页面截图当作原生插件验证。
- 本地 Git 发布链路：构造错误实现，真实测试先失败，执行修复后测试通过；原克隆不变；审核后真实提交并推送临时裸仓库；GitHub API 使用本地替身，验证生成草稿 PR 的请求和返回记录。
- 原生 Agent 联调：本地 Messages 协议模型夹具 → Harness Standard Agent → 原生 Bash 工具 → `workspace-write` 沙盒 → 临时 worktree 修改 → 真实回归测试 → `tool/result` → 真实 diff → `awaiting_review`。

原生联调的工具输出包含：

```text
BASELINE_FAILED_AS_EXPECTED
REGRESSION_PASSED
```

已保存的原生执行证据见 [native-execution.json](evidence/native-execution.json)。

生成的真实修改为：

```diff
-module.exports=(a,b)=>a-b;
+module.exports=(a,b)=>a+b;
```

该测试修复了一个接入问题：当前版本官方模型路由为 `deepseek-official`，不能使用旧文档示例中的 `deepseek`。在 Codex 外层沙盒内启动时，macOS 拒绝嵌套 `sandbox-exec`；将测试宿主启动到外层沙盒之外后，保留 Harness 自身 `workspace-write` 限制，测试通过，没有切换成无沙盒执行。

## 尚未验证

- 真实模型对真实仓库的分类、去重、根因分析、修复成功率和成本。用户当前未配置模型凭据，本地模型夹具不代表智能质量。
- 真实 GitHub 评论、标签和 PR 写入。所有发布测试使用临时本地 Git 远端和 API 替身，没有给任何外部仓库发评论或创建 PR。
- 长时间大规模任务、跨平台安装与多维护者并发。
- 新版本 Harness 的兼容性。

## 复现

运行 `npm run check`。运行 `npm run test:native` 验证真实 Harness 工具链，使用本地模型夹具，不需要 API Key，也不会访问真实 GitHub。完整报告与工具输出保存在该命令打印的临时 evidence directory；测试结束会停止夹具模型和宿主。行为测试的 Git 临时目录保留供检查。

真实凭据验收应选择一个团队有写权限的测试仓库，以相同输入比较原生 Harness 与工作台，记录维护者操作次数、耗时、重复执行数、可接受结果比例、模型 Token 与实际费用。没有这些数据前不作竞品性能领先声明。


## 2026-09-22：宿主继承与通用仓库理解更新

- `npm run check`：18 项测试、严格类型检查和构建通过。新增模型/推理动态继承、宿主默认 preset、metadata-only 原生 Session、旧凭据不污染宿主、跨语言仓库结构识别、固定提交/符号链接/不执行脚本、自动 clone 与 worktree 隔离验证。
- `npm run test:native`：真实 Harness Standard Agent / Bash / 沙盒联调通过。插件模型故意设为 `obsolete-plugin-provider / obsolete-plugin-model`，模型夹具收到的 4 次请求仍全部使用宿主 `deepseek-flash`。真实修复任务生成补丁并有先失败后通过的测试输出；无 checkout 的分诊创建独立原生 Session，测试报告被强制标记为未执行。证据：[native-inheritance.json](evidence/native-inheritance.json)。
- 原生模型的端点与密钥不再通过插件 GUI 配置；Agent preset 默认 inherit，沿用宿主工具/Skills。正常 launcher 不再覆盖 DSH_HOME 或导入旧插件模型凭据。
- 通用性检查：产品运行时代码、工作流和默认界面没有 XiaomiNote、MiNote、xcodebuild 或 SwiftLint 特例。验收仓库仅记入 ACCEPTANCE.md。

以上验证使用本地模型夹具与临时仓库，不证明真实模型质量提升。自动 clone 的 GitHub 网络传输、真实模型与真实 GitHub 写入仍需要配置凭据后在验收仓库验证；本地 clone 测试采用临时 Git 传输替身。

- 最终原生联调再次通过，修复任务使用 `permissionPreset: inherit`，沿用宿主默认权限，保留真实 Harness 沙盒。
- 已在用户原生浏览器打开更新后的工作台，确认宿主默认模型展示、重复模型密钥输入移除、Agent preset 继承和原生侧栏加载。当前正常启动沿用用户 Harness 配置，端口 4318。
- 分发 tarball 包含五个工作流（源码与 dist 各一份）、四份上游许可证/NOTICE；从 tarball 解压后导入 host entry 成功。
