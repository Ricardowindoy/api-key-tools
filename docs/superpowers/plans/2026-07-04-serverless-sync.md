# 无服务器多端同步方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不部署任何服务器的前提下，实现跨设备双向同步 API Key 配置（加密存储 + 自动推送/拉取）。

**Architecture:** 采用 GitHub Gist 作为免费加密存储后端。用户只需提供一个 GitHub Personal Access Token（gist 权限），应用通过 Gist API 自动推送加密配置和拉取更新。保留现有的"手动 URL 拉取"模式作为备选方案。加密层复用已有的 RSA-2048-OAEP + AES-256-GCM 混合加密。

**Tech Stack:** Rust + Tauri 2.0 + reqwest（HTTP）+ rsa/aes-gcm（加密）+ serde（序列化）+ GitHub Gist REST API v3

---

## 背景与现状分析

### 当前同步架构（已有）

```
设备A（导出加密文件）──手动上传──> 静态托管URL
                                      |
设备B（输入URL + 私钥）──GET拉取──> 解密 → 合并
```

**痛点：**
1. 单向同步：只能拉取，不能推送。每次在设备A修改配置后，需要手动导出文件、手动上传到托管服务
2. 手动操作多：导出 → 切换到浏览器 → 上传到 Gist/Pastebin → 复制 raw URL → 回到应用粘贴
3. 无版本管理：无法回滚到之前的配置
4. 多设备协作困难：设备B 修改后无法推回去，只能再走一遍手动导出流程

### 方案对比

| 方案 | 免费 | 双向同步 | 无需运维 | 跨平台 | 复杂度 |
|------|------|----------|----------|--------|--------|
| GitHub Gist API | ✅ | ✅（push+pull） | ✅ | ✅ | 中 |
| WebDAV | 视服务 | ✅ | ❌（需配置服务） | ✅ | 中 |
| 手动 URL（现有） | ✅ | ❌（仅拉取） | ✅ | ✅ | 低 |
| 自建服务器 | ❌ | ✅ | ❌ | ✅ | 高 |
| P2P 局域网 | ✅ | ✅ | ✅ | ❌（仅同局域网） | 高 |

**结论：GitHub Gist 是最优解** —— 免费、零运维、双向、跨平台、自带版本历史。

### 新架构设计

```
设备A                         GitHub Gist（加密存储）
  |                                  |
  |--POST /gists (push加密配置)----->|
  |<--GET /gists/{id} (pull)--------|
  |                                  |
设备B                               |
  |--GET /gists/{id} (pull)-------->|
  |<--加密payload-------------------|
  |--PATCH /gists/{id} (push)------>|
```

**关键设计决策：**
1. **Gist ID 存储在 SyncState 中**，首次 push 时创建 Gist，后续 push 用 PATCH 更新
2. **Token 仅存本地**，不加密（因为加解密用的是 RSA 密钥对，Token 只是 Gist 访问凭证）
3. **加密 payload 不变**，复用现有 `EncryptedPayload` 结构
4. **合并策略不变**，复用现有 `sync_merge_config` 逻辑
5. **Token 可选**：不配 Token 时退化为"手动 URL 拉取"模式（现有行为）

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/gist.rs` | GitHub Gist API 客户端：push（创建/更新 Gist）、pull（读取 Gist content）、删除 Gist |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src-tauri/src/state.rs` | `SyncState` 新增 `gist_token`、`gist_id` 字段 |
| `src-tauri/src/lib.rs` | 新增 `sync_push_gist`、`sync_pull_gist`、`sync_delete_gist` 三个 Tauri 命令并注册 |
| `src-tauri/src/sync.rs` | 新增 `encrypt_config_to_payload`（返回结构体而非字符串，供 gist 模块使用） |
| `public/app.js` | 同步弹窗新增 Gist Token 输入区、Push 按钮、自动同步改用 Gist push/pull |
| `public/index.html` | 同步弹窗新增 Gist 配置区域 HTML |
| `public/app.css` | Gist 区域样式 |

---

## Task 1: SyncState 扩展 —— 新增 Gist 字段

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 在 `SyncState` 结构体中新增 Gist 字段**

在 `src-tauri/src/state.rs` 的 `SyncState` 结构体中，在 `last_sync_error` 字段之后新增三个字段：

