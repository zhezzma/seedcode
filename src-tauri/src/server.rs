use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 从 dir/.env 中读取 key 的首个定义（简易解析，dotenv 子集：
/// 键值两边容忍空格；未加引号的值遇 # 截断行内注释；配对引号包裹则整体为值、
/// 内部 # 不算注释；桌面端只读不写该文件）。
fn read_env_value(dir: &Path, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(dir.join(".env")).ok()?;
    for line in content.lines() {
        let line = line.trim();
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != key {
            continue;
        }
        let v = v.trim_start();
        let v = if v.starts_with('"') || v.starts_with('\'') {
            let quote = v.chars().next().unwrap();
            match v[1..].find(quote) {
                Some(i) => &v[1..1 + i], // 配对闭引号内是值，内部 # 不算注释
                None => v.split('#').next().unwrap_or("").trim(), // 无闭引号：退化为无引号处理
            }
        } else {
            v.split('#').next().unwrap_or("").trim()
        };
        return Some(v.to_string());
    }
    None
}

/// 从 <exe 目录>/.env 解析用户显式指定的 PORT 意向（客户端配置文件，与 DATA_DIR 同源；
/// 数据目录下的 .env 属服务端，客户端不读）。
pub fn read_env_port(exe_dir: &Path) -> Option<u16> {
    read_env_value(exe_dir, "PORT")?.parse::<u16>().ok()
}

/// 从 <exe 目录>/.env 读取 DATA_DIR 覆盖（便携模式入口；空值视为未定义）。
fn read_env_data_dir(exe_dir: &Path) -> Option<String> {
    read_env_value(exe_dir, "DATA_DIR").filter(|v| !v.is_empty())
}

/// 把 .env 里的 DATA_DIR 原始值解析成绝对路径：
/// 绝对路径直接用；相对路径相对 exe_dir（便携语义：DATA_DIR=data → <exe 目录>\\data）；
/// 支持 ~/ 前缀展开（与服务端 paths.ts 约定一致）。
fn resolve_data_dir(exe_dir: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    if raw == "~" {
        return home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        exe_dir.join(p)
    }
}

/// 数据目录决策：<exe 目录>/.env 的 DATA_DIR 覆盖优先；否则默认 ~/.seedcode。
/// dev（tauri dev）默认改用 ~/.seedcode-dev：与打包版隔离数据/凭据/日志，
/// 使两者可并行运行互不干扰（用户仍可用 .env 的 DATA_DIR 显式指向任意目录）。
fn resolve_default_data_dir(exe_dir: Option<&Path>, dev: bool) -> PathBuf {
    exe_dir
        .and_then(|d| read_env_data_dir(d).map(|raw| resolve_data_dir(d, &raw)))
        .unwrap_or_else(|| home_dir().join(if dev { ".seedcode-dev" } else { ".seedcode" }))
}

