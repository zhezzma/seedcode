/// ui.rs — seedui:// 自定义协议：桌面 webview 从 resources/seedagent/web 加载前端。
///
/// bundled 桌面构建不再把前端嵌进 exe（frontendDist 指向仓库内占位页 ui-fallback/，
/// 仅为满足 tauri 必填），窗口 url 指向 seedui://localhost/index.html。本模块把该
/// 协议的请求映射到 staging/部署目录的 web/ 静态文件，桌面 webview 与内置服务端
/// （移动端隧道）共用同一份前端产物，-HostUpdateServer 热更新因此同时覆盖桌面 UI。
///
/// 决策序与 seedagent 服务端 web-static.ts 对齐（改这里请同步看齐，避免两端行为漂移）：
/// - 命中 web/ 内真实文件 → 按扩展名 MIME 直出；/static/（vite 哈希产物）长缓存，
///   其余（含 index.html）no-cache
/// - /static/* 未命中 → 直接 404：返回 200+text/html 会让模块脚本报 MIME 错误，
///   掩盖"发版后旧 chunk 已清理"的真实原因
/// - 其余未命中路径 → index.html（SPA history 路由回退）
/// - web 目录缺失（占位页兜底场景）→ 404 提示页
/// 服务端 web-static.ts 的 /api、/assets、/ws 保留前缀在此不适用：那些路径只走
/// HTTP 服务端，永远不会以 seedui:// 协议到达本 handler。
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use tauri::http::{Response, StatusCode};

/// 扩展名 → Content-Type，逐项对齐 web-static.ts MIME_TYPES（缺省 application/octet-stream）。
fn web_mime(ext: &str) -> &'static str {
    match ext {
        ".html" => "text/html; charset=utf-8",
        ".js" | ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" | ".map" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".ico" => "image/x-icon",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".ttf" => "font/ttf",
        ".txt" => "text/plain; charset=utf-8",
        ".wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// web 目录缺失时的 404 提示页（bundled 版 resources 丢失/被清的兜底，正常流程不可达）。
const MISSING_WEB_DIR_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>seedcode</title></head>
<body style="font-family:system-ui;padding:40px;color:#333">
<h2>UI 资源缺失</h2>
<p>未找到前端资源目录（resources/seedagent/web）。请重新运行打包脚本或重装应用。</p>
</body></html>"#;

/// percent-decode 后安全解析 web 目录内文件；越界/非文件/不存在返回 None。
///
/// 防穿越（对齐 web-static.ts 并加 Windows 特有防御）：
/// - 解码后含 NUL / 反斜杠 → 拒绝（反斜杠在 Windows 是分隔符，`/a%5C..%5C..` 类
///   变形必须拦在解析前）
/// - 逐段拼接，任一段为 `..` → 拒绝；段内含 `:` → 拒绝：Windows 上 `Path::join`
///   遇到 `C:` 这类盘符前缀段会**清空已有路径整体替换**（std 对 prefix 组件的特殊
///   处理），光靠 starts_with 终检不够直觉，这里显式拒绝更稳；段尾以 `.`/空格结尾
///   → 拒绝：Win32 规范化会剥离段尾这两类字符（".. "/"..." 在 OS 层等价 ".."）
/// - 拼接结果必须仍以 web_dir 为前缀（组件级 starts_with，兜底双保险）
fn resolve_web_file(web_dir: &Path, raw_path: &str) -> Option<PathBuf> {
    // 非法 %XX 序列 percent-encoding 会原样保留（不报错），后续按不存在文件处理即可
    let decoded = percent_encoding::percent_decode_str(raw_path).decode_utf8_lossy();
    if decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    let mut candidate = web_dir.to_path_buf();
    for segment in decoded.trim_start_matches('/').split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        // Win32 路径规范化会剥离每段末尾的 '.'/' '（".. "/"..." 在 OS 层等价 ".."），
        // 字面量 == ".." 检查拦不住这类变形，必须按段尾字符拒绝；
        // vite 产物段名从不以 '.'/空格结尾，合法请求不受影响
        if segment == ".."
            || segment.contains(':')
            || segment.ends_with('.')
            || segment.ends_with(' ')
        {
            return None;
        }
        candidate.push(segment);
    }
    // 兜底：拼接结果必须仍在 web_dir 内（组件级比较，非字符串前缀）
    if !candidate.starts_with(web_dir) {
        return None;
    }
    if !candidate.is_file() {
        return None;
    }
    Some(candidate)
}

fn build_response(status: StatusCode, content_type: &'static str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        // 禁 MIME 嗅探（对齐 web-static.ts：产物直发，防内容被误判为可执行类型）
        .header("x-content-type-options", "nosniff")
        .body(Cow::Owned(body))
        .expect("static response parts are always valid")
}

