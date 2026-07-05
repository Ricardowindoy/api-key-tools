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
use std::sync::OnceLock;
use std::sync::Mutex;

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

/// 解密传入的 payload JSON 字符串（P2P 同步时用）
#[tauri::command]
fn sync_decrypt_payload(app: tauri::AppHandle, payload_json: String) -> Result<Config, String> {
    let ss = state::load_sync_state(&app);
    let priv_key = ss.private_key_pem.ok_or("未配置私钥")?;
    let payload: sync::EncryptedPayload =
        serde_json::from_str(&payload_json).map_err(|e| format!("解析 payload 失败: {}", e))?;
    sync::decrypt_config(&priv_key, &payload)
}

// ===== P2P 局域网同步 Commands =====

static P2P_SERVER: OnceLock<Mutex<Option<p2p::P2PServer>>> = OnceLock::new();

fn p2p_server() -> &'static Mutex<Option<p2p::P2PServer>> {
    P2P_SERVER.get_or_init(|| Mutex::new(None))
}

/// 启动 P2P 同步服务，返回 (addr, qrcode_svg)
#[tauri::command]
fn p2p_start_server(app: tauri::AppHandle) -> Result<(String, String), String> {
    {
        let mut guard = p2p_server().lock().unwrap();
        if let Some(server) = guard.take() {
            server.stop();
        }
    }

    let ip = p2p::get_local_ip()?;
    let port = p2p::find_available_port()?;

    let ss = state::load_sync_state(&app);
    let initial_payload = if let Some(pub_key) = ss.public_key_pem.as_ref() {
        let cfg = config::load_config(&app);
        match sync::encrypt_config_to_string(pub_key, &cfg) {
            Ok(json) => Some(json),
            Err(_) => None,
        }
    } else {
        None
    };

    let app_handle = app.clone();
    let server = p2p::P2PServer::start(
        &ip,
        port,
        initial_payload,
        move |received_json| {
            use tauri::Emitter;
            let _ = app_handle.emit("p2p-data-received", received_json);
        },
    )?;

    let addr = server.addr.clone();
    let url = format!("http://{}/sync", addr);
    let qrcode_svg = p2p::generate_qrcode_svg(&url)?;

    {
        let mut guard = p2p_server().lock().unwrap();
        *guard = Some(server);
    }

    Ok((addr, qrcode_svg))
}

/// 停止 P2P 同步服务
#[tauri::command]
fn p2p_stop_server() -> Result<(), String> {
    let mut guard = p2p_server().lock().unwrap();
    if let Some(server) = guard.take() {
        server.stop();
    }
    Ok(())
}

/// 获取 P2P 服务状态
#[tauri::command]
fn p2p_get_status() -> (bool, Option<String>) {
    let guard = p2p_server().lock().unwrap();
    match guard.as_ref() {
        Some(server) => (server.is_running(), Some(server.addr.clone())),
        None => (false, None),
    }
}