/// 端口候选：用户意向优先，随后 18789~18798（去重）。
/// dev（tauri dev）用独立区间 18889~18898：服务端 /api/health 免鉴权，
/// probe_port 无法靠 token 区分“本版本实例”与“打包版实例”，
/// 若共用区间，dev 会把打包版正在运行的服务端误判为 Ours 而复用（联调错代码）、
/// 退出时还会把它杀掉——区间隔离从结构上杜绝跨版本互探。
pub fn port_candidates(preferred: Option<u16>, dev: bool) -> Vec<u16> {
    let mut out = Vec::new();
    if let Some(p) = preferred {
        out.push(p);
    }
    let range = if dev { 18889..=18898 } else { 18789..=18798 };
    for p in range {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// 读取/生成 <数据目录>/desktop.json 的 bearerToken（uuid v4），首次生成后固定复用。
pub fn load_or_create_token(data_dir: &Path) -> String {
    let file = data_dir.join("desktop.json");
    if let Ok(content) = std::fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(token) = v.get("bearerToken").and_then(|t| t.as_str()) {
                if !token.trim().is_empty() {
                    return token.to_string();
                }
            }
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(data_dir);
    let json = serde_json::json!({ "bearerToken": token });
    let _ = std::fs::write(&file, serde_json::to_string_pretty(&json).unwrap());
    token
}

const INTENT_RUN: u8 = 0;
const INTENT_RESTART: u8 = 1;
const INTENT_STOP: u8 = 2;

#[derive(Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServerPhase {
    Starting,
    Running,
    Restarting,
    Failed,
    Unavailable,
}

#[derive(Clone, Serialize)]
pub struct ServerStatus {
    pub bundled: bool,
    pub state: ServerPhase,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub token: Option<String>,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
    /// 数据目录（默认 ~/.seedcode，可被 <exe 目录>/.env 的 DATA_DIR 覆盖）绝对路径，供前端状态展示
    pub data_dir: Option<String>,
}

pub struct ServerManager {
    bundled: bool,
    data_dir: PathBuf,
    /// exe 所在目录：<exe 目录>/.env 是客户端配置文件（DATA_DIR/PORT），init 时定死
    exe_dir: Option<PathBuf>,
    server_dir: Option<PathBuf>,
    token: String,
    status: Mutex<ServerStatus>,
    intent: AtomicU8,
    /// 监控线程存活标志：run_loop 启动置位、所有退出路径复位；request_restart 据此判断可否重开监控
    monitor_running: AtomicBool,
    /// 复用残留实例（探测 Ours，无子进程句柄）时通过 netstat 探得的监听 pid，
    /// 仅供退出时清理；不写 status.pid（避免误导 request_restart 走监控重拉分支）
    reused_pid: AtomicU32,
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// resources/seedagent 里的 node 可执行文件名（非 Windows 平台也要能编译，本期只打 Windows 包）。
#[cfg(target_os = "windows")]
fn node_binary_name() -> &'static str {
    "node.exe"
}

#[cfg(not(target_os = "windows"))]
fn node_binary_name() -> &'static str {
    "node"
}

/// server 目录候选，覆盖四种形态：
/// 1. NSIS 安装目录（tauri.conf resources 映射保留源相对路径 → <install>/resources/seedagent）
/// 2. 便携/其他打包布局（<exe_dir>/seedagent）
/// 3. dev（cwd=仓库根，staging 到 src-tauri/resources/seedagent）
/// 4. dev（cwd=src-tauri，staging 原地生效 → cwd/resources/seedagent）
fn resolve_server_dir(resource_dir: &Path) -> Option<PathBuf> {
    [
        resource_dir.join("resources").join("seedagent"),
        resource_dir.join("seedagent"),
        std::env::current_dir()
            .unwrap_or_default()
            .join("src-tauri")
            .join("resources")
            .join("seedagent"),
        std::env::current_dir()
            .unwrap_or_default()
            .join("resources")
            .join("seedagent"),
    ]
    .into_iter()
    .find(|d| d.join(node_binary_name()).exists())
}

impl ServerManager {
    pub fn status(&self) -> ServerStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn set_intent_restart(&self) {
        self.intent.store(INTENT_RESTART, Ordering::SeqCst);
    }

    pub fn set_intent_stop(&self) {
        self.intent.store(INTENT_STOP, Ordering::SeqCst);
    }