```rust
    /// GitHub Gist Personal Access Token（gist 权限）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gist_token: Option<String>,
    /// GitHub Gist ID（首次 push 后自动保存）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gist_id: Option<String>,
    /// Gist 文件名（固定值，用于读写 Gist content）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gist_filename: Option<String>,
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无错误（新字段有 `#[serde(default)]`，不会破坏已有 JSON 文件的反序列化）

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(sync): add gist fields to SyncState"
```

---

## Task 2: Gist API 客户端模块

**Files:**
- Create: `src-tauri/src/gist.rs`
- Modify: `src-tauri/src/lib.rs`（注册模块）

- [ ] **Step 1: 创建 `src-tauri/src/gist.rs`**

```rust
//! GitHub Gist API 客户端
//!
//! 用于无服务器多端同步：将加密配置推送到 Gist，或从 Gist 拉取加密配置。
//! 用户需提供 GitHub Personal Access Token（仅需 gist 权限）。

use serde::{Deserialize, Serialize};

const GIST_API_BASE: &str = "https://api.github.com/gists";
const GIST_FILENAME: &str = "api-key-config.enc.json";

/// Gist 创建/更新响应
#[derive(Debug, Deserialize)]
struct GistResponse {
    id: String,
}

/// Gist content 响应
#[derive(Debug, Deserialize)]
struct GistContentResponse {
    files: serde_json::Map<serde_json::Value>,
}

/// Gist 中单个文件的内容
#[derive(Debug, Deserialize)]
struct GistFile {
    content: String,
}

/// 推送加密配置到 Gist。
/// 如果 `gist_id` 为 None，创建新 Gist；否则更新已有 Gist。
/// 返回 (gist_id, gist_filename)。
pub async fn push_gist(
    token: &str,
    gist_id: Option<&str>,
    encrypted_json: &str,
) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .user_agent("api-key-manager-sync/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let body = serde_json::json!({
        "description": "API Key Manager encrypted config",
        "public": false,
        "files": {
            GIST_FILENAME: {
                "content": encrypted_json
            }
        }
    });

    let url = match gist_id {
        Some(id) => format!("{}/{}", GIST_API_BASE, id),
        None => GIST_API_BASE.to_string(),
    };

    let method = if gist_id.is_some() { "PATCH" } else { "POST" };

    let req = if method == "POST" {
        client.post(&url)
    } else {
        client.patch(&url)
    };

    let resp = req
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gist 请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Gist {} 失败 ({}): {}", method, status, text));
    }

    let gist_resp: GistResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析 Gist 响应失败: {}", e))?;

    Ok((gist_resp.id, GIST_FILENAME.to_string()))
}

/// 从 Gist 拉取加密配置内容。
/// 返回加密 JSON 字符串。
pub async fn pull_gist(token: &str, gist_id: &str, filename: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("api-key-manager-sync/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/{}", GIST_API_BASE, gist_id);

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("Gist 请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Gist 拉取失败 ({}): {}", status, text));
    }

    let gist_resp: GistContentResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析 Gist 响应失败: {}", e))?;

    let file = gist_resp
        .files
        .get(filename)
        .ok_or_else(|| format!("Gist 中未找到文件: {}", filename))?;

    let file: GistFile = serde_json::from_value(file.clone())
        .map_err(|e| format!("解析 Gist 文件内容失败: {}", e))?;

    Ok(file.content)
}

/// 删除 Gist
pub async fn delete_gist(token: &str, gist_id: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("api-key-manager-sync/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/{}", GIST_API_BASE, gist_id);

    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("Gist 请求失败: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Gist 删除失败: {}", text));
    }

    Ok(())
}
```

- [ ] **Step 2: 在 `lib.rs` 中注册模块**

在 `src-tauri/src/lib.rs` 顶部的 `mod` 声明区域，添加：

```rust
mod gist;
```

（放在 `mod sync;` 之后即可）

- [ ] **Step 3: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/gist.rs src-tauri/src/lib.rs
git commit -m "feat(sync): add GitHub Gist API client module"
```

---

## Task 3: Tauri 命令 —— sync_push_gist

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 添加 `sync_push_gist` 命令**

在 `src-tauri/src/lib.rs` 中，在现有 `sync_encrypt_config` 命令之后添加：

