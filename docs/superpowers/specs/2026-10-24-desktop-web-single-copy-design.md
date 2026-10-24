# 设计：桌面打包 web 单份共用（seedui:// 自定义协议）

日期：2026-10-24
状态：已批准（方案 B）并已实施（2026-10-24；实施记录见 plans/2026-10-24-desktop-web-single-copy.md 与 .superpowers/sdd/ 同名 ledger；cargo test 与打包验证待主人 Windows 执行）

## 意图

桌面打包（package-desktop.ps1）当前把前端打两份：③.6 `vite build` → `resources/seedagent/web/`（内置服务端移动端隧道用），④ `tauri build` 的 `beforeBuildCommand: npm run build` 再构建一次 → `dist/` 并**编译期嵌入 exe**。目标：只构建/携带一份前端，放 `resources/seedagent/web/`，桌面 webview 与内置服务端共用。

## 方案（已选：自定义协议）

bundled 构建的窗口 `url` 指向自定义协议 `seedui://localhost/index.html`；Rust 侧注册 `seedui` 协议 handler，从 `resources/seedagent/web/` 服务静态文件。exe 不再嵌前端（`frontendDist` 指向仓库内几 KB 占位页目录，仅为满足 tauri 必填）。

被否决的备选：
- A（只省构建、产物仍两份）：不满足"单份"目标。
- C（webview 直接加载内置服务端 URL）：动态端口 IPC 放行困难、启动窗口期白屏、服务端挂则 UI 全失（当初嵌 exe 就是为此）。

## 关键事实（已核实，tauri 2.11.2）

- `WebviewUrl::CustomProtocol(Url)` 是 v2 一等公民（config 键 `app.windows[].url`，非 http(s) scheme 自动落入该变体）。
- Windows WebView2 把 `seedui://localhost` 序列化为 origin `http://seedui.localhost`；已含 CVE-2026-42184 修复的 `is_local_url` 对"域 == `<已注册协议>.localhost`"判 **local** → 现有 `capabilities/default.json`（local）原样生效，invoke/插件无需 remote 放行。
- seedagent 服务端 `cors()` 全放行，新 origin 的跨域 API/WS 调用不受影响（今天从 `http://tauri.localhost` 跨到 `127.0.0.1` 本就是跨域）。
- 前端无 `convertFileSrc`/asset 协议依赖；`isTauri` 检测 `window.__TAURI_INTERNALS__`，初始化脚本对所有导航注入（含自定义协议页面）。

## 改动清单

1. **`src-tauri/src/ui.rs`（新增）**：`seedui` 协议 handler，语义对齐服务端 `web-static.ts`：
   - MIME 表、`/static/*` → `public, max-age=31536000, immutable`、其余 `no-cache`、`x-content-type-options: nosniff`
   - SPA history 回退（非文件路径 → index.html）；`/static/*` 未命中直接 404（防 MIME 错误掩盖）
   - percent-decode 后做防穿越校验（`%2e%2e` 变形必须拦）
   - web 目录解析复用 `server::resolve_server_dir().join("web")`；目录缺失返回内置 404 页
   - 请求 URI 兼容两种形态（Windows `http://seedui.localhost/...` 与原生 `seedui://localhost/...`），取 `url.path()`
   - 纯函数拆分 + cargo 单测（路径解析/穿越拦截/缓存判定/percent-decode）
2. **`src-tauri/src/lib.rs`**：builder 注册 `.register_uri_scheme_protocol("seedui", ...)`；`resolve_server_dir` 改 `pub(crate)`。
3. **`src-tauri/ui-fallback/index.html`（新增，入库）**：占位页（"UI 资源缺失"提示），仅为满足 `frontendDist` 必填，正常流程永不导航到。
4. **`src-tauri/tauri.bundled.conf.json`**：`build.frontendDist = "ui-fallback"`、`build.beforeBuildCommand = ""`（跳过二次构建）、`app.windows[0]` 复制基础字段 + `"url": "seedui://localhost/index.html"`（数组整体替换，须抄全字段）。
5. **`scripts/package-desktop.ps1`**：
   - ③.6 前加 `npm run tcs`（原由 beforeBuildCommand 承担的类型检查移到 staging）；`npx vite build --outDir staging\web` 不变
   - 头部注释更新：`-HostUpdateServer` 热更新现在**覆盖桌面 UI**（前端不再嵌 exe，resources 里的 web 即 UI 本体）
6. **`src-tauri/Cargo.toml`**：加 `percent-encoding = "2"`（依赖树已有，零成本）。

## 不受影响（验收红线）

- 纯客户端桌面 `build_windows.ps1`：基础配置（frontendDist `../dist`、beforeBuildCommand `npm run build`、窗口 App("index.html")），resources overlay 不参与 → 不变
- Android `build_android.ps1`：同上；新增 rust 代码跨平台可编译（协议注册在移动端无害）
- dev（`npm run stage` + `tauri.dev.conf.json`）：走 devUrl 18081；seedui handler 注册但无人请求
- `-SkipStage` / `-HostUpdateServer`：staging 含 web/，照常工作

## 验证

- 本机（Linux）：`cargo test`（若 webkit 依赖不可编译则降级为纯函数逻辑抽测 + 人工核对）；`node --check` 不适用；前端零改动
- 主人 Windows 实测清单：① `-StageOnly` + `npm run stage` 联调 UI 经 seedui 加载、invoke（剪贴板/通知/分享）正常；② 全量打包后便携版启动、monaco/mermaid/pdfjs 资源与 worker 正常；③ 服务端崩溃时 UI 错误页/重启按钮可用；④ `-HostUpdateServer` 改前端后热更新生效；⑤ 纯客户端/安卓打包照旧

## 非目标

- 不改 seedagent 仓库任何代码
- 不处理 Range 请求（与 web-static.ts 对齐）
- 不动 MSI/NSIS 打包逻辑（resources glob 已含 web/，自动少一份前端）

## 实施后补充（review 轮决议，2026-10-24）

- 路径安全加固：Win32 规范化会剥离路径段末尾的 `.`/空格（`".. "`/`"..."` 在 OS 层等价 `".."`），`resolve_web_file` 除字面量 `..` 外同时拒绝段尾 `.`/空格。
- 协议 handler 改用 `register_asynchronous_uri_scheme_protocol` + 工作线程：同步版在 Windows 上于 UI 线程执行，大资源页/杀毒扫描/热更新替换窗口期会卡整个窗口事件循环。
- SPA 回退 index.html 补 `cache-control: no-cache`；seedagent 目录在而 web/ 缺失时也落"UI 资源缺失"诊断页。
- **F3 已定夺（主人）：接受一次性重置。** origin 由 `http://tauri.localhost` 切换为 `http://seedui.localhost`，WebView 存储按 origin 隔离，现有 bundled 安装升级后老 origin 下 localStorage（设置/输入历史/面板状态）不可见（数据未删）。自用分发场景接受此成本，不做迁移（前端 src/ 零改动约束下无可靠方案；WebView2 存储目录结构无官方搬迁接口）。
