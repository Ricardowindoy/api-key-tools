//! 窗口状态管理：widget 位置、主题持久化

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config::{app_state_path, widget_state_path};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WidgetState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string(value).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

// ===== Widget 状态 =====

pub fn load_widget_state(app: &tauri::AppHandle) -> WidgetState {
    read_json(&widget_state_path(app))
}

pub fn save_widget_state(app: &tauri::AppHandle, state: &WidgetState) -> Result<(), String> {
    write_json(&widget_state_path(app), state)
}

/// 合并写入 widget-state 的部分字段
pub fn patch_widget_state<F>(app: &tauri::AppHandle, patch_fn: F) -> Result<(), String>
where
    F: FnOnce(&mut WidgetState),
{
    let mut state = load_widget_state(app);
    patch_fn(&mut state);
    save_widget_state(app, &state)
}

pub fn clear_widget_position(app: &tauri::AppHandle) -> Result<(), String> {
    patch_widget_state(app, |s| {
        s.x = None;
        s.y = None;
        s.display_id = None;
    })
}

// ===== App 状态 =====

pub fn load_app_state(app: &tauri::AppHandle) -> AppState {
    read_json(&app_state_path(app))
}

pub fn save_app_state(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    write_json(&app_state_path(app), state)
}

pub fn load_theme(app: &tauri::AppHandle) -> String {
    // 优先 app-state，其次 widget-state
    let app_state = load_app_state(app);
    if let Some(t) = app_state.theme {
        return t;
    }
    let widget_state = load_widget_state(app);
    widget_state.theme.unwrap_or_else(|| "dark".into())
}
