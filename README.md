# SeedCode

SeedCode 是一个基于 Tauri 构建的跨平台 AI 智能体客户端，支持 Windows / macOS /
Linux 桌面端、Web 与 Android。它结合了现代 Web 前端技术与 Rust 后端能力，
提供了一个安全、可扩展的智能体交互环境。

**服务端为 [seedagent](https://github.com/zhezzma/seedagent)**——独立的 Node.js
多 Agent 服务，通过 HTTP + WebSocket 提供会话、聊天、技能、定时任务等 API。
SeedCode 作为客户端连接它：桌面版可将服务端**内置打包**（本地模式），也可连接
任意远程部署的 seedagent（远程模式）。

## 技术架构

- **前端 (Frontend)**: 基于 **Vue 3** + **TypeScript** + **Vite** 构建。
  - 负责用户界面渲染、交互逻辑以及与服务端的通信（REST / WebSocket / SSE）。
  - 使用了 Tailwind CSS 进行样式开发，Heroicons 作为图标库。
  - 集成了 Markdown 渲染、代码高亮等富文本功能，用于展示 Agent 的响应。

- **服务端 (Server)**: [seedagent](https://github.com/zhezzma/seedagent)。
  - Node.js + TypeScript (Hono) 实现的多 Agent 远程服务，接口为 `/api/*`
    (REST) 与 `/ws` (WebSocket 通知通道)，认证使用 Bearer Token。
  - 负责管理 Agent、会话、技能、扩展与定时任务。部署与配置详见其仓库说明。

- **桌面壳 (Rust / Tauri)**:
  - 提供系统级能力：系统通知、托盘、文件系统、原生窗口管理等。
  - Windows 桌面版可**内置 seedagent 服务端**：Rust 侧负责其完整生命周期——
    自动拉起、崩溃退避重启、退出时清理整个进程树（详见下文）。

- **通信机制**:
  - 前端 ↔ 服务端：REST + WebSocket（流式聊天走 SSE）。
  - Tauri 的 IPC 作为补充，用于系统级操作与服务端生命周期事件。

## 网关连接模式

在「设置 → 连接设置」中选择：

- **本地服务**（仅内置服务端的桌面构建可选）：地址与令牌由应用托管，不可修改。
  - 默认 `127.0.0.1:18789`，被占用时在 18789~18798 中自动挑选；
    exe 同目录 `.env` 中的 `PORT` 会作为首选候选。
  - 认证令牌为首次启动自动生成的 UUID，持久化在数据目录下 `desktop.json`。
  - 服务端数据目录默认 `~/.seedcode`（全平台统一）；可在 seedcode.exe 同目录放
    `.env` 写 `DATA_DIR=<路径>` 覆盖（相对路径相对 exe 目录解析，支持 `~/` 前缀）。
    该 `.env` 属客户端配置（只认 `DATA_DIR`/`PORT`）；数据目录下的 `.env` 属服务端，客户端不读。
    解析为 dotenv 子集：不支持 `export` 前缀；未加引号的值 `#` 后视为行内注释
    （`DATA_DIR=data # 说明`），值本身含 `#` 时用引号包裹（如 `DATA_DIR="D:/da#ta"`）。
    文件需保存为 UTF-8（无 BOM）编码，否则整个文件会被静默忽略（回退默认目录）。
- **远程服务器**：手动填写 seedagent 地址 + Bearer Token，与 Web/Android 版一致。

未内置服务端的构建（Web 版、Android、未装配的开发环境）只有远程模式。

## 桌面端内置服务端

Windows 桌面安装包可将 seedagent 服务端连同 Node 23 运行时一起打包，开箱即用、
无需单独部署服务端：

**启动流程**：应用启动 → Rust 检测内置资源 → 生成/复用令牌 → 选端口并探测
（同令牌的残留实例会被直接复用）→ 拉起 `node dist/index.js` → 等待端口真正
开始监听 → 前端自动连接并进入主界面。服务进程崩溃时自动退避重启；应用退出时
清理整个进程树。

**打包**（Windows，需本机可运行 npm；Node 运行时本机匹配 23.x 则直接采集，
否则自动下载）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1 -SeedagentDir <seedagent 仓库路径>
```

产物在 `dist-windows\`：NSIS 安装包、MSI、便携版 zip。更多开关（`-StageOnly`、
`-SkipStage`、`-NodeExe`、部署目录等）见脚本头部注释。

## 开发环境配置

1. **安装依赖**:
   ```bash
   npm install
   # 或者
   pnpm install
   ```

2. **启动开发环境**:
   ```bash
   npm run tauri dev
   # 这将同时启动 Vite 前端服务和 Tauri Rust 后端
   ```

3. **构建发布**:
   ```bash
   npm run tauri build
   ```

### 联调内置服务端（可选）

开发环境下默认没有装配服务端资源（`bundled=false`），应用以纯远程客户端运行，
行为与 Web/Android 一致。若要在开发中联调内置服务端：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1 -StageOnly -SeedagentDir <seedagent 仓库路径>
npm run tauri dev
```

`-StageOnly` 只把服务端装配到 `src-tauri\resources\seedagent\`（不打包），此时
`tauri dev` 会检测到内置服务并自动拉起。服务端的端口、令牌、数据目录等配置项
见 [seedagent](https://github.com/zhezzma/seedagent) 仓库说明。

## Web 自动部署（Cloudflare Workers）

项目已支持将 Web 版本通过 **GitHub Actions** 自动部署到 **Cloudflare Workers + Static Assets**。

- 自动部署分支：`seedagent`
- 手动部署：GitHub Actions `workflow_dispatch`
- 自定义域名：`seedcode.godgodgame.com`

详细说明见：[`docs/Cloudflare-Workers-部署.md`](docs/Cloudflare-Workers-部署.md)
