# 桌面打包 web 单份共用（seedui:// 协议）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bundled 桌面打包只构建/携带一份前端（`resources/seedagent/web/`），桌面 webview 经 `seedui://` 自定义协议加载它，exe 不再嵌前端。

**Architecture:** Rust 侧注册 `seedui` 协议 handler，从 `resolve_server_dir()/web` 服务静态文件（语义对齐 seedagent `web-static.ts`）；bundled overlay 把窗口 `url` 指向 `seedui://localhost/index.html`、`frontendDist` 指向仓库内占位页、`beforeBuildCommand` 置空；类型检查（tcs）移入 staging。

**Tech Stack:** Tauri 2.11.2（Rust）、PowerShell 打包脚本、vite。

**Spec:** `docs/superpowers/specs/2026-10-24-desktop-web-single-copy-design.md`

## Global Constraints

- 本机（Linux, 1.7G 内存）无 Rust 工具链：**所有 `[Windows]` 标记步骤由主人在 Windows 机器执行**；本机交付后必须做静态自检（逐个新增标识符 grep import/定义存在性）并在汇报中声明"未经本地编译/类型检查"
- **禁止主动 git commit**：主人未授权提交，所有任务完成后保持工作区未提交状态（计划不含 commit 步骤）
- 基础配置 `tauri.conf.json`、`capabilities/`、前端 `src/`、seedagent 仓库**零改动**（验收红线：纯客户端/Android/dev 不受影响）
- 协议名固定 `seedui`，host 固定 `localhost`（Windows origin 判定要求域 == `<协议>.localhost`，不可换其他 host）
- 缓存语义与 web-static.ts 对齐：`/static/`（解析后真实路径前缀）→ `public, max-age=31536000, immutable`；其余（含 index.html）→ `no-cache`；全部响应带 `x-content-type-options: nosniff`
- 注释风格：中文、解释"为什么"，与仓库现有注释一致

## Review Focus

1. **percent-decode 后的路径穿越**（`/static/%2e%2e%2fsecret`）：必须拒绝，否则可读 web 目录外任意文件 → Task 1 测试 `resolve_web_file_rejects_*`
2. **`/static/` 未命中误走 SPA 回退**：返回 200+text/html 会让模块脚本报 MIME 错误掩盖真因 → Task 1 测试 `static_miss_404_not_fallback`
3. **双 URI 形态解析**：Windows handler 收到 `http://seedui.localhost/x`、非 Windows 收到 `seedui://localhost/x`，`http::Uri::path()` 两者都返回 `/x`（Task 2 契约注释；无本机测试，评审者人工确认）
4. **overlay windows 数组整体替换**：漏抄 `title/width/height/maximized/decorations` 会改变窗口行为 → Task 3 步骤要求与基础配置逐字段比对
5. **回退页可达性**：resources 缺失/目录被清时返回明确 404 页而非 panic/空白 → Task 1 测试 `missing_web_dir_404`

---

### Task 1: `src-tauri/src/ui.rs` — seedui 协议核心逻辑 + 单测

**Files:**
- Create: `src-tauri/src/ui.rs`（handler 纯逻辑 + `#[cfg(test)]` 单测；本任务不接线）
- Modify: `src-tauri/Cargo.toml`（依赖表按字母序加 `percent-encoding = "2"`，依赖树已有零成本）

**Interfaces:**
- Produces: `pub fn serve_from_web_dir(web_dir: Option<&std::path::Path>, raw_path: &str) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>>`（Task 2 的闭包调用它；返回值永远 200/404，不 panic）
- 内部纯函数：`fn web_mime(ext: &str) -> &'static str`、`fn resolve_web_file(web_dir: &Path, raw_path: &str) -> Option<PathBuf>`

