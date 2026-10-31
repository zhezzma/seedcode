use std::path::PathBuf;
use tauri::{Manager, WindowEvent};

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

mod notify;
mod server;
mod ui;

// Windows 原生 Toast 的 AUMID 快捷方式自愈注册（仅桌面 Windows 编译）
#[cfg(target_os = "windows")]
mod win_toast;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// 原生剪贴板写入。WebView 的 navigator.clipboard 异步写入会被 Windows
// 剪贴板历史服务（Win+V）排除，前端复制统一走这两个命令；
// 移动端不支持原生写入，返回错误由前端回退 WebView API。
#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .map_err(|err| err.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = text;
        Err("write_clipboard_text is only supported on desktop".into())
    }
}

#[tauri::command]
fn write_clipboard_image(rgba: Vec<u8>, width: usize, height: usize) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let image = arboard::ImageData {
            width,
            height,
            bytes: std::borrow::Cow::Owned(rgba),
        };
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_image(image))
            .map_err(|err| err.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = (rgba, width, height);
        Err("write_clipboard_image is only supported on desktop".into())
    }
}

// 选中复制（Ctrl+C / 右键菜单）拦截后用的富文本写入：text + html 双格式，
// 粘贴到支持 HTML 的目标不失格式。见 src/utils/clipboard.ts 的 installNativeCopyInterceptor。
#[tauri::command]
fn write_clipboard_html(text: String, html: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_html(html, Some(text)))
            .map_err(|err| err.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = (text, html);
        Err("write_clipboard_html is only supported on desktop".into())
    }
}

// 把分享用图片落盘到 app 缓存的 share/ 子目录，返回绝对路径（供 sharekit shareFile 的 file:// URL）。
// 不走 fs 插件：其 scope 的 $CACHE 在 Android 解析到外部缓存（getExternalCacheDir），与
// app_cache_dir（内部 getCacheDir）是两个目录，写必 forbidden path；自家命令不经插件权限面。
// 必须写 share/ 子目录而非缓存根：sharekit Android 侧会把源文件拷到 cacheDir 根下的同名
// 临时文件再转 content://，同名同目录会先 truncate 源文件再自拷贝，分享出去的是 0 字节空图。
// base64 而非字节数组走 IPC：JSON 数组每字节膨胀 3-4 倍，base64 串更省（data URL 本就是 base64）。
#[tauri::command]
fn write_share_cache_file(
    app: tauri::AppHandle,
    file_name: String,
    base64_data: String,
) -> Result<String, String> {
    use base64::Engine as _;
    // JS 层已消毒，这里再兜底一次防路径穿越（join 不规范化 ..）
    let safe_name: String = file_name.replace(['/', '\\'], "_");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|err| err.to_string())?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join("share");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    cleanup_stale_share_files(&dir);
    let path = dir.join(safe_name);
    std::fs::write(&path, bytes).map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// 清理 share/ 子目录下超过 7 天的旧分享文件：data URL 图按时间戳命名，每次重开 lightbox
// 都会落新文件，跨会话无限累积且 Android 系统清理不可靠。失败静默跳过，不阻断分享。
fn cleanup_stale_share_files(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let is_stale = entry
            .metadata()
            .ok()
            .filter(|meta| meta.is_file())
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(7 * 24 * 60 * 60));
        if is_stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// 在系统终端中打开指定目录（桌面端专属）。文件由前端传其所在父目录（终端只能 cd 进目录）。
// 仅 local 网关模式下展示：此时 workspace/agent 目录就在本机，remote 模式路径不在本机无意义。
#[tauri::command]
fn open_in_terminal(path: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        open_terminal_at(&path)
    }
    #[cfg(mobile)]
    {
        let _ = path;
        Err("open_in_terminal is only supported on desktop".into())
    }
}

