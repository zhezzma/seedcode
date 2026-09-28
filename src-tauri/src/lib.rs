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