/// seedui 协议请求入口。
///
/// `raw_path` 是请求 URL 的路径部分（含 percent 编码）。lib.rs 的协议闭包传入
/// `http::Uri::path()`：Windows WebView2 上自定义协议请求形如
/// `http://seedui.localhost/...`、非 Windows 形如 `seedui://localhost/...`，
/// `Uri::path()` 对两者统一返回路径部分，本函数无需区分来源形态。
pub fn serve_from_web_dir(web_dir: Option<&Path>, raw_path: &str) -> Response<Cow<'static, [u8]>> {
    // resolve_server_dir 只看 seedagent 根（node.exe 等），不校验 web/ 本身：
    // 部分热更新/运行中被清等状态下目录对但 web 缺失，必须也落到诊断页，
    // 否则用户只看到裸 "404 Not Found"，不知道是资源丢了（多一次 stat，可忽略）
    let Some(web_dir) = web_dir.filter(|d| d.join("index.html").is_file()) else {
        return build_response(
            StatusCode::NOT_FOUND,
            "text/html; charset=utf-8",
            MISSING_WEB_DIR_PAGE.as_bytes().to_vec(),
        );
    };

    // 命中真实文件 → 直出；缓存键基于解析后的真实路径：只有解析结果位于
    // web_dir/static/ 下才打 immutable 长缓存（意图对齐 web-static.ts；注意本实现
    // 遇 `..` 段直接拒绝走 404/SPA 分支，不像 TS 侧那样把 /static/../x 解析成真实路径，
    // 防止变形路径绕过长缓存判定）
    if let Some(file) = resolve_web_file(web_dir, raw_path) {
        let ext = file
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mime = web_mime(&ext);
        let cache_control = if file.starts_with(web_dir.join("static")) {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        match std::fs::read(&file) {
            Ok(bytes) => {
                // stat 与 read 之间存在窗口（热更新替换/权限变化）：读失败按 404 处理
                return Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", mime)
                    .header("cache-control", cache_control)
                    .header("x-content-type-options", "nosniff")
                    .body(Cow::Owned(bytes))
                    .expect("static response parts are always valid");
            }
            Err(_) => {
                return build_response(
                    StatusCode::NOT_FOUND,
                    "text/plain; charset=utf-8",
                    b"404 Not Found".to_vec(),
                )
            }
        }
    }

    // /static/ 前缀未命中 → 404（不走 SPA 回退，见模块头注释）
    if raw_path.starts_with("/static/") {
        return build_response(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"404 Not Found".to_vec(),
        );
    }

    // SPA history 路由回退 → index.html（no-cache 保证热更新后立即生效：
    // 无显式指令时 webview 可能启发式缓存，旧 index.html 引用已删除的 /static/ chunk）
    match std::fs::read(web_dir.join("index.html")) {
        Ok(index) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html; charset=utf-8")
            .header("cache-control", "no-cache")
            .header("x-content-type-options", "nosniff")
            .body(Cow::Owned(index))
            .expect("static response parts are always valid"),
        Err(_) => build_response(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"404 Not Found".to_vec(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时 web 目录：index.html + static/app.HASH.js + favicon.svg；
    /// 目录外放 secret.txt 用于证明穿越被拒绝（而非"文件恰好不存在"）。
    fn temp_web(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("seedcode-ui-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let web = root.join("web");
        std::fs::create_dir_all(web.join("static")).unwrap();
        std::fs::write(web.join("index.html"), b"<html>index</html>").unwrap();
        std::fs::write(web.join("static").join("app.HASH.js"), b"// js").unwrap();
        std::fs::write(web.join("favicon.svg"), b"<svg/>").unwrap();
        std::fs::write(root.join("secret.txt"), b"secret").unwrap();
        (root, web)
    }

    fn header<'a>(resp: &'a Response<Cow<'static, [u8]>>, name: &str) -> &'a str {
        resp.headers().get(name).unwrap().to_str().unwrap()
    }

    #[test]
    fn serves_file_with_mime_and_nocache() {
        let (_root, web) = temp_web("mime");
        let resp = serve_from_web_dir(Some(&web), "/favicon.svg");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(header(&resp, "content-type"), "image/svg+xml");
        // 非 /static/ 文件一律 no-cache（对齐 web-static.ts）
        assert_eq!(header(&resp, "cache-control"), "no-cache");
        assert_eq!(header(&resp, "x-content-type-options"), "nosniff");
        assert_eq!(resp.body().as_ref(), b"<svg/>");
        let _ = std::fs::remove_dir_all(&_root);
    }

    #[test]
    fn static_assets_get_immutable_cache() {
        let (_root, web) = temp_web("immutable");
        let resp = serve_from_web_dir(Some(&web), "/static/app.HASH.js");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(header(&resp, "content-type"), "text/javascript; charset=utf-8");
        assert_eq!(header(&resp, "cache-control"), "public, max-age=31536000, immutable");
        let _ = std::fs::remove_dir_all(&_root);
    }

    #[test]
    fn static_miss_is_404_not_html_fallback() {
        let (_root, web) = temp_web("static-miss");
        let resp = serve_from_web_dir(Some(&web), "/static/missing.HASH.js");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        // 绝不能回退 HTML：模块脚本收到 200+text/html 会报 MIME 错误掩盖真因
        assert!(!header(&resp, "content-type").starts_with("text/html"));
        assert!(std::str::from_utf8(resp.body()).unwrap().find('<').is_none());
        let _ = std::fs::remove_dir_all(&_root);
    }

    #[test]
    fn spa_fallback_serves_index_html() {
        let (_root, web) = temp_web("spa");
        let resp = serve_from_web_dir(Some(&web), "/chat/abc");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(header(&resp, "content-type"), "text/html; charset=utf-8");
        assert_eq!(header(&resp, "cache-control"), "no-cache");
        assert_eq!(resp.body().as_ref(), b"<html>index</html>");
        let _ = std::fs::remove_dir_all(&_root);
    }

    #[test]
    fn resolve_web_file_rejects_traversal_and_encoded_traversal() {
        let (root, web) = temp_web("traversal");
        // secret.txt 在 web 目录外真实存在：返回 None 才证明是"拒绝"而非"未找到"
        assert!(root.join("secret.txt").is_file());
        assert!(resolve_web_file(&web, "/../secret.txt").is_none());
        assert!(resolve_web_file(&web, "/%2e%2e/secret.txt").is_none());
        assert!(resolve_web_file(&web, "/static/%2e%2e%2f..%2fsecret.txt").is_none());
        assert!(resolve_web_file(&web, "//..//secret.txt").is_none());
        // 正常路径不受影响
        assert_eq!(resolve_web_file(&web, "/index.html"), Some(web.join("index.html")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_web_file_rejects_backslash_and_nul() {
        let (root, web) = temp_web("backslash");
        // %5C = 反斜杠（Windows 分隔符变形）、%00 = NUL
        assert!(resolve_web_file(&web, "/..%5Csecret.txt").is_none());
        assert!(resolve_web_file(&web, "/index.html%00.txt").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_web_file_rejects_windows_drive_segment() {
        let (root, web) = temp_web("drive");
        // Windows 上 join 遇盘符前缀段会整体替换路径（std 对 prefix 组件的特殊处理），
        // 必须显式拒绝；Linux 上同样拒绝，行为跨平台一致
        assert!(resolve_web_file(&web, "/C:/Windows/system32/config").is_none());
        assert!(resolve_web_file(&web, "/c:/x").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_web_file_rejects_trailing_dot_space_variants() {
        let (root, web) = temp_web("win32-norm");
        assert!(root.join("secret.txt").is_file());
        // Win32 路径规范化会剥离段尾 '.'/' '：".. "/"..." 在 OS 层等价 ".."，
        // 字面量 == ".." 检查拦不住，必须按段尾字符拒绝
        assert!(resolve_web_file(&web, "/..%20/secret.txt").is_none());
        assert!(resolve_web_file(&web, "/.../secret.txt").is_none());
        assert!(resolve_web_file(&web, "/..%2E/secret.txt").is_none()); // 解码后 "..."
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_web_dir_returns_404_page() {
        let resp = serve_from_web_dir(None, "/");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(header(&resp, "content-type").starts_with("text/html"));
        let body = std::str::from_utf8(resp.body()).unwrap();
        assert!(body.contains("UI 资源缺失"));
    }

    #[test]
    fn web_dir_without_index_shows_diagnostic_page() {
        // seedagent 根在但 web/ 缺 index.html（部分热更新/运行期被清）：诊断页也必须
        // 可达，不能只依赖 lib.rs 传入 None 的分支（否则用户只看到裸 404 文本）
        let root = std::env::temp_dir().join(format!("seedcode-ui-test-noidx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let web = root.join("web");
        std::fs::create_dir_all(&web).unwrap();
        let resp = serve_from_web_dir(Some(&web), "/chat/abc");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(header(&resp, "content-type").starts_with("text/html"));
        assert!(std::str::from_utf8(resp.body()).unwrap().contains("UI 资源缺失"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