    /// 前端「重启服务」按钮：
    /// - Running（有 pid）：置 RESTART 意图并杀树，监控线程感知后立即重拉（计数/退避复位）；
    /// - Failed 终态（无 pid、监控已退出）：认领存活标志并重开监控线程，回到启动序列（重新探测端口 + spawn）；
    /// - Restarting 退避窗口（无 pid、监控存活）：仅广播当前状态（≤15s 内已计划重拉）；
    /// - 复用孤儿实例（无 pid、监控已退出、Running）：v1 限制——仅广播状态，不强制动作。
    pub fn request_restart(&self, app: &AppHandle) {
        let st = self.status.lock().unwrap().clone();
        if !st.bundled {
            return;
        }
        if let Some(pid) = st.pid {
            self.set_intent_restart();
            kill_tree(pid);
            return;
        }
        if st.state == ServerPhase::Failed
            && self
                .monitor_running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            // Failed 恢复：清意图为 RUN，重开监控线程（run_loop 会重新探测端口并 spawn）
            self.intent.store(INTENT_RUN, Ordering::SeqCst);
            let app = app.clone();
            std::thread::spawn(move || run_loop(app));
        } else {
            // Restarting 退避窗口内监控仍存活（已计划重拉）；复用孤儿实例为 v1 已知限制：均仅广播当前状态
            emit_status(app, &st);
        }
    }

    fn update_status(&self, app: Option<&AppHandle>, mutate: impl FnOnce(&mut ServerStatus)) {
        let st = {
            let mut guard = self.status.lock().unwrap();
            mutate(&mut guard);
            guard.clone()
        };
        if let Some(app) = app {
            emit_status(app, &st);
        }
    }
}

fn emit_status(app: &AppHandle, st: &ServerStatus) {
    let _ = app.emit("server://status", st);
}

/// Windows 下杀进程树（seedagent 会派生 subagent 子进程）。
#[cfg(target_os = "windows")]
pub fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
}

#[cfg(not(target_os = "windows"))]
pub fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

/// setup 钩子调用：检测 bundled、准备 token；spawn/监控由 Task 3 的 start_background 接管。
pub fn init(app: &AppHandle) -> ServerManager {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let server_dir = resolve_server_dir(&resource_dir);
    let bundled = server_dir.is_some();
    // ⚠ 勿用 app.path().executable_dir()：Tauri 只是 dirs::executable_dir() 的薄包装，
    // 而 dirs 在 Windows 上恒返回 None（文档表格明确 Windows 列为 –）——
    // 会导致 .env 永远不被读取。改用 current_exe（GetModuleFileNameW，Windows 可靠）。
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    // dev（tauri dev）与打包版并行运行：数据目录默认 ~/.seedcode-dev、端口用独立区间，
    // 详见 resolve_default_data_dir / port_candidates 注释
    let dev = tauri::is_dev();
    let data_dir = resolve_default_data_dir(exe_dir.as_deref(), dev);
    // 诊断：确认 .env 加载链路（exe_dir → .env → DATA_DIR/PORT → 最终 data_dir）。
    // 落到 tauri-plugin-log（%LOCALAPPDATA%\{identifier}\logs）；
    // 只记本约定键的解析值，不转储文件全文（防用户把敏感键写进 .env 后随日志落盘）
    log::info!(
        "[server][diag] dev={} exe_dir={:?} env_exists={} DATA_DIR={:?} PORT={:?} data_dir={:?}",
        dev,
        exe_dir,
        exe_dir.as_deref().map(|d| d.join(".env").exists()).unwrap_or(false),
        exe_dir.as_deref().and_then(|d| read_env_value(d, "DATA_DIR")),
        exe_dir.as_deref().and_then(|d| read_env_value(d, "PORT")),
        data_dir
    );

    let token = if bundled { load_or_create_token(&data_dir) } else { String::new() };

    let status = Mutex::new(ServerStatus {
        bundled,
        state: if bundled {
            ServerPhase::Starting
        } else {
            ServerPhase::Unavailable
        },
        port: None,
        url: None,
        token: if bundled { Some(token.clone()) } else { None },
        pid: None,
        last_error: None,
        data_dir: if bundled { Some(data_dir.to_string_lossy().into_owned()) } else { None },
    });

    ServerManager {
        bundled,
        data_dir,
        exe_dir,
        server_dir,
        token,
        status,
        intent: AtomicU8::new(INTENT_RUN),
        monitor_running: AtomicBool::new(false),
        reused_pid: AtomicU32::new(0),
    }
}