- [ ] **Step 1: 写失败测试**（先写 `#[cfg(test)] mod tests`，镜像 server.rs 的 `temp_home` 临时目录模式；测试项：现有文件命中+MIME、`..` 段拒绝、percent 编码 `..`（`%2e%2e`）拒绝、反斜杠/NUL 拒绝、`/static/` 命中得 immutable 头、`/static/` 未命中得 404 且 body 非 HTML 回退、未知路径得 200+index.html+no-cache、`web_dir=None` 得 404 提示页）

```rust
// 测试骨架（断言必须具体到 status/header 值，如 cache_control == "public, max-age=31536000, immutable"）
#[test] fn serves_file_with_mime_and_nocache() {}
#[test] fn static_assets_get_immutable_cache() {}
#[test] fn static_miss_is_404_not_html_fallback() {}
#[test] fn spa_fallback_serves_index_html() {}
#[test] fn resolve_web_file_rejects_traversal_and_encoded_traversal() {}
#[test] fn resolve_web_file_rejects_backslash_and_nul() {}
#[test] fn missing_web_dir_returns_404_page() {}
```

- [ ] **Step 2: [Windows] 跑测试确认编译失败**：`cd src-tauri && cargo test ui::`，预期 FAIL（模块/函数未定义）。本机跳过（无工具链），由实施者静态确认测试引用的函数名与 Step 3 定义一致
- [ ] **Step 3: 实现 `ui.rs`**：MIME 表抄 `web-static.ts`（html/js/mjs/css/json/svg/png/jpg/jpeg/gif/webp/ico/woff/woff2/ttf/map/txt/wasm，charset 按 web-static）；`resolve_web_file` 流程 = `percent_decode_str` 解码 → 含 `\0`/`\` 拒绝 → 按 `/` 分段 → 任一段为 `..` 拒绝 → `web_dir.join(segments)` → `metadata().is_file()` 校验；`serve_from_web_dir` 决策序 = 文件命中 → 200（immutable 当且仅当解析后路径在 `web_dir/static/` 下）→ `/static/` 前缀未命中 → 404 text/plain → 其余 → index.html 200 no-cache → `web_dir=None` → 404 text/html 中文提示页（"UI 资源缺失…请重新安装/运行打包脚本"）。全部响应 `x-content-type-options: nosniff`。模块头注释说明协议定位与 web-static.ts 的语义对应关系
- [ ] **Step 4: [Windows] `cargo test ui::` 全绿**

### Task 2: `lib.rs` 接线 — 注册 seedui 协议

**Files:**
- Modify: `src-tauri/src/lib.rs`（`mod ui;` + builder 链上 `register_uri_scheme_protocol`，放在 `tauri::Builder::default()` 首个绑定之后、条件插件之前）
- Modify: `src-tauri/src/server.rs`（`fn resolve_server_dir` → `pub(crate) fn resolve_server_dir`，仅可见性）

**Interfaces:**
- Consumes: Task 1 的 `serve_from_web_dir`；`server::resolve_server_dir(&Path) -> Option<PathBuf>`
- Produces: 无（运行时行为：`seedui://localhost/<path>` 请求 → web 目录文件响应）

- [ ] **Step 1: 实现接线**：闭包内 `ctx.app_handle().path().resource_dir()`（失败回退 `PathBuf::from(".")`，与 server.rs `init` 同款写法）→ `resolve_server_dir` → `.map(|d| d.join("web"))` → `serve_from_web_dir(web_dir.as_deref(), request.uri().path())`。闭包上方注释写明：Windows 上请求 URI 形态为 `http://seedui.localhost/...`、非 Windows 为 `seedui://localhost/...`，`http::Uri::path()` 两者统一返回路径部分；每次请求重新解析（支持 `-HostUpdateServer` 热更新 UI，无缓存态）
- [ ] **Step 2: 静态自检**：grep 确认 `use tauri::Manager` 已存在（`path()` 需要）、`ui::serve_from_web_dir` 拼写一致、`resolve_server_dir` 可见性改动无其他调用点受影响；声明"本步骤未经编译验证"

