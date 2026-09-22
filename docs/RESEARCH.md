# DeepSeek Harness 插件开发核查

核查日期：2026-09-22。源码提交 `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`；运行依赖固定为 npm `@deepseek-ai/dsh@0.1.7-alpha.1`、`@deepseek-ai/cordis@4.0.3`。npm 默认标签当时仍指向较早版本，不能把 `latest` 当成源码接口版本。

## 已使用的真实扩展机制

| 扩展点 | 本项目实现 | 官方依据 |
|---|---|---|
| Cordis `apply(ctx)`、`inject`、`ctx.effect` | 后端服务加载与生命周期清理 | [插件教程](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/cordis-tutorial/01-first-plugin.md) |
| `dsh.bundle` + `cordis.patch.yml` | 插件管理器可安装的包 | [架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/architecture.md) |
| `dsh.client`、`./client`、`window.__ModuleLoader__.load` | 原生浏览器模块，复用宿主 React | [模块系统](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/modules/README.md) |
| `sidebar.panellist` / `main` | 独立维护入口和主页面 | [官方插件管理页](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-plugin-manager/src/client/index.ts) |
| `ctx.webServer.register` + `connection.requestRejection` | 同宿主认证与来源校验的业务 HTTP API | [官方路由示例](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/host/open-in-app/src/index.ts) |
| `ctx.agents.create`、`agentPresets.mount`、`workspaceRegistry` | 原生工具执行、工作区会话关联 | [官方 Webhook 会话创建](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/webhook/webhook/src/session.ts) |
| `session/event`、`tool/result`、`turn/end` | 任务结果与工具执行证据回流 | [Session 类型](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/core/session/src/types.ts) |

没有伪造 `ctx.remote.maintainer` 方法。本版采用上游公开的 WebServer 扩展点，继承宿主 connection 信任校验。后续如转为 Typert Remote，应按官方生成协议和客户端 codec 一起迁移。

## 复用与自主工作边界

复用 Harness 的 Standard Agent preset：系统提示、代码工具、文件检索、Shell、会话持久化、模型适配器、沙盒和审批机制。我们没有重新编写一个通用 Coding Agent，也没有复制闭源 Copilot/Codex 提示词。本项目只添加维护任务的目标、结构化输出约束和证据要求。现已改编开源 Codex review rubric 和 OpenAI gh-fix-ci / gh-address-comments 的工作流原则，版本、许可证及变更见 THIRD_PARTY_NOTICES.md；尚无真实模型对照数据证明收益。

自主实现包括仓库收件箱、批量操作、相关问题检索、输入版本绑定、幂等派发、持久化队列、并发与超时、取消重试、进程中断恢复、worktree 管理、证据审核、差异过期检测、GitHub 发布及定时同步。

## 明确边界

- Harness 是开发预览版，接口会变化；升级要重新执行原生加载和执行器测试。
- 原生 DeepSeek 适配器使用 Messages 协议，官方默认模型在当前包中为 `deepseek-flash`。独立预览的 API 适配器使用 OpenAI-compatible Chat Completions；两者端点不可混用。
- worktree 用来隔离 Git 改动，不是安全沙盒。实际命令执行遵循宿主权限 preset。
- 没有任何真实模型评测结果能支持“智能水平已经超过 Copilot/Codex”。本版提供可对比的流程与证据出口。
- 公开仓库同步读取 GitHub REST；写入只由维护者在审核后点击具体发布动作触发，草稿 PR 不自动合并。


## 宿主统一接入更新

`agentDefaultModel.currentSelection()` 每次任务读取 provider/model/reasoningEffort。`agentPresets.resolve(undefined)` 跟随宿主默认 preset（配置填 inherit），`agentPresets.mount` 复用该 preset 的工具、Skills 和 Agent 行为。Session 通过 workspaceRegistry 关联；前端使用 `uiWorkspace.openSession` 打开任务和审批。宿主适配器管理端点与凭据，插件不读取/展示密钥，也不再将旧插件模型配置导入宿主环境。

无 checkout 的分诊也创建 metadata-only 工作区和原生 Session，禁止回退直连 API；远端模式强制把模型声称的测试标为未执行。提供方存在仅表示 adapter 已注册，凭据有效性仍需实际调用验证。开发启动默认沿用用户 Harness 配置；隔离演示是显式参数。
