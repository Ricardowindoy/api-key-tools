//! 配置数据结构与文件读写
//! 替代原 server.js 的 config 模块，支持任意厂商

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

/// 单个 API Key
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    pub name: String,
    pub key: String,
    #[serde(default)]
    pub selected: bool,
}

/// 单个厂商的配置段
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub keys: Vec<ApiKey>,
    #[serde(default)]
    pub selected_model: String,
}

/// 完整配置：provider 名 → 配置
pub type Config = BTreeMap<String, ProviderConfig>;

/// widget 端用的简化视图
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetProviderInfo {
    pub base_url: String,
    pub key_name: String,
    pub key_value: String,
    pub selected_model: String,
}

/// 获取配置文件路径（位于 userData 目录）
pub fn config_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

/// widget-state.json 路径（位置 + 主题）
pub fn widget_state_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    fs::create_dir_all(&dir).ok();
    dir.join("widget-state.json")
}

/// app-state.json 路径（主窗口主题）
pub fn app_state_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    fs::create_dir_all(&dir).ok();
    dir.join("app-state.json")
}

/// 读取并迁移旧配置（单 key 字段 → keys 数组）
pub fn load_config(app: &tauri::AppHandle) -> Config {
    let path = config_path(app);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Config::new(),
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Config::new(),
    };
    let mut out = Config::new();
    if let Some(obj) = value.as_object() {
        for (name, section) in obj {
            if let Some(section_obj) = section.as_object() {
                let base_url = section_obj
                    .get("baseUrl")
                    .or_else(|| section_obj.get("base_url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let selected_model = section_obj
                    .get("selectedModel")
                    .or_else(|| section_obj.get("selected_model"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let keys = if let Some(arr) = section_obj
                    .get("keys")
                    .and_then(|v| v.as_array())
                {
                    arr.iter()
                        .filter_map(|k| serde_json::from_value::<ApiKey>(k.clone()).ok())
                        .collect()
                } else if let Some(single) = section_obj.get("key").and_then(|v| v.as_str()) {
                    vec![ApiKey {
                        id: "default".into(),
                        name: "默认".into(),
                        key: single.to_string(),
                        selected: true,
                    }]
                } else {
                    Vec::new()
                };
                out.insert(
                    name.clone(),
                    ProviderConfig {
                        base_url,
                        keys,
                        selected_model,
                    },
                );
            }
        }
    }
    out
}

/// 保存完整配置
pub fn save_config(app: &tauri::AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app);
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| e.to_string())
}

/// 定向更新选中项（避免全量覆写导致并发数据丢失）
pub fn save_select(
    app: &tauri::AppHandle,
    provider: &str,
    key_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<(), String> {
    let mut cfg = load_config(app);
    let entry = cfg.entry(provider.to_string()).or_default();
    if let Some(kid) = key_id {
        for k in &mut entry.keys {
            k.selected = k.id == kid;
        }
    }
    if let Some(mid) = model_id {
        entry.selected_model = mid.to_string();
    }
    save_config(app, &cfg)
}

/// 生成 widget 端简化视图
pub fn widget_view(app: &tauri::AppHandle) -> BTreeMap<String, WidgetProviderInfo> {
    let cfg = load_config(app);
    let mut out = BTreeMap::new();
    for (name, section) in cfg {
        let selected_key = section
            .keys
            .iter()
            .find(|k| k.selected)
            .or_else(|| section.keys.first())
            .cloned()
            .unwrap_or_else(|| ApiKey {
                id: String::new(),
                name: String::new(),
                key: String::new(),
                selected: false,
            });
        out.insert(
            name,
            WidgetProviderInfo {
                base_url: section.base_url,
                key_name: selected_key.name,
                key_value: selected_key.key,
                selected_model: section.selected_model,
            },
        );
    }
    out
}
