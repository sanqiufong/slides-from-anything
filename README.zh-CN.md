# Slides from Anything

[English](README.md) | **简体中文**

Slides from Anything 是一个本地优先的幻灯片创作工作台，把 OpenPPT 的幻灯片生成与预览运行时，和 Design Vault 的模板/设计系统资料库整合到同一个项目里。它的目标很直接：打开一个项目，跑起真实的软件 UI，导入或安装设计系统，然后把素材、网页、笔记或其他来源内容转成可用的演示文稿。

这个仓库是面向开源发布的软件集成项目。它包含应用代码、框架必需的图片/UI 资产、skills、prompt contexts，以及让软件能跑起来的运行时连接层。它不包含你的个人本地模板库、私有 Design Vault 下载内容、生成项目、API Key、日志、数据库或其他机器本地运行数据。

## 包含什么

- OpenPPT/SFA Web UI，用于从来源内容创建 slide deck。
- 内嵌 Design Vault UI，用于导入、管理、安装设计系统和模板。
- 共享本地运行时，让 Design Vault 中安装的模板可以在 SFA 幻灯片流程里选择使用。
- 本地 daemon API，负责项目、Vault 模板、预览、资产与更新检查。
- Desktop 与 packaged runtime 脚手架，用于本地应用分发。
- 从 `v1.0.0` 开始的版本与更新元数据。

这个集成跑的是实际的 OpenPPT 和 Design Vault 界面。它不是临时写出来的 mock dashboard，也不是只提供服务接口的后端桥接。

## 环境要求

- Node.js `24.x`
- Corepack
- 通过 Corepack 使用 pnpm `10.33.2`
- macOS、Linux 或 Windows，并具备能运行 workspace 脚本的 shell 环境

```bash
corepack enable
pnpm install
```

## 快速启动

在 macOS 上，最简单的方式是使用集成启动器：

```bash
./启动集成项目.command
```

如果只想在终端里启动，不自动打开浏览器：

```bash
OPEN_IN_BROWSER=0 ./scripts/start-integrated.sh
```

启动器会同时启动两个真实应用，并在绑定端口前清理旧的本地监听进程：

- SFA / OpenPPT UI：`http://127.0.0.1:5173`
- Design Vault UI：`http://127.0.0.1:3217`

在启动器终端里按 `Ctrl+C` 可以同时停止两个服务。

## 日常开发

根目录的生命周期命令刻意保持很窄。开发 OpenPPT/SFA 时使用 `pnpm tools-dev`；需要 Design Vault 一起接入时，使用集成启动器。

```bash
pnpm tools-dev run web --daemon-port 17456 --web-port 5173
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev stop
```

发布或提交前建议运行：

```bash
pnpm guard
pnpm typecheck
pnpm --filter @open-design/web test
pnpm --filter @open-design/daemon test
pnpm --filter design-vault build
```

## 使用 Design Vault

1. 启动集成项目。
2. 打开 `http://127.0.0.1:3217`。
3. 从 URL 导入设计、安装社区模板，或创建新的本地设计系统。
4. 回到 SFA UI，进入 Design Vault 标签页。
5. 同步/选择模板，然后创建 deck。

通过 `scripts/start-integrated.sh` 启动时，Design Vault 会把运行时模板数据写到：

```text
.tmp/integrated/design-vault-data
```

这个目录会被 git 忽略。下载的社区模板、导入的本地模板都属于用户运行数据，不属于源码 fixtures。

社区服务地址通过下面的环境变量配置：

```bash
DESIGN_VAULT_COMMUNITY_BASE_URL=https://vault.aassistant.xyz
```

如果要启用模型辅助导入，可以参考 `apps/design-vault/.env.example` 中的变量，例如 `DESIGN_VAULT_MODEL_BASE_URL`、`DESIGN_VAULT_MODEL_API_KEY` 和 `DESIGN_VAULT_MODEL_NAME`。不要提交真实凭证。

## 数据与隐私边界

这个仓库按公开发布来整理，软件资产与本地/私有数据必须严格分开。

以下本地运行数据会被忽略：

- `.tmp/`
- `.od/`
- `apps/design-vault/data/*`，但保留 `.gitkeep`
- `skills/dv-*`
- `design-systems/dv-*`
- 本地 `.env` 文件
- 生成日志、数据库、项目产物与下载模板包

默认情况下，SFA 不会从相邻的 `../design-vault` checkout 自动导入模板。只有显式设置下面的变量时，旧的自动发现行为才会开启：

```bash
OPENPPT_VAULT_IMPORT_AUTODISCOVER=1
```

软件框架本身需要的图片和 UI 资产应该保留在源码里。个人内容、私有模板包和凭证应该留在被忽略的运行时目录中。

## 更新检查

应用版本从 `v1.0.0` 开始。更新元数据位于：

```text
releases/stable.json
```

daemon 通过 `/api/updates/check` 提供本地更新检查接口。如果要接入托管的发布通道，可以配置：

```bash
SFA_UPDATE_MANIFEST_URL=https://example.com/slides-from-anything/stable.json
```

Manifest 格式和发布通道约定见 `docs/update-service.md`。

## 仓库结构

```text
apps/web            SFA/OpenPPT Next.js Web runtime
apps/daemon         本地 daemon API、Vault bridge、项目/运行时服务
apps/design-vault   内嵌 Design Vault 应用
apps/desktop        Electron 桌面壳
apps/packaged       packaged runtime 入口
packages/contracts  共享 TypeScript contracts
packages/sidecar*   sidecar 协议与运行时包
tools/dev           本地开发生命周期控制面
tools/pack          打包构建、启动、停止与日志工具
skills/             源码管理的 slide/design skills
design-systems/     源码管理的 design-system 描述
prompt-templates/   prompt 与生成模板
releases/           更新通道元数据
docs/               架构与运行文档
```

## 贡献

修改仓库结构或生命周期命令前，请先阅读 `AGENTS.md`。`apps/`、`packages/`、`tools/` 下面还有各自的嵌套 `AGENTS.md`，用于说明模块级边界。

常用文档：

- `QUICKSTART.md`
- `CONTRIBUTING.md`
- `docs/architecture.md`
- `docs/openppt-architecture-notes.md`
- `docs/design-vault-style-output-requirements.md`

## 许可证

Apache-2.0。详见 `LICENSE`。