/// 应用退出（RunEvent::Exit / 托盘 quit）时调用。
/// 注意：本函数并非唯一保障——spawn 的子进程已绑 Windows Job Object
/// （KILL_ON_JOB_CLOSE），父进程任何方式退出（崩溃/被强杀/Ctrl+C）内核都会
/// 收掉整个 node 进程树；此处 taskkill 是正常退出路径的显式双保险，
/// 并覆盖"复用的残留实例"（没有 Job、只有探测到的 pid）。
pub fn shutdown(app: &AppHandle) {
    if let Some(mgr) = app.try_state::<ServerManager>() {
        mgr.set_intent_stop();
        if let Some(pid) = mgr.status().pid {
            kill_tree(pid);
        }
        let reused = mgr.reused_pid.swap(0, Ordering::SeqCst);
        if reused != 0 {
            kill_tree(reused);
        }
    }
}

/// 查询监听指定端口的进程 pid（netstat -ano 解析），用于接管复用的残留实例。
#[cfg(target_os = "windows")]
fn find_listener_pid(port: u16) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{}", port);
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // TCP  <local>  <remote>  LISTENING  <pid>
        if cols.len() == 5
            && cols[0].eq_ignore_ascii_case("TCP")
            && cols[3].eq_ignore_ascii_case("LISTENING")
            && cols[1].ends_with(&suffix)
        {
            if let Ok(pid) = cols[4].parse::<u32>() {
                return Some(pid);
            }
        }
    }
    None
}

/// 非 Windows：复用残留实例暂不接管 pid（跨平台清理属后续扩展），行为同前。
#[cfg(not(target_os = "windows"))]
fn find_listener_pid(_port: u16) -> Option<u32> {
    None
}

enum PortProbe {
    /// 带 token 的 /api/health 返回 200 —— 自己残留的旧实例，直接复用
    Ours,
    /// 有 HTTP 响应但不是我们的实例 —— 端口被别人占用
    Foreign,
    /// 连接被拒 —— 端口空闲
    Free,
}

/// 一次性端口探测（纯 socket，零依赖；仅 127.0.0.1 明文 HTTP）。
fn probe_port(port: u16, token: &str) -> PortProbe {
    let addr = ("127.0.0.1", port);
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return PortProbe::Foreign;
    };
    let Some(sock_addr) = addrs.next() else {
        return PortProbe::Foreign;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&sock_addr, Duration::from_millis(300)) else {
        return PortProbe::Free;
    };
    // 读超时：接受连接却不响应的监听者不能挂死探测（读取失败/超时按 Foreign 处理）
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return PortProbe::Foreign;
    }
    let mut buf = [0u8; 128];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    if head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200") {
        PortProbe::Ours
    } else {
        PortProbe::Foreign
    }
}

/// 端口是否已可建立 TCP 连接（node 的 serve() 开始监听 ≈ API 可用）。
/// 纯连接级探测，非 HTTP 健康检查：不产生请求，只验证监听已就绪。
fn port_is_open(port: u16) -> bool {
    let Ok(mut addrs) = ("127.0.0.1", port).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// 把子进程绑进 Job Object（KILL_ON_JOB_CLOSE）：父进程退出（无论何种方式）
/// 时内核自动终止 Job 内全部进程——对崩溃、被强杀、Ctrl+C 等"不经过
/// RunEvent::Exit"的退出路径是唯一可靠的清理手段。
/// 成功后句柄被 mem::forget 故意泄漏保活：句柄关闭即杀树，因此必须活到
/// 本进程结束（进程退出时由 OS 统一回收）；泄漏量 = spawn 次数，可忽略。
#[cfg(target_os = "windows")]
fn attach_job(child: &std::process::Child) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    let mut info = win32job::ExtendedLimitInfo::new();
    info.limit_kill_on_job_close();
    let job = win32job::Job::create_with_limit_info(&info)
        .map_err(|e| format!("create job: {e}"))?;
    job.assign_process(child.as_raw_handle() as isize)
        .map_err(|e| format!("assign process: {e}"))?;
    std::mem::forget(job);
    Ok(())
}

