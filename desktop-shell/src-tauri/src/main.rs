#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
    use std::sync::OnceLock;
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
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
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
        .invoke_handler(tauri::generate_handler![http_request, device_id, open_url])
        .run(tauri::generate_context!())
        .expect("Reunion 桌面端启动失败");
}