```rust
/// 推送加密配置到 GitHub Gist
#[tauri::command]
async fn sync_push_gist(app: tauri::AppHandle) -> Result<(), String> {
    let ss = state::load_sync_state(&app);
    let token = ss.gist_token.clone().ok_or("未配置 GitHub Token")?;
    let pub_key = ss.public_key_pem.clone().ok_or("未配置公钥，无法加密")?;
    let cfg = config::load_config(&app);

    // 加密配置
    let encrypted_json = sync::encrypt_config_to_string(&pub_key, &cfg)?;

    // 推送到 Gist
    let gist_id = ss.gist_id.as_deref();
    let (new_gist_id, filename) = gist::push_gist(&token, gist_id, &encrypted_json).await?;

    // 保存 gist_id
    state::patch_sync_state(&app, |s| {
        s.gist_id = Some(new_gist_id);
        s.gist_filename = Some(filename);
    })?;

    Ok(())
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(sync): add sync_push_gist command"
```

---

## Task 4: Tauri 命令 —— sync_pull_gist

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 添加 `sync_pull_gist` 命令**

在 `sync_push_gist` 命令之后添加：

```rust
/// 从 GitHub Gist 拉取并解密配置
#[tauri::command]
async fn sync_pull_gist(app: tauri::AppHandle) -> Result<config::Config, String> {
    let ss = state::load_sync_state(&app);
    let token = ss.gist_token.clone().ok_or("未配置 GitHub Token")?;
    let gist_id = ss.gist_id.clone().ok_or("未配置 Gist ID（请先推送）")?;
    let filename = ss
        .gist_filename
        .clone()
        .unwrap_or_else(|| "api-key-config.enc.json".to_string());
    let priv_key = ss
        .private_key_pem
        .clone()
        .ok_or("未配置私钥，无法解密")?;

    // 从 Gist 拉取加密内容
    let encrypted_json = gist::pull_gist(&token, &gist_id, &filename).await?;

    // 解析为 EncryptedPayload
    let payload: sync::EncryptedPayload =
        serde_json::from_str(&encrypted_json).map_err(|e| format!("解析加密 payload 失败: {}", e))?;

    // 解密
    let remote_config = sync::decrypt_config(&priv_key, &payload)?;

    // 更新同步状态
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let _ = state::patch_sync_state(&app, |s| {
        s.last_sync_at = Some(now);
        s.last_sync_ok = Some(true);
        s.last_sync_error = None;
    });

    Ok(remote_config)
}
```

- [ ] **Step 2: 将 `EncryptedPayload` 设为 pub**

在 `src-tauri/src/sync.rs` 中，确保 `EncryptedPayload` 结构体是 `pub` 的（检查现有代码，它已经是 `pub struct`）。同时确保 `decrypt_config` 函数也是 `pub` 的（检查现有代码，它已经是 `pub fn`）。

- [ ] **Step 3: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/sync.rs
git commit -m "feat(sync): add sync_pull_gist command"
```

---

## Task 5: Tauri 命令 —— sync_set_gist_token & sync_delete_gist

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 添加 `sync_set_gist_token` 和 `sync_delete_gist` 命令**

在 `sync_pull_gist` 命令之后添加：

```rust
/// 设置 GitHub Gist Token
#[tauri::command]
fn sync_set_gist_token(app: tauri::AppHandle, token: Option<String>) -> Result<(), String> {
    state::patch_sync_state(&app, |s| {
        s.gist_token = token;
    })
}

/// 删除 GitHub Gist（清除云端数据）
#[tauri::command]
async fn sync_delete_gist(app: tauri::AppHandle) -> Result<(), String> {
    let ss = state::load_sync_state(&app);
    let token = ss.gist_token.clone().ok_or("未配置 GitHub Token")?;
    let gist_id = ss.gist_id.clone().ok_or("未配置 Gist ID")?;

    gist::delete_gist(&token, &gist_id).await?;

    // 清除本地 gist_id
    state::patch_sync_state(&app, |s| {
        s.gist_id = None;
        s.gist_filename = None;
    })?;

    Ok(())
}
```

- [ ] **Step 2: 注册新命令到 `generate_handler!`**

在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler!` 宏中，找到现有 `sync_*` 命令列表，在最后添加四个新命令：

```rust
        sync_push_gist,
        sync_pull_gist,
        sync_set_gist_token,
        sync_delete_gist,
```

放在 `sync_overwrite_config` 之后即可。

