//! HTTP 模型拉取，调用厂商 /v1/models 接口
//! 替代原 server.js 的 fetchModels

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub description: String,
}

/// OpenAI 标准响应格式
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<RawModel>>,
    models: Option<Vec<RawModel>>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    id: Option<String>,
    model: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    message: Option<String>,
}

/// 拉取模型列表
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
    provider: &str,
) -> Result<Vec<ModelInfo>, String> {
    if api_key.is_empty() {
        return Ok(Vec::new());
    }
    if base_url.is_empty() {
        return Err("缺少 baseUrl".into());
    }

    let base = base_url.trim_end_matches('/');
    let url = format!("{}/models", base);
    log::info!("获取模型列表: {} url={}", provider, url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(&url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message").and_then(|m| m.as_str()).map(String::from))
                    .or_else(|| e.as_str().map(String::from))
            })
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        log::error!("获取模型失败: {} {}", provider, msg);
        return Err(msg);
    }

    let parsed: ModelsResponse =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    if let Some(err) = parsed.error {
        let msg = err.message.unwrap_or_else(|| "未知错误".into());
        log::error!("获取模型失败: {} {}", provider, msg);
        return Err(msg);
    }

    let raw_list = parsed.data.or(parsed.models).unwrap_or_default();
    let models: Vec<ModelInfo> = raw_list
        .into_iter()
        .filter_map(|m| {
            let id = m.id.or(m.model)?;
            if id.is_empty() {
                None
            } else {
                Some(ModelInfo {
                    id,
                    description: m.description.unwrap_or_default(),
                })
            }
        })
        .collect();

    log::info!("获取模型成功: {} 共 {} 个", provider, models.len());
    Ok(models)
}