/// 重新加密本地配置并更新分享内容
#[tauri::command]
fn p2p_refresh_payload(app: tauri::AppHandle) -> Result<(), String> {
    let guard = p2p_server().lock().unwrap();
    let server = match guard.as_ref() {
        Some(s) => s,
        None => return Err("P2P 服务未启动".into()),
    };

    let ss = state::load_sync_state(&app);
    let pub_key = ss.public_key_pem.ok_or("未配置公钥")?;
    let cfg = config::load_config(&app);
    let payload = sync::encrypt_config_to_string(&pub_key, &cfg)?;
    server.set_payload(payload);

    Ok(())
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

// ===== Android 签名证书固定 =====

/// 固定的 release 签名证书 SHA-256 指纹（hex 格式，小写无冒号）
/// 生成方式：keytool -list -v -keystore release.keystore -alias release -storepass <password>
///           找到 SHA256: 后的值，去掉冒号转小写
/// 占位值在首次 CI 构建后会替换为实际指纹
const PINNED_CERT_SHA256: &str = "REPLACE_WITH_RELEASE_CERT_SHA256";

/// 签名校验入口
fn verify_android_signature() -> bool {
    // Debug 构建跳过校验
    #[cfg(debug_assertions)]
    {
        log::info!("Debug 构建，跳过签名校验");
        return true;
    }

    // 非 Android 平台不校验
    #[cfg(not(target_os = "android"))]
    {
        return true;
    }

    // Release Android 构建执行实际校验
    #[cfg(all(not(debug_assertions), target_os = "android"))]
    {
        verify_apk_signature()
    }
}

/// Release Android 构建时校验 APK 签名证书指纹
#[cfg(all(not(debug_assertions), target_os = "android"))]
fn verify_apk_signature() -> bool {
    use std::io::{Read, Seek, SeekFrom};

    let pkg = "com.apikeymanager.app";

    // 通过 pm 命令获取 APK 路径
    let apk_path = std::process::Command::new("pm")
        .args(["path", pkg])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let stdout = String::from_utf8_lossy(&o.stdout);
                stdout
                    .lines()
                    .next()
                    .and_then(|l| l.strip_prefix("package:"))
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();

    if apk_path.is_empty() {
        log::warn!("无法获取 APK 路径，跳过签名校验");
        return false;
    }

    // 读取 APK 文件
    let mut file = match std::fs::File::open(&apk_path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("打开 APK 失败: {}", e);
            return false;
        }
    };

    // APK 是 ZIP 文件，解析 v2 签名块
    // ZIP 结构: [文件数据...] [中央目录] [End of Central Directory (EOCD)]
    // APK Signing Block v2 位于: [文件数据...] [APK Signing Block] [中央目录] [EOCD]
    // Signing Block 魔数: "APK Sig Block 42"

    let file_size = match file.metadata() {
        Ok(m) => m.len() as usize,
        Err(_) => return false,
    };

    // 读取 EOCD (最小 22 字节，在文件末尾)
    let eocd_size = 22usize.min(file_size);
    if file.seek(SeekFrom::Start((file_size - eocd_size) as u64)).is_err() {
        return false;
    }
    let mut eocd = vec![0u8; eocd_size];
    if file.read_exact(&mut eocd).is_err() {
        return false;
    }

    // EOCD 签名: 0x06054b50
    if eocd.len() < 22 || u32::from_le_bytes([eocd[0], eocd[1], eocd[2], eocd[3]]) != 0x06054b50 {
        log::error!("EOCD 签名无效");
        return false;
    }

    // 中央目录偏移量 (EOCD 偏移 16, 4 字节)
    let cd_offset = u32::from_le_bytes([
        eocd[16], eocd[17], eocd[18], eocd[19],
    ]) as usize;

    if cd_offset == 0 || cd_offset >= file_size {
        return false;
    }

    // APK Signing Block 在中央目录之前
    // 读取 Signing Block 尾部 (24 字节: 8字节block大小 + 16字节魔数)
    let sb_tail_size = 24usize;
    if cd_offset < sb_tail_size {
        return false;
    }

    if file.seek(SeekFrom::Start((cd_offset - sb_tail_size) as u64)).is_err() {
        return false;
    }
    let mut sb_tail = vec![0u8; sb_tail_size];
    if file.read_exact(&mut sb_tail).is_err() {
        return false;
    }

    // 检查魔数 "APK Sig Block 42"
    let magic = &sb_tail[8..24];
    if magic != b"APK Sig Block 42" {
        log::warn!("未找到 APK Signing Block v2，可能只有 v1 签名");
        return true;
    }

    // Signing Block 大小 (8字节 LE)
    let sb_size = u64::from_le_bytes([
        sb_tail[0], sb_tail[1], sb_tail[2], sb_tail[3],
        sb_tail[4], sb_tail[5], sb_tail[6], sb_tail[7],
    ]) as usize;

    if sb_size < sb_tail_size || cd_offset < sb_size {
        return false;
    }

    // 读取整个 Signing Block
    let sb_start = cd_offset - sb_size;
    if file.seek(SeekFrom::Start(sb_start as u64)).is_err() {
        return false;
    }
    let mut sb = vec![0u8; sb_size];
    if file.read_exact(&mut sb).is_err() {
        return false;
    }

    // Signing Block 结构:
    // [8字节 size][键值对...][8字节 size][16字节 magic]
    // 键值对: [8字节 length][4字节 id][data]
    // v2 签名块 id = 0x7109871a, v3 = 0xf05368c0

    let mut pos = 8usize; // 跳过开头的 size
    let end = sb_size - 24; // 减去尾部的 size + magic

    while pos + 12 <= end {
        let pair_len = u64::from_le_bytes([
            sb[pos], sb[pos+1], sb[pos+2], sb[pos+3],
            sb[pos+4], sb[pos+5], sb[pos+6], sb[pos+7],
        ]) as usize;
        pos += 8;

        if pos + 4 > end || pair_len < 4 {
            break;
        }

        let block_id = u32::from_le_bytes([
            sb[pos], sb[pos+1], sb[pos+2], sb[pos+3],
        ]);
        pos += 4;

        let data_len = pair_len - 4;
        if pos + data_len > end {
            break;
        }

        // v2/v3 签名块
        if block_id == 0x7109871a || block_id == 0xf05368c0 {
            // v2/v3 签名块结构:
            // [8字节 signers length][signers data...]
            // signers: [8字节 length][signed data][signatures][public key]
            // signed data: [8字节 digests length][digests...]
            //              [8字节 certificates length][certificates...]
            //              [8字节 additional attributes]

            let data = &sb[pos..pos + data_len];
            if data.len() < 8 {
                break;
            }

            let signers_len = u64::from_le_bytes([
                data[0], data[1], data[2], data[3],
                data[4], data[5], data[6], data[7],
            ]) as usize;

            if 8 + signers_len > data.len() {
                break;
            }

            let signers = &data[8..8 + signers_len];
            if signers.len() < 8 {
                break;
            }

            let signer_len = u64::from_le_bytes([
                signers[0], signers[1], signers[2], signers[3],
                signers[4], signers[5], signers[6], signers[7],
            ]) as usize;

            if 8 + signer_len > signers.len() {
                break;
            }

            let signer = &signers[8..8 + signer_len];
            if signer.len() < 8 {
                break;
            }

            // signed_data length
            let sd_len = u64::from_le_bytes([
                signer[0], signer[1], signer[2], signer[3],
                signer[4], signer[5], signer[6], signer[7],
            ]) as usize;

            if 8 + sd_len > signer.len() {
                break;
            }

            let signed_data = &signer[8..8 + sd_len];
            if signed_data.len() < 8 {
                break;
            }

            // digests length (跳过)
            let digests_len = u64::from_le_bytes([
                signed_data[0], signed_data[1], signed_data[2], signed_data[3],
                signed_data[4], signed_data[5], signed_data[6], signed_data[7],
            ]) as usize;

            if 8 + digests_len + 8 > signed_data.len() {
                break;
            }

            // certificates length
            let cert_offset = 8 + digests_len;
            let certs_len = u64::from_le_bytes([
                signed_data[cert_offset], signed_data[cert_offset+1],
                signed_data[cert_offset+2], signed_data[cert_offset+3],
                signed_data[cert_offset+4], signed_data[cert_offset+5],
                signed_data[cert_offset+6], signed_data[cert_offset+7],
            ]) as usize;

            if cert_offset + 8 + certs_len > signed_data.len() {
                break;
            }

            // 第一个证书
            let certs_data = &signed_data[cert_offset + 8..cert_offset + 8 + certs_len];
            if certs_data.len() < 4 {
                break;
            }

            let cert_len = u32::from_le_bytes([
                certs_data[0], certs_data[1], certs_data[2], certs_data[3],
            ]) as usize;

            if 4 + cert_len > certs_data.len() {
                break;
            }

            let cert_der = &certs_data[4..4 + cert_len];

            // 计算 SHA-256
            use sha2::{Sha256, Digest};
            let mut hasher = Sha256::new();
            hasher.update(cert_der);
            let hash = hasher.finalize();
            let hash_hex: String = hash.iter().map(|b| format!("{:02x}", b)).collect();

            log::info!("APK 签名证书 SHA-256: {}", hash_hex);

            if hash_hex == PINNED_CERT_SHA256 {
                log::info!("签名校验通过");
                return true;
            } else {
                log::error!("签名校验失败！期望: {}，实际: {}", PINNED_CERT_SHA256, hash_hex);
                return false;
            }
        }

        pos += data_len;
    }

    log::warn!("未找到 v2/v3 签名块");
    true
}

// ===== 应用入口 =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Android 签名证书固定校验
    if !verify_android_signature() {
        log::error!("签名校验失败！APK 可能被篡改，拒绝启动。");
        // 在移动端无法弹出系统对话框，直接 return 退出
        return;
    }
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
            sync_fetch_remote,
            sync_merge_config,
            sync_overwrite_config,
            sync_decrypt_payload,
            p2p_start_server,
            p2p_stop_server,
            p2p_get_status,
            p2p_refresh_payload,
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
