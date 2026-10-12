use tauri::{Manager, WindowEvent};

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

mod notify;
mod server;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

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