- [ ] **Step 3: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(sync): add gist token and delete commands"
```

---

## Task 6: 前端 HTML —— 同步弹窗新增 Gist 配置区域

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 在同步弹窗的「同步地址」section 之后，新增「Gist 同步」section**

在 `public/index.html` 的 `syncModal` 中，找到 `<!-- 同步 URL -->` 对应的 `<div class="sync-section">` 结束标签 `</div>` 之后，`<!-- 密钥管理 -->` 之前，插入：

```html
        <!-- Gist 同步 -->
        <div class="sync-section">
          <div class="sync-section-title">🌐 GitHub Gist 同步（推荐）</div>
          <div class="sync-row">
            <input class="input sync-url-input" id="gistTokenInput" placeholder="GitHub Personal Access Token（gist 权限）" autocomplete="off" spellcheck="false" type="password" />
            <button class="btn-save-key" id="gistSaveTokenBtn">保存</button>
          </div>
          <div class="sync-hint">
            在 GitHub Settings → Developer settings → Personal access tokens → Generate new token（classic），勾选 <code>gist</code> 权限即可。Token 仅保存在本地。
          </div>
          <div class="sync-gist-status" id="gistStatus" style="margin-top:10px;display:none;"></div>
          <div class="sync-row sync-key-actions" style="margin-top:10px;">
            <button class="btn-save-key" id="gistPushBtn">⬆ 推送到 Gist</button>
            <button class="btn-cancel-key" id="gistPullBtn">⬇ 从 Gist 拉取</button>
            <button class="btn-cancel-key" id="gistDeleteBtn" style="background:var(--red);color:#fff;">删除 Gist</button>
          </div>
        </div>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat(sync): add Gist config section to sync modal HTML"
```

---

## Task 7: 前端 JS —— Gist 同步逻辑

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 在 `syncRenderState()` 函数中，渲染 Gist Token 状态**

在 `public/app.js` 的 `syncRenderState()` 函数末尾（在 `// 上次同步信息` block 之后），新增 Gist 状态渲染：

```javascript
  // Gist Token 状态
  const gistTokenInput = document.getElementById("gistTokenInput");
  if (gistTokenInput && gistTokenInput.value !== (syncState.gist_token || "")) {
    gistTokenInput.value = syncState.gist_token || "";
  }

  const gistStatus = document.getElementById("gistStatus");
  if (gistStatus) {
    if (syncState.gist_token && syncState.gist_id) {
      gistStatus.innerHTML = `<span style="color:var(--green);">✓ 已连接（Gist ID: ${syncState.gist_id.slice(0, 8)}...）</span>`;
      gistStatus.style.display = "";
    } else if (syncState.gist_token) {
      gistStatus.innerHTML = `<span style="color:var(--yellow);">⚠ Token 已配置，但尚未推送（首次推送将创建 Gist）</span>`;
      gistStatus.style.display = "";
    } else {
      gistStatus.style.display = "none";
    }
  }
```

- [ ] **Step 2: 新增 Gist 操作函数**

在 `public/app.js` 中，在 `async function syncExport()` 函数之后，新增以下函数：

