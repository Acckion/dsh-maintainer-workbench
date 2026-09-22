# 通用验收方案

XiaomiNote-for-Mac（https://github.com/Acckion/XiaomiNote-for-Mac）由用户指定为后续验收样本，仅记录在本文件。产品源码、默认配置和任务工作流不得针对它特化。本轮只读取公开仓库资料，没有发布评论、标签或 PR。

## 样本覆盖

- TypeScript / JavaScript：package.json scripts、workspace/monorepo、测试与 lint。
- Python：pyproject.toml、包目录、测试、平台依赖。
- Rust：Cargo.toml、crate/workspace、测试入口。
- Swift/macOS：Package.swift / Xcode 项目、平台依赖、实际 CI 命令。
- 混合语言或未知结构：保留证据与未知，不凭仓库名称生成命令。

自动测试使用临时自建仓库验证结构识别、固定提交、符号链接处理、只读收集、自动 clone/worktree 隔离；它们不代表模型修复成功率。

## XiaomiNote 后续实例（不是产品规则）

2026-09-22 读取的公开 AGENTS.md 描述 Swift/AppKit/SwiftUI 项目。build.yml 声明 SwiftLint、MiNoteMac scheme 的 Debug build，以及 MiNoteLibrary scheme 的 xcodebuild test。验收时必须重新读取目标提交的文件，不能将这些命令作为全局默认值。

## 真实模型验收

同一模型、同一推理设置、同一提交、同一任务输入，对比基础工作流与改进工作流。至少覆盖分类、非重复相似报告、可复现 bug、无法复现 bug、带缺陷 PR、无缺陷 PR、文档漂移。

记录：有效定位率、重复建议准确率、修复前失败/修复后通过的证据、无关修改、人工操作次数、耗时、Token、输出是否可直接审核。盲评结果并保留失败样本；不只展示成功案例。真实 API 凭据尚未配置，本轮不能声称智能水平或修复成功率提高。
