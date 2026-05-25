# 为 Slides from Anything 贡献

感谢你帮助改进 Slides from Anything。这个项目把 OpenPPT/SFA 的幻灯片运行时和 Design Vault 整合到一起，让用户可以在本地跑起真实软件 UI，安装或导入设计系统，并把来源内容生成 slide deck。

## 基本原则

- 保持仓库适合开源发布：不要提交 API Key、本地 `.env`、生成项目、日志、数据库或私有模板包。
- 区分软件资产和用户私有资产。应用运行所需的框架图片和 UI 资产应该留在源码中；下载模板和用户数据应该留在被忽略的运行时目录里。
- 本地生命周期统一使用 `pnpm tools-dev`。不要新增根目录别名，例如 `pnpm dev`、`pnpm start`、`pnpm test` 或 `pnpm build`。
- 新增项目自有入口、模块、脚本和测试时，优先使用 TypeScript。
- Git commit 不要包含 `Co-authored-by` 或其他共同作者元数据。

修改仓库结构、包边界或本地生命周期命令前，请先阅读 `AGENTS.md`。

## 本地启动

```bash
corepack enable
pnpm install
OPEN_IN_BROWSER=0 ./scripts/start-integrated.sh
```

集成启动器会启动：

- SFA / OpenPPT UI：`http://127.0.0.1:5173`
- Design Vault UI：`http://127.0.0.1:3217`

如果只开发 OpenPPT/SFA：

```bash
pnpm tools-dev run web --daemon-port 17456 --web-port 5173
```

## 适合贡献的方向

- `apps/web` 中的 SFA/OpenPPT Web 体验修复。
- `apps/daemon` 中的 daemon、Vault bridge、预览、资产和更新检查修复。
- `apps/design-vault` 中的 Design Vault 集成修复。
- `packages/contracts` 中的共享 API contract。
- `tools/dev` 中的运行时生命周期改进，或 `tools/pack` 中的打包工作。
- 能准确描述本项目的文档，而不是上游营销文案。

## 数据边界

以下内容不应该进入 git：

- `.tmp/`
- `.od/`
- `apps/design-vault/data/*`，但保留 `.gitkeep`
- `skills/dv-*`
- `design-systems/dv-*`
- 本地 `.env` 文件
- 生成日志、数据库、项目产物和下载模板包

通过 `scripts/start-integrated.sh` 启动时，Design Vault 运行时数据会写到：

```text
.tmp/integrated/design-vault-data
```

## 验证

至少运行：

```bash
pnpm guard
pnpm typecheck
```

然后根据改动范围运行包级检查：

```bash
pnpm --filter @open-design/web test
pnpm --filter @open-design/daemon test
pnpm --filter design-vault build
```

`@open-design/*` 仍然是当前 workspace 的包名。重命名包名属于单独的兼容性迁移，不要混在无关改动里。

## 文档

当前维护的根目录文档是：

- `README.md`
- `README.zh-CN.md`
- `QUICKSTART.md`
- `CONTRIBUTING.md`
- `CONTRIBUTING.zh-CN.md`

不要再新增未维护的多语言副本。