```javascript
// ===== Gist 同步 =====
async function gistSaveToken() {
  const input = document.getElementById("gistTokenInput");
  const token = input?.value.trim() || null;
  try {
    await invoke("sync_set_gist_token", { token });
    if (syncState) syncState.gist_token = token;
    syncRenderState();
    toast(token ? "GitHub Token 已保存" : "已清除 GitHub Token");
    syncLog(token ? "GitHub Token 已配置" : "已清除 GitHub Token", "info");
  } catch (e) {
    toast("保存失败: " + (e?.message || e), "error");
  }
}

async function gistPush() {
  if (!syncState?.gist_token) { toast("请先配置 GitHub Token", "error"); return; }
  if (!syncState?.public_key_pem) { toast("请先配置公钥（用于加密）", "error"); return; }

  const btn = document.getElementById("gistPushBtn");
  if (btn) { btn.disabled = true; btn.textContent = "推送中..."; }
  syncLog("正在推送到 Gist...", "info");

  try {
    await invoke("sync_push_gist");
    await syncLoadState();
    syncRenderState();
    toast("已推送到 Gist");
    syncLog("推送成功", "success");
  } catch (e) {
    const msg = e?.message || e;
    toast("推送失败: " + msg, "error");
    syncLog("推送失败: " + msg, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬆ 推送到 Gist"; }
  }
}

async function gistPull(silent = false) {
  if (!syncState?.gist_token) { if (!silent) toast("请先配置 GitHub Token", "error"); return; }
  if (!syncState?.gist_id) { if (!silent) toast("尚未推送过，请先推送", "error"); return; }
  if (!syncState?.private_key_pem) { if (!silent) toast("请先配置私钥（用于解密）", "error"); return; }

  if (!silent) syncLog("正在从 Gist 拉取...", "info");

  try {
    const remote = await invoke("sync_pull_gist");

    if (silent) {
      // 自动同步默认合并
      await invoke("sync_merge_config", { remote });
      await loadConfig();
      renderAllCards();
      const providers = Object.keys(remote);
      const totalKeys = providers.reduce((sum, p) => sum + (remote[p]?.keys?.length || 0), 0);
      syncLog(`自动同步完成：${providers.length} 个厂商，${totalKeys} 个 Key`, "success");
    } else {
      // 手动同步：弹窗确认
      pendingRemoteConfig = remote;
      const providers = Object.keys(remote);
      const totalKeys = providers.reduce((sum, p) => sum + (remote[p]?.keys?.length || 0), 0);
      const body = document.getElementById("syncConfirmBody");
      if (body) {
        body.innerHTML = `
          <p>从 Gist 获取到：</p>
          <ul style="margin:8px 0;padding-left:20px;">
            <li>${providers.length} 个厂商</li>
            <li>${totalKeys} 个 API Key</li>
          </ul>
          <p style="margin-top:8px;font-size:13px;color:var(--txt-b);">选择同步方式：</p>
        `;
      }
      document.getElementById("syncConfirmModal").style.display = "";
    }

    await syncLoadState();
  } catch (e) {
    const msg = e?.message || e;
    if (!silent) {
      toast("拉取失败: " + msg, "error");
      syncLog("拉取失败: " + msg, "error");
    } else {
      syncLog("自动同步失败: " + msg, "error");
    }
    await syncLoadState();
  }
}

async function gistDelete() {
  if (!syncState?.gist_token) { toast("请先配置 GitHub Token", "error"); return; }
  if (!syncState?.gist_id) { toast("尚未推送过，无 Gist 可删除", "error"); return; }
  if (!confirm("确定要删除 Gist 上的加密配置吗？此操作不可撤销。")) return;

  try {
    await invoke("sync_delete_gist");
    await syncLoadState();
    syncRenderState();
    toast("Gist 已删除");
    syncLog("已删除 Gist", "info");
  } catch (e) {
    toast("删除失败: " + (e?.message || e), "error");
  }
}
```

- [ ] **Step 3: 在 `main()` 函数中绑定 Gist 事件**

在 `public/app.js` 的 `main()` 函数中，在现有同步事件绑定之后（`document.getElementById("syncExportBtn")?.addEventListener` 之后），新增：

```javascript
  // Gist 同步事件
  document.getElementById("gistSaveTokenBtn")?.addEventListener("click", gistSaveToken);
  document.getElementById("gistPushBtn")?.addEventListener("click", () => gistPush());
  document.getElementById("gistPullBtn")?.addEventListener("click", () => gistPull(false));
  document.getElementById("gistDeleteBtn")?.addEventListener("click", gistDelete);
```

- [ ] **Step 4: 修改自动同步逻辑，优先使用 Gist**

在 `public/app.js` 的 `syncSetupAutoTimer()` 函数中，修改定时器回调，让自动同步优先走 Gist 通道：

```javascript
function syncSetupAutoTimer() {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  const mins = syncState?.auto_sync_interval_min;
  if (mins && mins > 0) {
    autoSyncTimer = setInterval(() => {
      // 优先 Gist 同步，降级 URL 拉取
      if (syncState?.gist_token && syncState?.gist_id) {
        gistPull(true);
      } else {
        syncPull(true);
      }
    }, mins * 60 * 1000);
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(sync): add Gist push/pull/delete UI logic"
```

---

## Task 8: Gist 区域样式

**Files:**
- Modify: `public/app.css`

- [ ] **Step 1: 添加 Gist 状态区域样式**

在 `public/app.css` 中，在 `.sync-footer-note` 样式块之后，新增：

```css
.sync-gist-status {
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--txt-b);
}

.sync-gist-status code {
  background: var(--bg-chip);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--accent-2);
}
```

- [ ] **Step 2: Commit**

```bash
git add public/app.css
git commit -m "style(sync): add gist status styles"
```

---

## Task 9: 更新同步说明文案

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 更新加密说明文案**

在 `public/index.html` 的同步弹窗底部，找到 `<div class="sync-footer-note">`，更新内容为：

