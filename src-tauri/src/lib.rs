//! API Key Manager - Tauri 应用主入口
//! 完整 Rust 重写，替代原 Electron + Node.js 架构

mod config;
mod models;
mod p2p;
mod state;
mod sync;

use config::{Config, WidgetProviderInfo};
use models::ModelInfo;
use std::collections::BTreeMap;
use std::sync::Mutex;

static P2P_SERVER: std::sync::OnceLock<Mutex<Option<p2p::P2PServer>>> =
    std::sync::OnceLock::new();

fn p2p_server() -> &'static Mutex<Option<p2p::P2PServer>> {
    P2P_SERVER.get_or_init(|| Mutex::new(None))
}

// ===== 配置相关 Commands =====

/// 读取完整配置
#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Config {
    config::load_config(&app)
}

/// 全量保存配置
#[tauri::command]
fn save_config(app: tauri::AppHandle, config: Config) -> Result<(), String> {
    config::save_config(&app, &config)
}

/// 定向更新选中项
#[tauri::command]
fn save_select(
    app: tauri::AppHandle,
    provider: String,
    key_id: Option<String>,
    model_id: Option<String>,
) -> Result<(), String> {
    config::save_select(
        &app,
        &provider,
        key_id.as_deref(),
        model_id.as_deref(),
    )
}

/// 获取 widget 端简化视图
#[tauri::command]
fn get_widget_view(app: tauri::AppHandle) -> BTreeMap<String, WidgetProviderInfo> {
    config::widget_view(&app)
}

/// 拉取模型列表
#[tauri::command]
async fn fetch_models_command(
    provider: String,
    base_url: String,
    key: String,
) -> Result<Vec<ModelInfo>, String> {
    models::fetch_models(&base_url, &key, &provider).await
}

// ===== 主题相关 Commands =====

#[tauri::command]
fn get_theme(app: tauri::AppHandle) -> String {
    state::load_theme(&app)
}

#[tauri::command]
fn set_theme(app: tauri::AppHandle, theme: String, scope: Option<String>) -> Result<(), String> {
    let scope = scope.unwrap_or_else(|| "widget".into());
    match scope.as_str() {
        "app" => {
            let mut s = state::load_app_state(&app);
            s.theme = Some(theme);
            state::save_app_state(&app, &s)
        }
        _ => {
            // 同时写入两个状态文件，保持同步
            let mut app_s = state::load_app_state(&app);
            app_s.theme = Some(theme.clone());
            state::save_app_state(&app, &app_s)?;
            state::patch_widget_state(&app, |s| s.theme = Some(theme.clone()))
        }
    }
}

// ===== Widget 窗口位置相关 Commands =====

#[tauri::command]
fn get_widget_position(app: tauri::AppHandle) -> Option<(i32, i32)> {
    let s = state::load_widget_state(&app);
    match (s.x, s.y) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    }
}

#[tauri::command]
fn save_widget_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    state::patch_widget_state(&app, |s| {
        s.x = Some(x);
        s.y = Some(y);
    })
}

#[tauri::command]
fn reset_widget_position(app: tauri::AppHandle) -> Result<(), String> {
    state::clear_widget_position(&app)
}

// ===== 同步 / 加密 Commands =====

/// 生成 RSA-2048 密钥对并保存到同步状态
#[tauri::command]
fn sync_generate_keypair(app: tauri::AppHandle) -> Result<state::SyncState, String> {
    let kp = sync::generate_keypair()?;
    state::patch_sync_state(&app, |s| {
        s.private_key_pem = Some(kp.private_pem);
        s.public_key_pem = Some(kp.public_pem);
    })?;
    Ok(state::load_sync_state(&app))
}

/// 获取当前同步状态
#[tauri::command]
fn sync_get_state(app: tauri::AppHandle) -> state::SyncState {
    state::load_sync_state(&app)
}

/// 保存同步 URL
#[tauri::command]
fn sync_set_url(app: tauri::AppHandle, url: Option<String>) -> Result<(), String> {
    state::patch_sync_state(&app, |s| {
        s.sync_url = url;
    })
}

/// 设置自动同步间隔（分钟），传 None 关闭自动同步
#[tauri::command]
fn sync_set_auto_interval(app: tauri::AppHandle, minutes: Option<u64>) -> Result<(), String> {
    state::patch_sync_state(&app, |s| {
        s.auto_sync_interval_min = minutes;
    })
}

/// 导入私钥（自动推导公钥并保存）
#[tauri::command]
fn sync_import_private_key(app: tauri::AppHandle, private_pem: String) -> Result<state::SyncState, String> {
    sync::validate_private_key(&private_pem)?;
    let public_pem = sync::public_from_private(&private_pem)?;
    state::patch_sync_state(&app, |s| {
        s.private_key_pem = Some(private_pem);
        s.public_key_pem = Some(public_pem);
    })?;
    Ok(state::load_sync_state(&app))
}

