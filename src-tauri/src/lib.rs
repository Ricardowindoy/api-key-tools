//! API Key Manager - Tauri 应用主入口
//! 完整 Rust 重写，替代原 Electron + Node.js 架构

mod config;
mod models;
mod state;

use config::{Config, ProviderConfig, WidgetProviderInfo};
use models::ModelInfo;
use state::WidgetState;
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

const WIDGET_COLLAPSED: (u32, u32) = (60, 60);
const WIDGET_EXPANDED: (u32, u32) = (420, 460);

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
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();

    log::info!("API Key Manager 启动中 (Tauri)");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--widget"]),
        ))
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
            widget_show,
            widget_hide,
            get_app_version,
        ])
        .setup(|app| {
            log::info!("应用初始化完成");
            // 初始展示 widget（如有保存位置则恢复）
            use tauri::Manager;
            if let Some(widget) = app.get_webview_window("widget") {
                let state = state::load_widget_state(&app.handle());
                if let (Some(x), Some(y)) = (state.x, state.y) {
                    let _ = widget.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
                }
                let _ = widget.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用时出错");
}