fn spawn_child(
    server_dir: &Path,
    data_dir: &Path,
    port: u16,
    token: &str,
) -> std::io::Result<std::process::Child> {
    let logs = data_dir.join("logs");
    std::fs::create_dir_all(&logs)?;
    let stdout = std::fs::OpenOptions::new()
        .create(true).write(true).truncate(true)
        .open(logs.join("desktop-stdout.log"))?;
    let stderr = std::fs::OpenOptions::new()
        .create(true).write(true).truncate(true)
        .open(logs.join("desktop-stderr.log"))?;
    let mut cmd = std::process::Command::new(server_dir.join(node_binary_name()));
    cmd.arg("seedserver.mjs")
        .current_dir(server_dir)
        .env("PORT", port.to_string())
        .env("BEARER_TOKEN", token)
        .env("DATA_DIR", data_dir)
        .env("NODE_ENV", "production")
        // 单文件 bundle 部署：显式指定代码根，供服务端定位 .env 与资源
        // （见 seedagent src/config/paths.ts / env-loader.ts）
        .env("SEEDAGENT_CODE_ROOT", server_dir.join("dist"))
        // pi 工具（fd/rg）下载目录 = DATA_DIR/bin。bundle 内模块初始化顺序
        // （compat 先于 config）可能导致进程内赋值太晚，这里直接在 spawn 前注入兜底。
        // 必须与 DATA_DIR 同值，否则 fd/rg 会下载到旧目录
        .env("PI_CODING_AGENT_DIR", data_dir)
        .stdout(std::process::Stdio::from(stdout))
        .stderr(std::process::Stdio::from(stderr));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
}

/// setup 里调用：spawn + 退出监控（阻塞线程，不占 async 运行时）。
pub fn start_background(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || run_loop(app));
}