// 仅桌面编译。各平台终端启动器与「起始目录」参数不同，分平台实现。
#[cfg(desktop)]
fn open_terminal_at(path: &str) -> Result<(), String> {
    let dir = std::path::Path::new(path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：中间 cmd.exe 自身不闪黑框；`start` 仍会用
        // CREATE_NEW_CONSOLE 为目标 cmd 开新窗口，不受该标志影响。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // PowerShell 本体就是最终可见窗口（不同于 wt/cmd start 的“秒退中间层”）——
        // 挂 CREATE_NO_WINDOW 会把交互式 PS 藏进不可见控制台，用户点了毫无反应。
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // MSVC 命令行规则的手动引号包裹：raw_arg 原样拼接，路径尾部若有反斜杠
        // 必须翻倍，否则收尾的 \" 会被解析成字面引号而非参数结束（如 C:\ 盘根）。
        fn quote_msvc(s: &str) -> String {
            let trailing = s.len() - s.trim_end_matches('\\').len();
            format!("\"{}{}\"", s, "\\".repeat(trailing))
        }
        // Windows Terminal 优先（Win11 默认终端，遵循用户默认 profile，如 PowerShell）；
        // wt 不在 PATH（典型 Win10 / 未安装）时 spawn 失败 → 回落经典 cmd 窗口。
        // 路径必须手动引号包住（raw_arg）：wt 会按自家规则二次解析命令行，`;` 是其命令
        // 分隔符（NTFS 目录名合法字符），不引号会被拆成两条 wt 命令；双引号在 Windows
        // 文件名中非法，手动包裹无歧义。
        if std::process::Command::new("wt")
            .arg("-d")
            .raw_arg(quote_msvc(path))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        // cmd.exe 无法以 UNC 目录（\\server\share / \\wsl.localhost\…）为工作目录：
        // 静默退回 %WINDIR%，终端开在错误位置。wt 已缺席才走到这里（wt 对 UNC 没问题），
        // UNC 路径改回落 PowerShell（支持 UNC cwd）；单引号字面量 + PS 转义防空格/分号拆词。
        if path.starts_with("\\\\") {
            let located = format!("Set-Location -LiteralPath '{}'", path.replace('\'', "''"));
            std::process::Command::new("powershell")
                .args(["-NoExit", "-Command"])
                .raw_arg(quote_msvc(&located))
                .creation_flags(CREATE_NEW_CONSOLE)
                .spawn()
                .map_err(|err| err.to_string())?;
            return Ok(());
        }
        std::process::Command::new("cmd")
            .current_dir(dir)
            .args(["/C", "start", "", "cmd"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        // open -a Terminal <dir>：Terminal.app 新开窗口并 cd 到该目录。
        // open 自身是个秒退的 LaunchServices 委托客户端：detach 线程 wait() 回收，
        // 否则变僵尸进程活到应用退出。
        match std::process::Command::new("open")
            .args(["-a", "Terminal", path])
            .spawn()
        {
            Ok(child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                Ok(())
            }
            Err(err) => Err(err.to_string()),
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux：按市占常见终端逐个尝试（各家的「起始目录」参数不同），
        // spawn 成功即用；全部缺失时报错由前端 toast 提示。
        const CANDIDATES: &[(&str, &[&str])] = &[
            ("gnome-terminal", &["--working-directory"]),
            ("konsole", &["--workdir"]),
            ("xfce4-terminal", &["--working-directory"]),
            ("alacritty", &["--working-directory"]),
            ("kitty", &["--directory"]),
            ("wezterm", &["start", "--cwd"]),
            ("tilix", &["--working-directory"]),
        ];
        for (program, args) in CANDIDATES {
            // spawn 成功 ≠ 窗口出现：gnome-terminal 这类 D-Bus 客户端会秒退委托，
            // 无 DISPLAY/损坏安装也会 spawn 成功后立刻退出。detach 线程 wait() 回收
            // 子进程防僵尸；秒退场景用户看不到窗口，属可接受降级（逐个候选已尽力）。
            if let Ok(child) = std::process::Command::new(program)
                .args(*args)
                .arg(path)
                .spawn()
            {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
        }
        Err("no supported terminal emulator found in PATH".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // seedui:// 协议（bundled 版桌面 UI 入口，实现见 ui.rs）：把窗口请求映射到
    // resources/seedagent/web 静态文件。Windows WebView2 把自定义协议请求映射为
    // http://seedui.localhost/...、非 Windows 为 seedui://localhost/...，
    // http::Uri::path() 对两者统一返回路径部分，无需区分。
    // 用异步版注册：同步版 handler 在 Windows 上于 UI 线程执行（WebResourceRequested），
    // monaco 这类几十资源的页面/杀毒扫描/热更新替换文件的窗口期，阻塞式 fs::read
    // 会卡住整个窗口事件循环；改异步 + 工作线程后，每请求重新解析 web 目录的
    // 热更新语义不变（线程里解析，无缓存状态）。UI 目录探针查 web/index.html
    // 而非 node.exe（与服务端目录判定解耦）：杀软隔离 node.exe 而 web/ 完好时
    // UI 仍可加载，由前端自身呈现服务端连接失败态，而非误导性的"资源缺失"诊断页。
    // 未打包服务端的构建（纯客户端/Android）目录不存在，handler 返回 404 提示页，
    // 但那些构建的窗口走嵌入资产，不会请求本协议。
    let builder =
        tauri::Builder::default().register_asynchronous_uri_scheme_protocol("seedui", |ctx, request, responder| {
            // AppHandle 的 clone 是 Arc 级轻量、UriSchemeResponder 内部为 Send 闭包，
            // 两者与 request 都可安全 move 进工作线程交付
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .unwrap_or_else(|_| PathBuf::from("."));
                let web_dir = crate::server::resolve_seedagent_dir(&resource_dir, "web/index.html")
                    .map(|d| d.join("web"));
                let resp = ui::serve_from_web_dir(web_dir.as_deref(), request.uri().path());
                responder.respond(resp);
            });
        });

    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // When a second instance is launched, show and focus the existing window
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notifications::init())
        .plugin(tauri_plugin_sharekit::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 便携版/dev 无安装器：启动时自愈 Windows Toast 身份与激活链路——
            // ① 开始菜单 AUMID 快捷方式（否则系统通知被 Windows 静默拒绝）；
            // ② COM activator + 注册表（否则通知中心点击历史通知无反应）。
            // 内部失败仅记日志，不阻断启动
            #[cfg(target_os = "windows")]
            win_toast::setup(app.handle());

            #[cfg(desktop)]
            if cfg!(desktop) {
                let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .build(app)?;
            }

            app.manage(notify::init(app.handle()));
            let server_manager = server::init(app.handle());
            app.manage(server_manager);
            server::start_background(app.handle());
            Ok(())
        })
        .on_window_event(|_window, event| match event {
            #[cfg(desktop)]
            WindowEvent::CloseRequested { api, .. } => {
                _window.hide().unwrap();
                api.prevent_close();
            }
            #[cfg(not(desktop))]
            WindowEvent::CloseRequested { .. } => {}
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            write_clipboard_text,
            write_clipboard_image,
            write_clipboard_html,
            write_share_cache_file,
            open_in_terminal,
            notify::notify_connect,
            notify::notify_disconnect,
            notify::notify_send,
            server::server_status,
            server::server_restart
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                server::shutdown(app);
            }
        });
}
