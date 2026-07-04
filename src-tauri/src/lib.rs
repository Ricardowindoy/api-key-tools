//! API Key Manager - Tauri 应用主入口
//! 完整 Rust 重写，替代原 Electron + Node.js 架构

mod config;
mod models;
mod state;

use config::{Config, WidgetProviderInfo};
use models::ModelInfo;
use std::collections::BTreeMap;

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