/// 导入公钥（仅用于加密导出，无法解密）
#[tauri::command]
fn sync_import_public_key(app: tauri::AppHandle, public_pem: String) -> Result<state::SyncState, String> {
    sync::validate_public_key(&public_pem)?;
    state::patch_sync_state(&app, |s| {
        s.public_key_pem = Some(public_pem);
    })?;
    Ok(state::load_sync_state(&app))
}

/// 清除密钥
#[tauri::command]
fn sync_clear_keys(app: tauri::AppHandle) -> Result<state::SyncState, String> {
    state::patch_sync_state(&app, |s| {
        s.private_key_pem = None;
        s.public_key_pem = None;
    })?;
    Ok(state::load_sync_state(&app))
}

/// 用公钥加密当前配置，返回加密后的 JSON 字符串
#[tauri::command]
fn sync_encrypt_config(app: tauri::AppHandle) -> Result<String, String> {
    let ss = state::load_sync_state(&app);
    let pub_key = ss.public_key_pem.ok_or("未配置公钥")?;
    let cfg = config::load_config(&app);
    sync::encrypt_config_to_string(&pub_key, &cfg)
}

/// 用指定的公钥加密当前配置（用于 P2P 推送）
#[tauri::command]
fn sync_encrypt_config_with_key(app: tauri::AppHandle, public_key_pem: String) -> Result<String, String> {
    let cfg = config::load_config(&app);
    sync::encrypt_config_to_string(&public_key_pem, &cfg)
}

/// 从配置的 URL 拉取并解密配置，合并到本地
/// 返回解密后的配置，由前端决定是否合并
#[tauri::command]
async fn sync_fetch_remote(app: tauri::AppHandle) -> Result<Config, String> {
    let ss = state::load_sync_state(&app);
    let url = ss.sync_url.clone().ok_or("未配置同步 URL")?;
    let priv_key = ss.private_key_pem.clone().ok_or("未配置私钥，无法解密")?;

    let result = sync::fetch_and_decrypt(&url, &priv_key).await;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    match &result {
        Ok(_) => {
            let _ = state::patch_sync_state(&app, |s| {
                s.last_sync_at = Some(now);
                s.last_sync_ok = Some(true);
                s.last_sync_error = None;
            });
        }
        Err(e) => {
            let _ = state::patch_sync_state(&app, |s| {
                s.last_sync_at = Some(now);
                s.last_sync_ok = Some(false);
                s.last_sync_error = Some(e.clone());
            });
        }
    }

    result
}

/// 将远端配置合并到本地（保留本地新增的 key，以远端为基准，本地选中项不被覆盖）
#[tauri::command]
fn sync_merge_config(app: tauri::AppHandle, remote: Config) -> Result<(), String> {
    let mut local = config::load_config(&app);
    for (provider, remote_cfg) in remote {
        let local_entry = local.entry(provider.clone()).or_default();
        // 远端的 base_url 覆盖本地
        if !remote_cfg.base_url.is_empty() {
            local_entry.base_url = remote_cfg.base_url;
        }
        // 远端的 keys 列表：按 id 合并，远端 key 覆盖同 id 的本地 key
        for rk in &remote_cfg.keys {
            if let Some(lk) = local_entry.keys.iter_mut().find(|k| k.id == rk.id) {
                lk.name = rk.name.clone();
                lk.key = rk.key.clone();
            } else {
                local_entry.keys.push(rk.clone());
            }
        }
        // 远端 selected_model 覆盖本地（如果本地没有选中项）
        if local_entry.selected_model.is_empty() && !remote_cfg.selected_model.is_empty() {
            local_entry.selected_model = remote_cfg.selected_model;
        }
        // 保证至少一个 key 被选中
        if !local_entry.keys.is_empty() && !local_entry.keys.iter().any(|k| k.selected) {
            local_entry.keys[0].selected = true;
        }
    }
    config::save_config(&app, &local)
}

/// 直接用远端配置覆盖本地
#[tauri::command]
fn sync_overwrite_config(app: tauri::AppHandle, remote: Config) -> Result<(), String> {
    config::save_config(&app, &remote)
}

// ===== P2P 局域网同步 Commands =====