fn run_loop(app: AppHandle) {
    let mgr = match app.try_state::<ServerManager>() {
        Some(m) => m,
        None => return,
    };
    // 监控存活标志：线程启动即置位，所有退出路径复位（request_restart 据此判断可否重开监控）
    mgr.monitor_running.store(true, Ordering::SeqCst);
    if !mgr.bundled {
        mgr.monitor_running.store(false, Ordering::SeqCst);
        return;
    }
    let data_dir = mgr.data_dir.clone();
    let token = mgr.token.clone();
    let server_dir = match &mgr.server_dir {
        Some(d) => d.clone(),
        None => {
            mgr.monitor_running.store(false, Ordering::SeqCst);
            return;
        }
    };

    // 选端口：<exe 目录>/.env 的 PORT 意向 → 本版本区间（dev 18889~18898 / 打包版 18789~18798），一次性探测
    let mut chosen: Option<u16> = None;
    let mut reused = false;
    let preferred_port = mgr.exe_dir.as_deref().and_then(read_env_port);
    for port in port_candidates(preferred_port, tauri::is_dev()) {
        match probe_port(port, &token) {
            PortProbe::Ours => {
                chosen = Some(port);
                reused = true;
                break;
            }
            PortProbe::Free => {
                chosen = Some(port);
                break;
            }
            PortProbe::Foreign => continue,
        }
    }
    let Some(port) = chosen else {
        mgr.update_status(Some(&app), |st| {
            st.state = ServerPhase::Failed;
            st.last_error = Some("端口 18789~18798 全被占用".into());
        });
        mgr.monitor_running.store(false, Ordering::SeqCst);
        return;
    };
    let url = format!("http://127.0.0.1:{port}");

    if reused {
        // 桌面端上次异常退出留下的残留实例（同 token）：直接复用。
        // netstat 探得监听 pid 存 reused_pid，退出时 shutdown 一并清理，
        // 避免"客户端停止后服务端继续存活"
        if let Some(pid) = find_listener_pid(port) {
            mgr.reused_pid.store(pid, Ordering::SeqCst);
        }
        mgr.update_status(Some(&app), |st| {
            st.state = ServerPhase::Running;
            st.port = Some(port);
            st.url = Some(url);
        });
        mgr.monitor_running.store(false, Ordering::SeqCst);
        return;
    }

    let mut backoff = Duration::from_secs(1);
    let mut consecutive_failures: u32 = 0;
    loop {
        // 退避睡眠期间可能已触发退出：spawn 前复查 STOP 意图，避免制造孤儿进程
        if mgr.intent.load(Ordering::SeqCst) == INTENT_STOP {
            mgr.monitor_running.store(false, Ordering::SeqCst);
            return;
        }
        match spawn_child(&server_dir, &data_dir, port, &token) {
            Ok(mut child) => {
                let pid = child.id();
                // 绑定 Job Object：本进程无论以何种方式退出（正常退出/崩溃/被强杀/
                // Ctrl+C），内核关闭 Job 句柄时都会杀掉 node 进程树。
                // 句柄故意泄漏保活到进程结束（mem::forget），泄漏量 = spawn 次数。
                #[cfg(target_os = "windows")]
                if let Err(e) = attach_job(&child) {
                    eprintln!("[server] attach_job failed (fall back to taskkill on exit): {e}");
                }
                let started = std::time::Instant::now();
                // 先报 Starting（带 pid/port，url 留空）：node 冷启动需要 1~5s 才开始
                // 监听端口，此期间前端显示启动画面且不发任何请求
                mgr.update_status(Some(&app), |st| {
                    st.state = ServerPhase::Starting;
                    st.port = Some(port);
                    st.pid = Some(pid);
                });
                // 轮询等待端口真正监听（纯 TCP 连接探测）：监听成功才置 Running，
                // 保证前端拿到 url 时服务已可用——避免启动窗口期的连接拒绝报错
                let mut listening = false;
                let listen_deadline = started + Duration::from_secs(30);
                loop {
                    if mgr.intent.load(Ordering::SeqCst) == INTENT_STOP {
                        let _ = child.wait();
                        mgr.monitor_running.store(false, Ordering::SeqCst);
                        return;
                    }
                    if child.try_wait().map(|s| s.is_some()).unwrap_or(false) {
                        break; // 进程在监听前就退出/被杀 → 交给下方 wait 分支按退避机制处理
                    }
                    if std::time::Instant::now() >= listen_deadline {
                        break;
                    }
                    if port_is_open(port) {
                        listening = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                if !listening && child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                    // 30s 仍未监听且进程还活着：杀掉转 Failed（留着只会占端口不干活）
                    kill_tree(pid);
                    let _ = child.wait();
                    mgr.update_status(Some(&app), |st| {
                        st.state = ServerPhase::Failed;
                        st.pid = None;
                        st.last_error = Some("服务进程 30s 内未开始监听端口".into());
                    });
                    mgr.monitor_running.store(false, Ordering::SeqCst);
                    return;
                }
                if listening {
                    mgr.update_status(Some(&app), |st| {
                        st.state = ServerPhase::Running;
                        st.port = Some(port);
                        st.url = Some(url.clone());
                        st.pid = Some(pid);
                        st.last_error = None;
                    });
                }
                let exit = child.wait();
                let uptime = started.elapsed();
                let code = exit.ok().and_then(|s| s.code()).unwrap_or(-1);

                if mgr.intent.load(Ordering::SeqCst) == INTENT_STOP {
                    mgr.monitor_running.store(false, Ordering::SeqCst);
                    return; // 正常退出路径，进程已结束
                }
                if mgr.intent.load(Ordering::SeqCst) == INTENT_RESTART {
                    mgr.intent.store(INTENT_RUN, Ordering::SeqCst);
                    consecutive_failures = 0;
                    backoff = Duration::from_secs(1);
                    continue; // 用户请求的重启：立即重拉
                }

                if uptime >= Duration::from_secs(30) {
                    consecutive_failures = 0;
                } else {
                    consecutive_failures += 1;
                }
                if consecutive_failures >= 5 {
                    mgr.update_status(Some(&app), |st| {
                        st.state = ServerPhase::Failed;
                        st.pid = None;
                        st.last_error = Some(format!("连续快速退出 5 次，最后退出码 {code}"));
                    });
                    mgr.monitor_running.store(false, Ordering::SeqCst);
                    return;
                }
                mgr.update_status(Some(&app), |st| {
                    st.state = ServerPhase::Restarting;
                    st.pid = None;
                    st.last_error = Some(format!("进程退出（码 {code}），{}s 后重启", backoff.as_secs()));
                });
                std::thread::sleep(backoff);
                backoff = std::cmp::min(backoff * 2, Duration::from_secs(15));
            }
            Err(e) => {
                mgr.update_status(Some(&app), |st| {
                    st.state = ServerPhase::Failed;
                    st.last_error = Some(format!("spawn 失败: {e}"));
                });
                mgr.monitor_running.store(false, Ordering::SeqCst);
                return;
            }
        }
    }
}

#[tauri::command]
pub fn server_status(state: tauri::State<'_, ServerManager>) -> ServerStatus {
    state.status()
}

#[tauri::command]
pub fn server_restart(app: AppHandle, state: tauri::State<'_, ServerManager>) {
    state.request_restart(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "seedcode-server-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_env_port_parses_port() {
        let exe = temp_home("port-ok");
        std::fs::write(exe.join(".env"), "BEARER_TOKEN=x\nPORT=18789\n").unwrap();
        assert_eq!(read_env_port(&exe), Some(18789));
        let _ = std::fs::remove_dir_all(&exe);
    }

    #[test]
    fn read_env_port_missing_or_invalid() {
        let exe = temp_home("port-miss");
        assert_eq!(read_env_port(&exe), None);
        std::fs::write(exe.join(".env"), "PORT=notanumber\n").unwrap();
        assert_eq!(read_env_port(&exe), None);
        let _ = std::fs::remove_dir_all(&exe);
    }

    #[test]
    fn read_env_value_trims_and_strips_quotes() {
        let dir = temp_home("env-value");
        std::fs::write(dir.join(".env"), "DATA_DIR =  \"D:/some dir/data\"  \nOTHER=1\n").unwrap();
        assert_eq!(read_env_value(&dir, "DATA_DIR").as_deref(), Some("D:/some dir/data"));
        assert_eq!(read_env_value(&dir, "MISSING"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_env_value_strips_inline_comment_and_keeps_hash_in_quotes() {
        let dir = temp_home("env-comment");
        // 行内注释（用户 .env 最自然的写法）：未加引号值遇 # 截断
        std::fs::write(dir.join(".env"), "DATA_DIR=data      # 数据目录说明\nPORT=18800 # port\n").unwrap();
        assert_eq!(read_env_value(&dir, "DATA_DIR").as_deref(), Some("data"));
        assert_eq!(read_env_value(&dir, "PORT").as_deref(), Some("18800"));
        // 配对引号包裹：# 属于值本身
        std::fs::write(dir.join(".env"), "DATA_DIR=\"D:/da#ta\" # comment\n").unwrap();
        assert_eq!(read_env_value(&dir, "DATA_DIR").as_deref(), Some("D:/da#ta"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_env_data_dir_empty_value_treated_as_undefined() {
        let dir = temp_home("env-datadir");
        std::fs::write(dir.join(".env"), "DATA_DIR=\n").unwrap();
        assert_eq!(read_env_data_dir(&dir), None);
        std::fs::write(dir.join(".env"), "DATA_DIR=data\n").unwrap();
        assert_eq!(read_env_data_dir(&dir).as_deref(), Some("data"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_data_dir_relative_absolute_and_home() {
        let exe = Path::new("/exe-dir");
        // 相对路径：相对 exe 目录（便携语义）
        assert_eq!(resolve_data_dir(exe, "data"), PathBuf::from("/exe-dir").join("data"));
        assert_eq!(resolve_data_dir(exe, " ./data "), PathBuf::from("/exe-dir").join("./data"));
        // 绝对路径：直接用
        let abs = std::env::temp_dir();
        assert_eq!(resolve_data_dir(exe, abs.to_str().unwrap()), abs);
        // ~/ 展开（与服务端 paths.ts 约定一致）
        assert_eq!(resolve_data_dir(exe, "~"), home_dir());
        assert_eq!(resolve_data_dir(exe, "~/seedcode-data"), home_dir().join("seedcode-data"));
    }

    #[test]
    fn resolve_default_data_dir_env_override_and_fallback() {
        // 打包版默认 ~/.seedcode
        let default = home_dir().join(".seedcode");
        // exe 目录缺失/无 .env/.env 无 DATA_DIR/DATA_DIR 为空 → 默认 ~/.seedcode
        assert_eq!(resolve_default_data_dir(None, false), default);
        let dir = temp_home("default-datadir");
        assert_eq!(resolve_default_data_dir(Some(&dir), false), default);
        std::fs::write(dir.join(".env"), "DATA_DIR=\n").unwrap();
        assert_eq!(resolve_default_data_dir(Some(&dir), false), default);
        // 有 DATA_DIR → 覆盖（相对 exe 目录）
        std::fs::write(dir.join(".env"), "PORT=18790\nDATA_DIR=data\n").unwrap();
        assert_eq!(resolve_default_data_dir(Some(&dir), false), dir.join("data"));
        // dev（tauri dev）默认 ~/.seedcode-dev（隔离）；.env 覆盖仍优先
        let dev_default = home_dir().join(".seedcode-dev");
        assert_eq!(resolve_default_data_dir(None, true), dev_default);
        std::fs::write(dir.join(".env"), "DATA_DIR=\n").unwrap();
        assert_eq!(resolve_default_data_dir(Some(&dir), true), dev_default);
        std::fs::write(dir.join(".env"), "DATA_DIR=data\n").unwrap();
        assert_eq!(resolve_default_data_dir(Some(&dir), true), dir.join("data"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn port_candidates_preferred_first_and_dedup() {
        assert_eq!(port_candidates(Some(9000), false), {
            let mut v: Vec<u16> = vec![9000];
            v.extend(18789..=18798);
            v
        });
        assert_eq!(port_candidates(Some(18789), false).first(), Some(&18789));
        assert_eq!(port_candidates(Some(18789), false).len(), 10);
        assert_eq!(port_candidates(None, false).len(), 10);
    }

    #[test]
    fn port_candidates_in_range_preferred_first() {
        // 区间内的意向端口也必须排在候选首位（PORT 意向优先）
        assert_eq!(port_candidates(Some(18795), false).first(), Some(&18795));
    }

    #[test]
    fn port_candidates_dev_uses_isolated_range() {
        // dev（tauri dev）与打包版区间隔离：18889~18898，互不探活
        assert_eq!(
            port_candidates(None, true),
            (18889..=18898).collect::<Vec<_>>()
        );
        // dev 显式 PORT 意向仍优先（可指到任意端口）
        assert_eq!(port_candidates(Some(9000), true).first(), Some(&9000));
    }

    #[test]
    fn token_created_then_reused() {
        let dir = temp_home("token");
        let t1 = load_or_create_token(&dir);
        assert!(uuid::Uuid::parse_str(&t1).is_ok());
        let t2 = load_or_create_token(&dir);
        assert_eq!(t1, t2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn port_is_open_detects_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_is_open(port));
        // 释放后连接应被拒绝；先用重绑验证端口确已空闲，避免极端竞态误报
        drop(listener);
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            assert!(!port_is_open(port));
        }
    }
}
