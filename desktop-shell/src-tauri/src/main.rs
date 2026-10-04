#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

/* ===== 原生桥：与安卓 Capacitor / 鸿蒙 __HarmonyNative 同构，web 侧只认 Transport 一套接口 ===== */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpReply {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

fn agent() -> &'static ureq::Agent {
    use std::time::Duration;
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .build()
    })
}

/* WebDAV 的协议语义全在裸状态码上（304 零流量 / 404 被删 / 409 缺目录 / 412 撞码），
   ureq 默认把 4xx/5xx 当 Err 抛出：这里一律转成正常返回，dav.js 的重试合并逻辑才照搬可用 */
fn do_request(req: &HttpRequest) -> Result<HttpReply, String> {
    let mut call = agent().request(&req.method, &req.url);
    for (k, v) in &req.headers {
        call = call.set(k, v);
    }
    let sent = match &req.body {
        Some(b) => call.send_string(b),
        None => call.call(),
    };
    let resp = match sent {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("请求失败：{}", e)),
    };
    let status = resp.status();
    let mut headers = HashMap::new();
    for name in resp.headers_names() {
        if let Some(v) = resp.header(&name) {
            // 统一小写：JS 侧 findHeader('etag') 不必再猜服务端的大小写
            headers.insert(name.to_ascii_lowercase(), v.to_string());
        }
    }
    let mut body = String::new();
    let _ = resp.into_reader().read_to_string(&mut body);
    Ok(HttpReply { status, headers, body })
}

#[tauri::command]
fn http_request(req: HttpRequest) -> Result<HttpReply, String> {
    do_request(&req)
}

/* 设备号存原生配置目录：网页 localStorage 被清时不至于「每次重开就是一个新账号」（v0.1.4 教训） */
fn device_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("device.id"))
}

#[tauri::command]
fn device_id(app: AppHandle) -> Result<String, String> {
    let p = device_file(&app)?;
    if let Ok(s) = std::fs::read_to_string(&p) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return Ok(s);
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let _ = std::fs::write(&p, &id);
    Ok(id)
}

/* 打开外部链接（更新发布页）。只放 https、Command 直接传参不过 shell，链接再坏也注入不了命令 */
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {    if !url.starts_with("https://") {
        return Err("仅允许打开 https 链接".into());
    }
    #[cfg(windows)]
    let spawn = std::process::Command::new("explorer.exe").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let spawn = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(not(any(windows, target_os = "linux")))]
    let spawn: Result<std::process::Child, std::io::Error> = Err(std::io::Error::other("unsupported"));
    spawn.map(|_| ()).map_err(|e| e.to_string())
}

/* 变更通知：走 tauri-plugin-notification（Windows 用系统通知中心，Linux 走 notify-rust）。
   用自定义 command 而不是插件自己的 JS API——自定义 command 不过 ACL，capabilities 一行不用改 */
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/* ===== 应用内更新：下载安装包（多通道回退 + sha256 校验）→ 轮询进度 → 拉起安装器 ===== */

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    status: String, // idle | downloading | done | error
    percent: u32,
    received: u64,
    total: u64,
    path: String,
    used: String, // 哪条通道下的，JS 侧记下来下次优先用它
    error: String,
}

fn progress() -> &'static Mutex<DownloadProgress> {
    static P: OnceLock<Mutex<DownloadProgress>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(DownloadProgress::default()))
}

fn set_progress(f: impl FnOnce(&mut DownloadProgress)) {
    if let Ok(mut g) = progress().lock() {
        f(&mut g);
    }
}

/* 点「取消」不杀线程，只置标志：下载循环在下一个分块边界收手并删掉 .part，
   免得留个半截包在缓存目录里被当成可用的安装包 */
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRequest {
    urls: Vec<String>,
    name: String,
    #[serde(default)]
    sha256: String,
}

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/* 安装包名来自 GitHub 资产字段：只留安全字符，顺带把路径分隔符削掉 */
fn safe_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('.');
    if trimmed.is_empty() {
        "update.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

/* 下载不能用 agent()：那个带了 90 秒总超时，几十 MB 的包在慢网上必然被掐断。
   这里只设连接与单次读取超时，不限总时长，慢但稳地把它下完 */
fn dl_agent() -> &'static ureq::Agent {
    use std::time::Duration;
    static A: OnceLock<ureq::Agent> = OnceLock::new();
    A.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
            .build()
    })
}

