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

/// 获取应用数据目录，确保存在且可写。
/// 结果会被缓存，只探测一次。
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use std::sync::OnceLock;
    static DATA_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

    if let Some(cached) = DATA_DIR.get() {
        return cached.clone().ok_or("数据目录不可用".into());
    }

    use tauri::Manager;
    // 候选路径，按可靠性排序：
    // 1. exe 同级目录（最可靠，因为 exe 在用户目录里）
    // 2. Tauri 的 app_data_dir
    // 3. %APPDATA%\apikeymanager
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let candidates: Vec<PathBuf> = vec![
        exe_dir.join("data"),
        app.path().app_data_dir().unwrap_or_default(),
        std::env::var("APPDATA")
            .map(|s| PathBuf::from(s).join("apikeymanager"))
            .unwrap_or_else(|_| PathBuf::new()),
    ];

    let mut chosen: Option<PathBuf> = None;
    for dir in &candidates {
        if dir.as_os_str().is_empty() {
            continue;
        }
        log::info!("尝试数据目录候选: {:?}", dir);
        if let Err(e) = fs::create_dir_all(dir) {
            log::warn!("创建目录 {:?} 失败: {}", dir, e);
            continue;
        }
        // 验证可写：创建一个测试文件
        let test = dir.join(".write_test");
        if std::fs::File::create(&test).is_ok() {
            let _ = std::fs::remove_file(&test);
            log::info!("数据目录已验证可写: {:?}", dir);
            chosen = Some(dir.clone());
            break;
        } else {
            log::warn!("目录 {:?} 不可写，尝试下一个", dir);
        }
    }

    let result = chosen.clone().ok_or_else(|| "无法找到可写的数据目录".to_string());
    let _ = DATA_DIR.set(chosen);
    result
}

/// 获取配置文件路径（位于 userData 目录）
pub fn config_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

/// widget-state.json 路径（位置 + 主题）
pub fn widget_state_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("widget-state.json")
}

/// app-state.json 路径（主窗口主题）
pub fn app_state_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("app-state.json")
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
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, s).map_err(|e| format!("写入 {:?} 失败: {}", path, e))
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
