# 资源、开放范围与 AI 辅助使用说明

整理日期：2026-10-30。适用范围：本仓库源码及由同提交构建的插件；最终机器版本以随包元数据为准。本说明不能替代视频、报告中全部素材的单独授权记录。

## 开放内容与自主实现

本项目开放维护工作台插件源码、阶段工作流、工程测试和打包工具。原创实现采用 MIT；适用改编工作流采用 Apache-2.0。自主部分是维护事项组织、计划与阶段编排、工具证据关联、工作区交接、恢复、维护者决定和交付界面。Agent、模型适配、会话、工具和权限基础设施来自 Harness。

| 资源 | 锁定版本或固定来源 | 许可 / 使用范围 |
| --- | --- | --- |
| DeepSeek Harness / DSH SDK | `0.2.1-alpha.1`，https://github.com/deepseek-ai/deepseek-harness | MIT；宿主与 SDK，保留适用通知；宿主二进制不随赛事 ZIP 提供 |
| DeepSeek Cordis | `4.0.5-alpha.1` | MIT；复用宿主共享实例 |
| React / React DOM / Scheduler | `18.3.1` / `18.3.1` / `0.23.2` | MIT；原生复用宿主 React，独立预览包含相关运行代码 |
| Lucide React / semver | `0.468.0` / `7.8.5` | ISC |
| Zod / react-markdown / remark-gfm | `3.25.76` / `10.1.0` / `4.0.1` | MIT；包含适用传递依赖通知 |
| OpenAI Codex 审查规则 | `94174e44cbc54cece45f6052328ca0c2cd7a8a2a` | Apache-2.0；仅改编工作流文本，见 THIRD_PARTY_NOTICES.md 的原始路径、修改说明和通知 |
| OpenAI gh-fix-ci / gh-address-comments | `49f948faa9258a0c61caceaf225e179651397431` | 各自保留 Apache-2.0 文本；未随包复制其 Python 辅助脚本 |
| TypeScript / esbuild / tsx / Playwright | `5.9.3` / `0.25.12` / `4.23.15` / `1.64.0` | Apache-2.0 / MIT / MIT / Apache-2.0；开发与验证工具，非插件自研能力 |
| Node.js / Git / Python | Node 24+；实际运行版本记入 verification.json | 外部运行/打包工具；不随本包分发二进制 |

完整 npm 解析图在 `package-lock.json`。实际保留的运行许可清单为 `third_party/runtime/manifest.json`，逐项记录版本、来源、文本路径与 SHA-256；分发前按实际文件检查。该清单不意味着模型/API、演示仓库及素材都受相同许可。

## 模型、服务与 AI 辅助

- **真实任务模型：** 演示使用 Harness 中配置的 `deepseek-v4-pro`，部分任务采用 low 推理等级；它不是本插件训练或内置权重的模型。模型权重许可、调用平台和 API 条款不能由 Harness MIT 代替，账号与实际账单不随包提供。
- **开发与文档：** 使用 Codex / ChatGPT 辅助代码、测试、排障、文档及制作工具。最终开发模型的精确版本在部分历史记录中不完整，不补造型号；贡献者应核对生成内容、引用来源、测试及权利。自动化检查不是对所有内容人工审核完成的证明。
- **工程测试：** 包内合成仓库和模型/API 夹具为项目编写并经 AI 辅助，用于验证状态、隔离、恢复和交付门槛，不是生产用户数据或模型效果数据集。
- **GitHub：** 外部协作服务，用于仓库、Issue、PR、评论及 Actions。服务条款、仓库访问授权与用户生成内容权利独立适用；本包不含账号或令牌。
- **视频制作：** 曾使用 AI 图像工具辅助插画，Codex 辅助动画代码与剪辑；正式旁白使用 OpenRouter 的 `qwen/qwen-audio-3.0-tts-plus`、`longanlufeng` 音色。未核定的图像模型版本不猜测。原始插画、PPT、录屏、音频和制作工具不在本源码/插件包中；正式 MP4 与报告应另附最终素材来源、适用服务条款及团队审核说明。

## 示例和再分发边界

`LovelyFlash/dsh-acceptance-suite` 是专门准备的演示仓库，展示不代表真实社区事故、用户增长或上游采纳。本次根目录检查未发现 LICENSE，因此不在本包再分发该仓库源文件；核对链接见 [复现说明](SUBMISSION.md)。不要把其公开可见等同于可任意再分发。

许可证正文与通知见项目根目录和 `third_party/`。团队仍需确认共同权利人、参赛资格、匿名、素材授权及赛事声明；本工程包只提供可核对的代码、文本与版本事实。