```html
        <div class="sync-footer-note">
          <strong>同步方式说明：</strong><br>
          • <strong>Gist 同步（推荐）：</strong>双向自动推送/拉取，只需 GitHub Token，零运维<br>
          • <strong>URL 拉取：</strong>单向拉取，兼容任意静态托管（Gist raw URL、Pastebin、S3 等）<br><br>
          <strong>安全说明：</strong>
          使用 RSA-2048-OAEP + AES-256-GCM 混合加密。公钥加密，私钥解密。
          私钥和 Token 仅保存在本地，不会上传到任何服务器。
        </div>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "docs(sync): update sync method explanation"
```

---

## Task 10: 集成测试 —— 手动验证流程

**Files:**
- 无代码修改，纯验证步骤

- [ ] **Step 1: 本地构建**

Run: `cd src-tauri && cargo build`
Expected: 编译通过，无错误

- [ ] **Step 2: 启动开发模式**

Run: `cd src-tauri && cargo tauri dev`
Expected: 应用正常启动

- [ ] **Step 3: 手动测试 Gist 同步流程**

1. 打开同步弹窗
2. 生成密钥对（RSA-2048）
3. 在 Gist Token 输入框粘贴一个有 gist 权限的 GitHub Token
4. 点击「保存」→ 状态显示"Token 已配置，尚未推送"
5. 点击「推送到 Gist」→ 状态显示"已连接（Gist ID: xxx...）"
6. 在 GitHub 上确认 Gist 已创建（secret Gist，包含 `api-key-config.enc.json` 文件）
7. 修改本地配置（添加/删除一个厂商）
8. 再次推送 → Gist 内容更新
9. 点击「从 Gist 拉取」→ 弹出同步确认弹窗 → 合并 → 本地配置更新
10. 设置自动同步间隔 → 等待触发 → 日志显示自动同步完成

- [ ] **Step 4: 测试降级模式（无 Token）**

1. 清除 Gist Token
2. 配置同步 URL（使用 Gist 的 raw URL）
3. 配置私钥
4. 点击「从 URL 拉取」→ 成功拉取并解密

- [ ] **Step 5: Commit（如果有修复）**

```bash
git add -A
git commit -m "test(sync): manual integration test passed"
```

---

## 用户使用指南（写完代码后告知用户）

### 首次配置（3 分钟）

1. **生成 GitHub Token**：访问 https://github.com/settings/tokens/new → 勾选 `gist` → 生成
2. **打开应用同步设置**：点击右上角 🔄 图标
3. **生成密钥对**：点击「生成密钥对」（RSA-2048，公钥加密、私钥解密）
4. **粘贴 Token**：在「Gist 同步」区域粘贴 Token → 保存
5. **推送**：点击「推送到 Gist」→ 自动创建 secret Gist

### 日常使用

- **自动同步**：设置间隔（如每 5 分钟），应用自动拉取最新配置
- **手动推送**：修改配置后点「推送到 Gist」
- **手动拉取**：点「从 Gist 拉取」→ 选择合并或覆盖

### 多设备同步

设备 B 只需：配置相同的私钥 + 同一个 GitHub Token → 点「从 Gist 拉取」即可同步。

---

## Self-Review

### 1. Spec coverage

- ✅ 无服务器同步：使用 GitHub Gist API，无需部署任何服务器
- ✅ 双向同步：push（创建/更新 Gist）+ pull（读取 Gist）
- ✅ 加密安全：复用现有 RSA-2048-OAEP + AES-256-GCM 混合加密
- ✅ 自动同步：定时器优先 Gist，降级 URL 拉取
- ✅ 兼容现有：保留 URL 拉取模式作为备选
- ✅ 跨平台：Gist API 基于 HTTPS，桌面端和 Android 均可用
- ✅ 零运维：用户只需一个 GitHub Token，Gist 免费、自带版本历史

### 2. Placeholder scan

- 无 TBD / TODO
- 所有代码步骤均包含完整代码
- 所有命令均包含确切路径和预期输出

### 3. Type consistency

- `SyncState` 新增字段：`gist_token`、`gist_id`、`gist_filename`（Task 1 定义，Task 3/4/5 使用）
- `gist::push_gist` 返回 `(String, String)`（Task 2 定义，Task 3 使用）
- `gist::pull_gist` 返回 `String`（Task 2 定义，Task 4 使用）
- `gist::delete_gist` 返回 `()`（Task 2 定义，Task 5 使用）
- `sync::EncryptedPayload` 和 `sync::decrypt_config` 已在现有代码中是 `pub`，Task 4 直接引用
- 前端函数 `gistPush`、`gistPull`、`gistDelete`、`gistSaveToken`（Task 7 定义并绑定事件）

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-04-serverless-sync.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