/// 启动 P2P 分享服务
#[tauri::command]
fn p2p_start_server(app: tauri::AppHandle) -> Result<(String, String), String> {
    let ip = p2p::get_local_ip()?;
    let port = p2p::find_available_port()?;

    let cfg = config::load_config(&app);
    let cfg_json = serde_json::to_string(&cfg).map_err(|e| format!("序列化失败: {}", e))?;
    let ss = state::load_sync_state(&app);
    let pub_key = ss.public_key_pem.ok_or("请先生成或导入密钥对")?;
    let priv_key = ss.private_key_pem.clone().ok_or("未配置私钥，无法签名")?;

    let addr = format!("{}:{}", ip, port);
    let fingerprint = sync::pubkey_fingerprint(&pub_key, 8);
    let server = p2p::P2PServer::start(
        &ip,
        port,
        cfg_json,
        pub_key,
        priv_key,
        {
            let app = app.clone();
            move |body| {
                log::info!("P2P 收到新的加密配置");
            }
        },
    )?;

    let qrcode_svg = p2p::generate_qrcode_svg(&format!("http://{}/sync#{}", addr, fingerprint))?;

    {
        let mut guard = p2p_server().lock().unwrap();
        *guard = Some(server);
    }

    Ok((addr, qrcode_svg))
}

/// 停止 P2P 分享服务
#[tauri::command]
fn p2p_stop_server() -> Result<(), String> {
    let mut guard = p2p_server().lock().unwrap();
    if let Some(server) = guard.take() {
        server.stop();
        // 等线程退出
        std::thread::sleep(std::time::Duration::from_millis(200));
        Ok(())
    } else {
        Err("没有运行中的分享服务".into())
    }
}

/// 获取 P2P 服务状态
#[tauri::command]
fn p2p_get_status() -> Result<(bool, Option<String>), String> {
    let guard = p2p_server().lock().unwrap();
    match guard.as_ref() {
        Some(server) => {
            let running = server.is_running();
            let addr = if running {
                Some(server.addr.clone())
            } else {
                None
            };
            Ok((running, addr))
        }
        None => Ok((false, None)),
    }
}

/// 刷新分享的配置（推送最新本地配置）
#[tauri::command]
fn p2p_refresh_payload(app: tauri::AppHandle) -> Result<(), String> {
    let guard = p2p_server().lock().unwrap();
    if let Some(server) = guard.as_ref() {
        let cfg = config::load_config(&app);
        let cfg_json = serde_json::to_string(&cfg).map_err(|e| format!("序列化失败: {}", e))?;
        server.set_config_json(cfg_json);
        Ok(())
    } else {
        Err("没有运行中的分享服务".into())
    }
}

/// 解密从 P2P 对端获取的加密 payload JSON
#[tauri::command]
fn p2p_decrypt_payload(app: tauri::AppHandle, payload_json: String) -> Result<Config, String> {
    let ss = state::load_sync_state(&app);
    let priv_key = ss.private_key_pem.ok_or("未配置私钥，无法解密")?;
    let payload: sync::EncryptedPayload =
        serde_json::from_str(&payload_json).map_err(|e| format!("解析 payload 失败: {}", e))?;
    sync::decrypt_config(&priv_key, &payload)
}

// ===== 窗口控制 Commands =====

// 收起态：UI 圆形 48×48，每边留 4px 给阴影/光环，避免大面积透明死区
const WIDGET_COLLAPSED: (u32, u32) = (56, 56);
// 展开态：贴合 CSS 实际内容（border 2 + header 39 + body 224 ≈ 265，留 5px 余量）
const WIDGET_EXPANDED: (u32, u32) = (340, 270);