### Task 3: 占位页 + bundled overlay

**Files:**
- Create: `src-tauri/ui-fallback/index.html`（内联极简样式中文提示页：UI 资源缺失/重装；无 JS）
- Modify: `src-tauri/tauri.bundled.conf.json`

**Interfaces:**
- Consumes: 无
- Produces: bundled 构建配置生效（`frontendDist: "ui-fallback"`、`beforeBuildCommand: ""`、窗口 `url: "seedui://localhost/index.html"`）

- [ ] **Step 1: 写 `ui-fallback/index.html`**（≤1KB）
- [ ] **Step 2: 改 overlay**：在现有 `bundle.resources` 基础上加 `build`（`beforeBuildCommand: ""`、`frontendDist: "ui-fallback"`）与 `app.windows`（**从 `tauri.conf.json` 逐字段抄** `title/width/height/maximized/decorations`，仅追加 `"url": "seedui://localhost/index.html"`；数组整体替换、漏字段即改变窗口行为）。注释（JSON 内 `//`，CLI 的 JSONC 解析已支持——参照 wrangler.jsonc 惯例？不：tauri.conf.json 是纯 JSON，**不加注释**，说明写在 package-desktop.ps1 里）
- [ ] **Step 3: 自检**：`node -e "JSON.parse(...)"` 校验两个 JSON 合法；diff 比对窗口字段与基础配置一致；确认 `"url"` 非 http(s) scheme 会落入 `WebviewUrl::CustomProtocol`（v2 config.rs 反序列化已核实）

### Task 4: `package-desktop.ps1` — tcs 前移 + 文档注释更新

**Files:**
- Modify: `scripts/package-desktop.ps1`（③.6 加 `npm run tcs`；更新 3 处过时注释）
- Modify: `构建指南.md`（仅当其中描述"前端嵌 exe/改前端必须全量打包/两次构建"时同步，grep 后定点更新）

- [ ] **Step 1: ③.6 前插入类型检查**：`Write-Host "==> tcs (type check)"` + `npm run tcs`（Push-Location $root 块内，失败 throw），注释说明：原由 tauri beforeBuildCommand 承担，overlay 置空后移到此处
- [ ] **Step 2: 更新注释**：头部【完整流程】③.6 与 `-HostUpdateServer` 两处"桌面 webview 前端编译时嵌在 exe 内，改前端必须走全量打包"改为"桌面 webview 经 seedui:// 协议加载 resources 内 web/，热更新同样覆盖桌面 UI"；④ 的 `--config` 注释补一句 frontendDist=占位页/beforeBuildCommand 置空的说明
- [ ] **Step 3: `grep 构建指南.md`** 定点同步（若提及）
- [ ] **Step 4: PowerShell 语法静态自检**（本机无 pwsh 则人工逐段核对；不执行脚本）

### Task 5: 交付自检 + Windows 验收清单

- [ ] **Step 1: 全量静态自检**：本轮所有新增标识符（`serve_from_web_dir`/`web_mime`/`resolve_web_file`/`mod ui`/percent-encoding 依赖）grep 定义与引用一致；`git status` 确认改动面 = 计划 Files 清单（无越界文件）；设计文档状态改"已实施"
- [ ] **Step 2: 输出 Windows 验收清单给主人**：① `cd src-tauri && cargo test`（ui:: + server:: 全绿）；② `-StageOnly` 后 `npm run stage`：窗口经 seedui 加载 UI、invoke（复制/通知/分享）正常、monaco/mermaid/pdfjs 正常；③ 全量打包便携版：启动正常、`seedcode.exe` 体积显著缩小（不再含前端）；④ 服务端 kill 后 UI 错误页/重启按钮可用；⑤ `-HostUpdateServer` 改前端 → 桌面 UI 热更新生效；⑥ `build_windows.ps1`/`build_android.ps1` 各跑一次照旧
