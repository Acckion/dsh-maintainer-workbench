# 自动分发

`.github/workflows/distribution.yml` 在每次 master push 后生成预编译包，PR 只执行构建与校验，不发布。也可在 Actions 中手动运行，只有选择 master 才会发布。各提交独立运行，繁忙时不会因全局构建并发组而丢弃排队中的提交。

## 安装与追溯

每个成功构建生成三个文件：

- `dsh-maintainer-workbench.tgz`：可供 Harness 安装的预编译包。
- `SHA256SUMS`：校验包内容。
- `distribution.json`：包版本、源码版本、完整提交、SHA-256 和 npm shasum。

版本采用 `<基础版本>-master.<提交时间戳>.g<12位提交>`，同一提交重跑时保持版本一致。GitHub Release 标签采用 `master-<完整提交>`，标为预发布，不改变稳定版 latest。附件也保存为 Actions artifact，保留 30 天；Release 不依赖 artifact 的保留期。

在 GitHub Releases 打开对应版本，下载 `.tgz` 并选择本地文件安装，或者使用附件的实际下载 URL：

```text
https://github.com/Acckion/dsh-maintainer-workbench/releases/download/master-<完整提交>/dsh-maintainer-workbench.tgz
```

CLI 可使用 `dsh plugin --profile web add <附件URL或本地tgz路径>`。需要满足已有 Harness peer 版本要求，预编译包不会跳过宿主兼容检查。源码 Git URL 安装仍运行 prepare，仍需要 Git 构建授权。

## 包的构建与校验

安装依赖使用 `npm ci --ignore-scripts`，之后显式执行类型检查、包兼容及关键工作流测试、构建与真实 tarball 校验。全量测试入口保持不变；当前发布门槛使用有针对性的回归集，既有全量测试失败记录见编排实现记录，不宣称全量检查通过。

打包脚本只复制 package.json 的 files 清单和许可证到临时目录。分发清单保留 runtime/peer 依赖、入口、Harness 配置及 start 命令，移除开发依赖与构建生命周期脚本。源码中的 prepare 保留，开发方式不变。tarball 检查真实入口、预览文件、工作流和文档检查脚本、第三方许可证，以及服务器和客户端 bundle 的 JavaScript 语法。

Release 重跑先检查远端状态，仅将 404 视为尚未创建；认证、网络和其他 API 错误使任务失败。同一提交的附件可以重新上传。每个发布步骤重新检查 SHA-256。

## 可选 npm 发布

GitHub Release 默认开启，不需要 npm 凭据。npm 默认关闭。若希望每个 master 构建也发布到 npm：

1. 确认 npm 包名 `dsh-maintainer-workbench` 属于你的账号；若未创建，先将本地生成的包发布一次。
2. 在仓库 Settings → Secrets and variables → Actions 中设置变量 `PUBLISH_NPM_MASTER=true`。
3. 二选一配置 npm 权限：在 npm 的包设置中添加 GitHub trusted publisher（账号 `Acckion`、仓库 `dsh-maintainer-workbench`、文件名 `distribution.yml`），允许 publish 与 dist-tag 操作；或者配置仓库 secret `NPM_TOKEN`，使用具备该包发布权限的 granular token。

参考 [npm trusted publishing 官方说明](https://docs.npmjs.com/trusted-publishers/)。工作流使用 GitHub-hosted runner、npm 11.21.0 以及 `id-token: write`；该 npm 版本支持通过 OIDC 管理 dist-tag。公开源码仓库发布附带 provenance；私有源码仓库使用 OIDC 发布，但关闭 npm 不支持的 provenance。工作流通过 GitHub API 查询仓库可见性，查询失败则停止发布。没有配置 trusted publisher 时，需要有效的 NPM_TOKEN；仅开启变量并不能获得 npm 包权限。

npm 发布与 GitHub Release 使用同一个已验证的 tarball。提交对应 `commit-<完整提交>` dist-tag，另有串行步骤仅为当前 master 更新 `master` 标签，因此较旧的并行构建不会覆盖较新的包。稳定版 latest 不变。安装可选择具体版本，或在支持 npm 包名的入口使用 `dsh-maintainer-workbench@master`。

同一版本重跑时核对 registry 的 shasum：一致则跳过重复发布，不一致或 registry 查询失败则报错。首次公开发布、npm 包权限与 trusted publisher 配置需要在 npm 完成，仓库文件不能代替账号授权。

## 本地验证

Windows / Node.js 25.2.1 下类型检查、32 项包兼容与关键工作流回归、实际构建和 tarball 校验通过。GitHub Actions YAML 经 actionlint 1.7.12 检查通过。临时 pnpm 12.10.1 项目设置 `strictDepBuilds: true`、`allowBuilds: { dsh-maintainer-workbench: false }`，在未使用 ignore-scripts 的情况下成功安装预编译 tarball；临时项目不安装 Harness peer，激活插件时仍由真实宿主提供这些依赖。

本地验证未执行 npm 发布，也未修改用户真实 Harness profile。GitHub Release 在工作流合入 master 后自动发布；npm 仅在配置权限并开启变量后发布。