/// 切换 widget 展开状态
#[tauri::command]
fn widget_set_expanded(app: tauri::AppHandle, expanded: bool) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("widget") {
        let (w, h) = if expanded {
            WIDGET_EXPANDED
        } else {
            WIDGET_COLLAPSED
        };
        win.set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 收起态下吸附到最近屏幕边缘（含缓动动画）
/// 仅在 collapsed 状态调用，避免与展开尺寸冲突。
#[tauri::command]
async fn widget_snap_to_edge(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::{Manager, PhysicalPosition};

    let win = app
        .get_webview_window("widget")
        .ok_or("widget window not found")?;

    let monitor = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no current monitor")?;

    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let scale = monitor.scale_factor();

    let win_pos = win.outer_position().map_err(|e| e.to_string())?;
    let win_size = win.outer_size().map_err(|e| e.to_string())?;

    let (w_w, w_h) = (win_size.width as i32, win_size.height as i32);
    let cx = win_pos.x + w_w / 2;
    let cy = win_pos.y + w_h / 2;

    let mon_left = mon_pos.x;
    let mon_top = mon_pos.y;
    let mon_right = mon_pos.x + mon_size.width as i32;
    let mon_bottom = mon_pos.y + mon_size.height as i32;

    // 8 逻辑像素的边距
    let margin = (8.0 * scale).round() as i32;
    let y_lo = mon_top + margin;
    let y_hi = (mon_bottom - margin - w_h).max(y_lo);
    let x_lo = mon_left + margin;
    let x_hi = (mon_right - margin - w_w).max(x_lo);

    let d_left = cx - mon_left;
    let d_right = mon_right - cx;
    let d_top = cy - mon_top;
    let d_bottom = mon_bottom - cy;
    let min_dist = d_left.min(d_right).min(d_top).min(d_bottom);

    let (target_x, target_y) = if min_dist == d_left {
        (x_lo, win_pos.y.clamp(y_lo, y_hi))
    } else if min_dist == d_right {
        (x_hi, win_pos.y.clamp(y_lo, y_hi))
    } else if min_dist == d_top {
        (win_pos.x.clamp(x_lo, x_hi), y_lo)
    } else {
        (win_pos.x.clamp(x_lo, x_hi), y_hi)
    };

    // 已经吸附就不再触发动画
    if target_x == win_pos.x && target_y == win_pos.y {
        return Ok(false);
    }

    // 后台线程执行 ~200ms 缓动动画，避免阻塞 IPC
    let win_clone = win.clone();
    let app_clone = app.clone();
    let from_x = win_pos.x;
    let from_y = win_pos.y;
    std::thread::spawn(move || {
        let steps = 24u32;
        let interval_ms = 8u64;
        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            // easeOutCubic
            let e = 1.0 - (1.0 - t).powi(3);
            let x = (from_x as f64 + (target_x - from_x) as f64 * e).round() as i32;
            let y = (from_y as f64 + (target_y - from_y) as f64 * e).round() as i32;
            let _ = win_clone.set_position(PhysicalPosition::new(x, y));
            std::thread::sleep(std::time::Duration::from_millis(interval_ms));
        }
        let _ = state::patch_widget_state(&app_clone, |s| {
            s.x = Some(target_x);
            s.y = Some(target_y);
        });
    });

    Ok(true)
}

/// 显示 widget 窗口
#[tauri::command]
fn widget_show(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("widget") {
        win.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 隐藏 widget 窗口
#[tauri::command]
fn widget_hide(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("widget") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 获取应用版本号
#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

// ===== 应用入口 =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 把 WebView2 用户数据目录重定向到 %TEMP% 下的子目录。
    // 原因：默认目录 %LOCALAPPDATA%\<identifier>\EBWebView 在应用被强制结束时会残留 LOCK 文件，
    // 导致下次启动报 HRESULT 0x800700AA（共享冲突）。temp 目录可被开发工具清理，避免锁积累。
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let webview_dir = std::path::Path::new(&local_app_data)
            .join("Temp")
            .join("apikeymanager-webview");
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();

    log::info!("API Key Manager 启动中 (Tauri)");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init());

    // 开机自启仅桌面端注册（移动端无此概念，且插件不支持 android/ios）
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--widget"]),
    ));

    builder
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            save_select,
            get_widget_view,
            fetch_models_command,
            get_theme,
            set_theme,
            get_widget_position,
            save_widget_position,
            reset_widget_position,
            sync_generate_keypair,
            sync_get_state,
            sync_set_url,
            sync_set_auto_interval,
            sync_import_private_key,
            sync_import_public_key,
            sync_clear_keys,
            sync_encrypt_config,
            sync_encrypt_config_with_key,
            sync_fetch_remote,
            sync_merge_config,
            sync_overwrite_config,
            p2p_start_server,
            p2p_stop_server,
            p2p_get_status,
            p2p_refresh_payload,
            p2p_decrypt_payload,
            widget_set_expanded,
            widget_snap_to_edge,
            widget_show,
            widget_hide,
            get_app_version,
        ])
        .setup(|app| {
            use tauri::Manager;
            // 主窗口关闭时同步关闭 widget
            let app_handle = app.handle().clone();
            if let Some(main_win) = app.get_webview_window("main") {
                main_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        if let Some(widget) = app_handle.get_webview_window("widget") {
                            let _ = widget.close();
                        }
                    }
                });
            }
            // Widget 窗口初始配置：透明背景、圆角（Windows 上需要显式设置）
            if let Some(widget) = app.get_webview_window("widget") {
                // 把窗口背景设为完全透明，让 CSS 中的 border-radius 真正生效
                let _ = widget.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
                // 恢复保存的位置
                let state = state::load_widget_state(&app.handle());
                if let (Some(x), Some(y)) = (state.x, state.y) {
                    let _ = widget.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
                }
                let _ = widget.show();
            }
            log::info!("应用初始化完成");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用时出错");
}