fn download_one(url: &str, dest: &Path, expect_sha: &str) -> Result<(), String> {
    use std::io::Write;
    use sha2::{Digest, Sha256};

    let resp = match dl_agent().get(url).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return Err(format!("HTTP {}", code)),
        Err(e) => return Err(format!("{}", e)),
    };
    let total = resp.header("content-length").and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut part_os = dest.as_os_str().to_os_string();
    part_os.push(".part");
    let part = PathBuf::from(part_os);
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut got: u64 = 0;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err("已取消下载".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("下载中断：{}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("写入失败：{}", e))?;
        got += n as u64;
        // 100% 只由「校验通过 + 落盘完成」那一步给，进度条才不会停在 100 又报错
        let percent = if total > 0 { ((got * 100) / total).min(99) as u32 } else { 0 };
        set_progress(|p| {
            p.status = "downloading".into();
            p.received = got;
            p.total = total;
            p.percent = percent;
        });
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let hex = format!("{:x}", hasher.finalize());
    if !expect_sha.is_empty() && hex != expect_sha {
        let _ = std::fs::remove_file(&part);
        return Err("安装包校验不通过（sha256 不匹配）".into());
    }
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn download_update(app: AppHandle, req: UpdateRequest) -> Result<(), String> {
    let urls: Vec<String> = req.urls.into_iter().filter(|u| u.starts_with("https://")).collect();
    if urls.is_empty() {
        return Err("没有可用的下载链接".into());
    }
    let dir = updates_dir(&app)?;
    let name = safe_name(&req.name);
    let sha = req.sha256.trim().to_ascii_lowercase();
    CANCEL.store(false, Ordering::SeqCst);
    set_progress(|p| *p = DownloadProgress { status: "downloading".into(), ..Default::default() });

    std::thread::spawn(move || {
        let dest = dir.join(&name);
        let mut part_os = dest.as_os_str().to_os_string();
        part_os.push(".part");
        let part = PathBuf::from(part_os);
        let mut last = String::from("下载失败");
        for u in &urls {
            match download_one(u, &dest, &sha) {
                Ok(()) => {
                    let path = dest.to_string_lossy().into_owned();
                    set_progress(|p| *p = DownloadProgress {
                        status: "done".into(),
                        percent: 100,
                        path,
                        used: u.clone(),
                        ..Default::default()
                    });
                    return;
                }
                Err(e) => {
                    // 半截的 .part 不能留在更新目录里，否则下次以为还在下
                    let _ = std::fs::remove_file(&dest);
                    let _ = std::fs::remove_file(&part);
                    let stopped = CANCEL.load(Ordering::SeqCst) || e.contains("取消");
                    last = e;
                    if stopped {
                        break;
                    }
                }
            }
        }
        let msg = last;
        set_progress(|p| {
            p.status = "error".into();
            p.error = msg;
        });
    });
    Ok(())
}

#[tauri::command]
fn download_progress() -> DownloadProgress {
    progress().lock().map(|g| g.clone()).unwrap_or_default()
}

#[tauri::command]
fn cancel_download() {
    CANCEL.store(true, Ordering::SeqCst);
}

/* 拉起安装器：路径必须落在更新目录内（canonicalize 后再比，Windows 的 \\?\ 前缀两边一致才比得出），
   不然前端传个任意路径进来就能执行任意 exe */
#[tauri::command]
fn install_update(app: AppHandle, path: String) -> Result<String, String> {
    let dir = std::fs::canonicalize(updates_dir(&app)?).map_err(|e| e.to_string())?;
    let p = std::fs::canonicalize(&path).map_err(|e| format!("找不到安装包：{}", e))?;
    if !p.starts_with(&dir) {
        return Err("只允许安装更新目录里的文件".into());
    }

    #[cfg(windows)]
    {
        use std::time::Duration;
        std::process::Command::new(&p).spawn().map_err(|e| e.to_string())?;
        let a = app.clone();
        std::thread::spawn(move || {
            // 先让前端把「正在退出」显示出来；NSIS 也要等进程真的退干净才不报「文件被占用」
            std::thread::sleep(Duration::from_millis(800));
            a.exit(0);
        });
        return Ok("已启动安装程序，应用即将自动退出".into());
    }

    #[cfg(target_os = "linux")]
    {
        let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
        return Ok(format!(
            "安装包已就绪：{}\nLinux 不能自装 deb，请在终端执行：sudo apt install \"./{}\"",
            p.to_string_lossy(),
            name
        ));
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, dir);
        Err("该平台暂不支持应用内安装".into())
    }
}

fn main() {
    /* WebView2 默认把用户数据写到 exe 旁：<perMachine> 升级换目录 = 网盘配置/空间列表全丢。
       固定到 %APPDATA%，安装位置随便挪 */
    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        if let Ok(appdata) = std::env::var("APPDATA") {
            std::env::set_var(
                "WEBVIEW2_USER_DATA_FOLDER",
                PathBuf::from(appdata).join("Reunion").join("webview2"),
            );
        }
    }

    tauri::Builder::default()
        // 与移动端同款「singleton」：第二次启动把已有窗口带到前台，而不是再开一个实例
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // notify() 走 app.notification().builder()：插件没在这里注册就没有 managed state，第一条通知即 panic
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            /* 托盘：常驻入口。左键单击唤起主窗口，右键菜单给「显示 / 退出」。
               不劫持窗口的关闭按钮——点 ✕ 还是退出，习惯不被人替用户做主 */
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("应用图标未配置").clone())
                .tooltip("Reunion · 共享日程")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http_request, device_id, open_url, notify,
            download_update, download_progress, cancel_download, install_update
        ])
        .run(tauri::generate_context!())
        .expect("Reunion 桌面端启动失败");
}
