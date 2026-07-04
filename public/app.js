// ===== State =====
// Tauri 重构版：所有后端调用通过 invoke，不再依赖 HTTP 服务器
const nav = window.__TAURI__;
const core = nav?.core;
const invoke = core?.invoke ? core.invoke.bind(core) : (...args) => Promise.reject("Tauri invoke not available");
console.log("__TAURI__ IPC:", !!core?.invoke);

const state = {}; // { [provider]: { baseUrl, keys, models, selectedModel } }
let saveTimer = null;
let uid = 0;
const genId = () => `k${Date.now()}_${uid++}`;

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

// ===== Toast =====
function toast(msg, type = "success") {
  const c = $(".toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ===== Auto-save =====
function autoSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveConfig, 600); }

// 定向更新选中项
async function saveSelect(provider, { keyId, modelId } = {}) {
  try {
    await invoke("save_select", {
      provider,
      keyId: keyId ?? null,
      modelId: modelId ?? null,
    });
  } catch (e) {
    console.error("save select:", e);
    toast("保存失败: " + (typeof e === 'string' ? e : (e?.message || '未知错误')), "error");
  }
}

async function saveConfig() {
  const config = {};
  // 转换为 Rust 端期望的 snake_case 格式
  Object.keys(state).forEach((p) => {
    config[p] = {
      base_url: state[p].baseUrl,
      keys: state[p].keys,
      selected_model: state[p].selectedModel,
    };
  });
  try {
    await invoke("save_config", { config });
    $$(".badge").forEach((b) => { b.textContent = "已保存"; b.classList.add("saved"); });
  } catch (e) {
    console.error("save:", e);
    toast("保存失败: " + (typeof e === 'string' ? e : (e?.message || '未知错误')), "error");
  }
}

async function loadConfig() {
  try {
    const c = await invoke("get_config");
    Object.keys(state).forEach((p) => delete state[p]);
    Object.keys(c).forEach((p) => {
      const section = c[p] || {};
      state[p] = {
        baseUrl: section.base_url || "",
        keys: Array.isArray(section.keys) ? section.keys : [],
        models: [],
        selectedModel: section.selected_model || "",
      };
    });
  } catch (e) {
    console.error("load:", e);
  }
}

// 从后端刷新（同步 widget 端的选中项变更）
async function refreshFromServer() {
  try {
    const c = await invoke("get_config");
    Object.keys(c).forEach((p) => {
      if (!state[p]) {
        state[p] = { baseUrl: c[p].base_url || "", keys: [], models: [], selectedModel: "" };
      }
      state[p].selectedModel = c[p].selected_model || state[p].selectedModel;
      state[p].baseUrl = c[p].base_url || state[p].baseUrl;
      if (Array.isArray(c[p].keys)) {
        state[p].keys.forEach((localKey) => {
          const serverKey = c[p].keys.find((sk) => sk.id === localKey.id);
          if (serverKey) localKey.selected = !!serverKey.selected;
        });
      }
    });
    renderAllCards();
  } catch (e) {
    console.error("refresh:", e);
  }
}

// ===== Helpers =====
function getSelectedKey(provider) {
  return state[provider]?.keys.find((k) => k.selected) || state[provider]?.keys[0] || { key: "" };
}
function getBaseUrl(provider) {
  return state[provider]?.baseUrl || "";
}
function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 2) + "***";
  return key.slice(0, 6) + "..." + key.slice(-4);
}
function normalizeModels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => {
      if (typeof m === "string") return { id: m, description: "" };
      return { id: m.id || m.model || m.name || "", description: m.description || "" };
    })
    .filter((m) => m.id);
}

// ===== 动态卡片渲染 =====
function renderAllCards() {
  const container = document.getElementById("cardsContainer");
  container.innerHTML = "";
  const providers = Object.keys(state).sort();
  providers.forEach((p) => { renderCard(p); });
}

function renderCard(provider) {
  const container = document.getElementById("cardsContainer");
  if (document.querySelector(`[data-provider="${provider}"]`)) return;

  const card = document.createElement("section");
  card.className = "card";
  card.dataset.provider = provider;

  card.innerHTML = `
    <div class="card-top">
      <div class="card-identity">
        <div class="avatar avatar-dynamic">${provider.charAt(0).toUpperCase()}</div>
        <div>
          <div class="card-name">${provider}</div>
          <div class="card-sub">${state[provider].baseUrl || "未配置 Base URL"}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="badge" id="badge-${provider}"></span>
        <button class="btn-delete-provider" data-provider="${provider}" title="删除此厂商">✕</button>
      </div>
    </div>

    <div class="card-form">
      <div class="key-manage">
        <div class="key-manage-header">
          <label>已保存的 Key</label>
          <button class="btn-add-key" data-provider="${provider}">+ 添加</button>
        </div>
        <div class="key-list" id="keylist-${provider}"></div>
        <div class="key-add-form" id="keyform-${provider}" style="display:none;">
          <input class="input" id="newname-${provider}" placeholder="备注名（如：主号）" />
          <input class="input" id="newkey-${provider}" placeholder="sk-..." autocomplete="off" spellcheck="false" />
          <div class="key-form-actions">
            <button class="btn-save-key" data-provider="${provider}">保存</button>
            <button class="btn-cancel-key" data-provider="${provider}">取消</button>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label>Base URL</label>
        <div class="url-chip" data-provider="${provider}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <code contenteditable="true" class="url-editable" id="urltext-${provider}">${state[provider].baseUrl || ""}</code>
        </div>
      </div>

      <div class="form-group">
        <label>模型</label>
        <div class="select-row">
          <select id="select-${provider}" class="select" disabled>
            <option value="">点击查询加载模型</option>
          </select>
          <button class="btn-refresh" data-provider="${provider}">刷新</button>
        </div>
        <div class="status" id="status-${provider}"></div>
        <div class="model-desc" id="desc-${provider}" style="display:none;"></div>
      </div>
    </div>

    <details class="model-section" open>
      <summary class="model-summary">&#x1F4D6; 模型列表</summary>
      <div class="model-list" id="list-${provider}"></div>
    </details>

    <div class="copy-section" id="copy-${provider}" style="display:none;">
      <div class="copy-row">
        <button class="copy-btn" data-type="baseUrl">Base URL</button>
        <button class="copy-btn" data-type="key">API Key</button>
        <button class="copy-btn" data-type="model">Model</button>
        <button class="copy-btn copy-all" data-type="all">复制全部</button>
      </div>
      <div class="copy-preview">
        <code id="preview-${provider}"></code>
      </div>
    </div>
  `;

  container.appendChild(card);
  initCard(provider);
}

function removeProviderCard(provider) {
  const card = document.querySelector(`[data-provider="${provider}"]`);
  if (card) card.remove();
}

// ===== Render Key List =====
function renderKeyList(provider) {
  const el = document.getElementById(`keylist-${provider}`);
  if (!el) return;
  const data = state[provider];
  if (!data) return;
  const keys = data.keys;
  const selectedId = keys.find((k) => k.selected)?.id || "";

  el.innerHTML = "";
  if (keys.length === 0) {
    el.innerHTML = `<div class="key-empty">暂无 Key，点击上方「+ 添加」</div>`;
    return;
  }

  keys.forEach((k) => {
    const item = document.createElement("div");
    item.className = `key-item${k.id === selectedId ? " active" : ""}`;
    item.dataset.id = k.id;

    const left = document.createElement("div");
    left.className = "key-item-left";

    const nameEl = document.createElement("div");
    nameEl.className = "key-item-name";
    nameEl.textContent = k.name || "未命名";

    const keyEl = document.createElement("div");
    keyEl.className = "key-item-key";
    keyEl.textContent = maskKey(k.key);

    left.appendChild(nameEl);
    left.appendChild(keyEl);
    item.appendChild(left);

    const delBtn = document.createElement("button");
    delBtn.className = "key-item-del";
    delBtn.title = "删除";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeKey(provider, k.id);
    });
    item.appendChild(delBtn);

    item.addEventListener("click", () => {
      selectKey(provider, k.id);
    });

    el.appendChild(item);
  });
}

// ===== Key Operations =====
function addKey(provider, name, key) {
  const id = genId();
  state[provider].keys.push({ id, name: name || `Key ${state[provider].keys.length + 1}`, key, selected: true });
  state[provider].keys.forEach((k) => { if (k.id !== id) k.selected = false; });
  renderKeyList(provider);
  saveConfig();
}

function removeKey(provider, id) {
  const idx = state[provider].keys.findIndex((k) => k.id === id);
  if (idx === -1) return;
  const wasSelected = state[provider].keys[idx].selected;
  state[provider].keys.splice(idx, 1);
  if (wasSelected && state[provider].keys.length > 0) {
    state[provider].keys[0].selected = true;
  }
  renderKeyList(provider);
  saveConfig();
}

function selectKey(provider, id) {
  state[provider].keys.forEach((k) => { k.selected = k.id === id; });
  renderKeyList(provider);
  saveSelect(provider, { keyId: id });
}

// ===== Provider Management =====
async function addProvider(name, baseUrl) {
  if (!name || !baseUrl) { toast("请填写厂商名称和 Base URL", "error"); return; }
  if (state[name]) { toast("厂商 \"" + name + "\" 已存在", "error"); return; }
  state[name] = { baseUrl, keys: [], models: [], selectedModel: "" };
  renderCard(name);
  updateCardSub(name);
  await saveConfig();
  toast("厂商 \"" + name + "\" 已添加");
}

async function deleteProvider(provider) {
  if (!state[provider]) return;
  delete state[provider];
  removeProviderCard(provider);
  await saveConfig();
  toast("厂商已删除");
}

// ===== Model Logic =====
function renderModelList(provider) {
  const el = document.getElementById(`list-${provider}`);
  if (!el) return;
  const data = state[provider];
  if (!data) return;
  const models = data.models;
  const selId = data.selectedModel;
  el.innerHTML = "";
  models.forEach((m) => {
    const item = document.createElement("div");
    item.className = "model-item" + (m.id === selId ? " active" : "");
    item.dataset.id = m.id;
    const name = document.createElement("div");
    name.className = "model-item-name";
    name.textContent = m.id;
    item.appendChild(name);
    if (m.description) {
      const desc = document.createElement("div");
      desc.className = "model-item-desc";
      desc.textContent = m.description;
      item.appendChild(desc);
    }
    item.addEventListener("click", () => {
      state[provider].selectedModel = m.id;
      const select = document.getElementById(`select-${provider}`);
      if (select) select.value = m.id;
      showDesc(provider);
      showCopy(provider);
      el.querySelectorAll(".model-item").forEach((x) => x.classList.remove("active"));
      item.classList.add("active");
    });
    el.appendChild(item);
  });
}

function showDesc(provider) {
  const el = document.getElementById(`desc-${provider}`);
  const id = state[provider]?.selectedModel;
  const desc = state[provider]?.models.find((m) => m.id === id)?.description;
  if (el) {
    if (id && desc) { el.textContent = desc; el.style.display = ""; }
    else el.style.display = "none";
  }
}

function showCopy(provider) {
  const el = document.getElementById(`copy-${provider}`);
  const prev = document.getElementById(`preview-${provider}`);
  const data = state[provider];
  if (!data) return;
  const model = data.selectedModel;
  const key = getSelectedKey(provider).key;
  const baseUrl = getBaseUrl(provider);
  if (model && key) {
    if (el) el.style.display = "";
    if (prev) prev.textContent = `BASE_URL="${baseUrl}"\nAPI_KEY="${key}"\nMODEL="${model}"`;
  } else {
    if (el) el.style.display = "none";
  }
}

function updateCardSub(provider) {
  const card = document.querySelector(`[data-provider="${provider}"]`);
  if (!card) return;
  const sub = card.querySelector(".card-sub");
  if (sub) sub.textContent = state[provider]?.baseUrl || "未配置 Base URL";
}

async function fetchModels(provider) {
  const statusEl = document.getElementById(`status-${provider}`);
  const select = document.getElementById(`select-${provider}`);
  const refreshBtn = document.querySelector(`[data-provider="${provider}"].btn-refresh`);
  const key = getSelectedKey(provider).key;
  const baseUrl = getBaseUrl(provider);

  if (!baseUrl) {
    if (statusEl) { statusEl.textContent = "未配置 Base URL"; statusEl.className = "status error"; }
    return;
  }

  const isBuiltin = !key;
  if (statusEl) {
    statusEl.textContent = isBuiltin ? "未配置 API Key，无法查询模型" : "正在查询…";
    statusEl.className = "status loading";
  }
  if (refreshBtn) refreshBtn.disabled = true;
  if (select) select.disabled = true;

  try {
    const models = await invoke("fetch_models_command", {
      provider,
      baseUrl,
      key,
    });
    const normalized = normalizeModels(models || []);
    state[provider].models = normalized;

    if (select) {
      select.innerHTML = '<option value="">请选择模型</option>';
      normalized.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id; opt.textContent = m.id; opt.title = m.description || "";
        select.appendChild(opt);
      });
    }

    const saved = state[provider].selectedModel;
    if (saved && normalized.some((m) => m.id === saved) && select) select.value = saved;

    renderModelList(provider);
    if (select) select.disabled = false;
    if (statusEl) {
      statusEl.textContent = isBuiltin ? `无 Key，未能查询模型` : `找到 ${normalized.length} 个模型`;
      statusEl.className = "status success";
    }

    if (select && select.value) { showDesc(provider); showCopy(provider); }
    else {
      const cp = document.getElementById(`copy-${provider}`);
      if (cp) cp.style.display = "none";
    }
  } catch (e) {
    const msg = typeof e === "string" ? e : (e.message || "查询失败");
    if (statusEl) { statusEl.textContent = msg; statusEl.className = "status error"; }
    if (select) select.disabled = true;
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

// ===== Copy =====
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(
    () => toast("已复制"),
    () => {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy");
      document.body.removeChild(ta);
      toast("已复制");
    }
  );
}

function handleCopy(e, provider) {
  const type = e.currentTarget.dataset.type;
  const key = getSelectedKey(provider).key;
  const baseUrl = getBaseUrl(provider);
  const model = state[provider]?.selectedModel;
  if (!model) return;
  let text = "";
  switch (type) {
    case "baseUrl": text = baseUrl; break;
    case "key": text = key; break;
    case "model": text = model; break;
    case "all": text = `BASE_URL="${baseUrl}"\nAPI_KEY="${key}"\nMODEL="${model}"`; break;
  }
  if (text) copyToClipboard(text);
}

// ===== Init Card =====
function initCard(provider) {
  const addBtn = document.querySelector(`.btn-add-key[data-provider="${provider}"]`);
  const nameInput = document.getElementById(`newname-${provider}`);
  const keyInput = document.getElementById(`newkey-${provider}`);
  const saveBtn = document.querySelector(`.btn-save-key[data-provider="${provider}"]`);
  const cancelBtn = document.querySelector(`.btn-cancel-key[data-provider="${provider}"]`);
  const formEl = document.getElementById(`keyform-${provider}`);
  const refreshBtn = document.querySelector(`.btn-refresh[data-provider="${provider}"]`);
  const select = document.getElementById(`select-${provider}`);
  const deleteBtn = document.querySelector(`.btn-delete-provider[data-provider="${provider}"]`);
  const urlText = document.getElementById(`urltext-${provider}`);

  renderKeyList(provider);

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (formEl) formEl.style.display = formEl.style.display === "none" ? "" : "none";
    });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      if (formEl) formEl.style.display = "none";
      if (nameInput) nameInput.value = "";
      if (keyInput) keyInput.value = "";
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const name = nameInput?.value.trim() || "";
      const key = keyInput?.value.trim() || "";
      if (!key) { toast("请输入 API Key", "error"); return; }
      addKey(provider, name, key);
      if (formEl) formEl.style.display = "none";
      if (nameInput) nameInput.value = "";
      if (keyInput) keyInput.value = "";
      toast("Key 已添加");
    });
  }
  if (keyInput) {
    keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && saveBtn) saveBtn.click(); });
  }

  // Base URL 可编辑
  if (urlText) {
    urlText.addEventListener("blur", () => {
      const val = urlText.textContent.trim();
      if (state[provider]) {
        state[provider].baseUrl = val;
        updateCardSub(provider);
        autoSave();
      }
    });
    urlText.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); urlText.blur(); }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => fetchModels(provider));
  }

  if (select) {
    select.addEventListener("change", () => {
      if (!state[provider]) return;
      state[provider].selectedModel = select.value;
      showDesc(provider);
      document.querySelectorAll(`#list-${provider} .model-item`).forEach((item) => {
        item.classList.toggle("active", item.dataset.id === select.value);
      });
      if (select.value) showCopy(provider);
      else { const cp = document.getElementById(`copy-${provider}`); if (cp) cp.style.display = "none"; }
      saveSelect(provider, { modelId: select.value });
    });
  }

  const copySection = document.getElementById(`copy-${provider}`);
  if (copySection) {
    copySection.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => handleCopy(e, provider));
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      deletePendingProvider = provider;
      const body = document.getElementById("deleteModalBody");
      if (body) body.textContent = `确定要删除厂商 "${provider}" 吗？所有 Key 和配置将被清除。`;
      const modal = document.getElementById("deleteModal");
      if (modal) modal.style.display = "";
    });
  }
}

// ===== Theme =====
function getTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "🌞" : "🌗";
}

async function applySavedTheme() {
  try {
    const theme = await invoke("get_theme");
    setTheme(theme);
  } catch {
    setTheme("dark");
  }
}

// ===== 同步功能 =====
let syncState = null;
let autoSyncTimer = null;
let pendingRemoteConfig = null;
let syncImportMode = "private"; // "private" | "public"

async function syncLoadState() {
  try {
    syncState = await invoke("sync_get_state");
    syncRenderState();
  } catch (e) {
    console.error("load sync state:", e);
  }
}

function syncRenderState() {
  if (!syncState) return;

  // URL 输入
  const urlInput = document.getElementById("syncUrlInput");
  if (urlInput && urlInput.value !== (syncState.sync_url || "")) {
    urlInput.value = syncState.sync_url || "";
  }

  // 状态徽章
  const badge = document.getElementById("syncStatusBadge");
  if (badge) {
    const hasKeys = !!syncState.private_key_pem;
    const hasUrl = !!syncState.sync_url;
    if (hasKeys && hasUrl) {
      badge.textContent = "已就绪";
      badge.className = "sync-status-badge status-ready";
    } else if (hasKeys) {
      badge.textContent = "密钥已配置";
      badge.className = "sync-status-badge status-partial";
    } else {
      badge.textContent = "未配置";
      badge.className = "sync-status-badge";
    }
  }

  // 密钥状态
  const keyStatus = document.getElementById("syncKeyStatus");
  const keyDetail = document.getElementById("syncKeyDetail");
  const pubText = document.getElementById("syncPubKeyText");
  const privText = document.getElementById("syncPrivKeyText");

  if (syncState.public_key_pem || syncState.private_key_pem) {
    if (keyStatus) {
      const hasPriv = !!syncState.private_key_pem;
      keyStatus.innerHTML = `<span class="sync-key-icon">${hasPriv ? "🔓" : "🔐"}</span><span>${hasPriv ? "密钥对已配置（可加密 + 解密）" : "仅公钥（仅可加密）"}</span>`;
    }
    if (keyDetail) keyDetail.style.display = "";
    if (pubText) pubText.value = syncState.public_key_pem || "";
    if (privText) privText.value = syncState.private_key_pem || "(未配置)";
  } else {
    if (keyStatus) {
      keyStatus.innerHTML = `<span class="sync-key-icon">🔒</span><span>尚未配置密钥对</span>`;
    }
    if (keyDetail) keyDetail.style.display = "none";
  }

  // 自动同步间隔
  const intervalSel = document.getElementById("syncIntervalSelect");
  if (intervalSel) {
    const val = syncState.auto_sync_interval_min || 0;
    if (parseInt(intervalSel.value) !== val) intervalSel.value = String(val);
  }

  // 上次同步信息
  const lastInfo = document.getElementById("syncLastSyncInfo");
  if (lastInfo) {
    if (syncState.last_sync_at) {
      const t = new Date(syncState.last_sync_at * 1000);
      const ok = syncState.last_sync_ok;
      lastInfo.textContent = `上次同步：${t.toLocaleString()} (${ok ? "成功" : "失败"})`;
      lastInfo.style.color = ok ? "var(--green)" : "var(--red)";
    } else {
      lastInfo.textContent = "从未同步";
      lastInfo.style.color = "";
    }
  }
}

function syncLog(msg, type = "info") {
  const el = document.getElementById("syncLog");
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = `sync-log-item sync-log-${type}`;
  div.textContent = `[${time}] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

async function syncGenerateKeypair() {
  try {
    const s = await invoke("sync_generate_keypair");
    syncState = s;
    syncRenderState();
    toast("密钥对已生成");
    syncLog("生成了新的 RSA-2048 密钥对", "success");
  } catch (e) {
    toast("生成失败: " + (e?.message || e), "error");
    syncLog("生成失败: " + (e?.message || e), "error");
  }
}

function syncOpenImport(mode) {
  syncImportMode = mode;
  const title = document.getElementById("syncImportTitle");
  const textarea = document.getElementById("syncImportTextarea");
  if (title) title.textContent = mode === "private" ? "导入私钥" : "导入公钥";
  if (textarea) { textarea.value = ""; textarea.placeholder = mode === "private" ? "粘贴 PEM 格式的私钥（以 -----BEGIN RSA PRIVATE KEY----- 开头）" : "粘贴 PEM 格式的公钥（以 -----BEGIN RSA PUBLIC KEY----- 开头）"; }
  const modal = document.getElementById("syncImportModal");
  if (modal) modal.style.display = "";
}

async function syncImportKey() {
  const textarea = document.getElementById("syncImportTextarea");
  const val = textarea?.value.trim();
  if (!val) { toast("请输入密钥内容", "error"); return; }
  try {
    const cmd = syncImportMode === "private" ? "sync_import_private_key" : "sync_import_public_key";
    const s = await invoke(cmd, { [syncImportMode === "private" ? "privatePem" : "publicPem"]: val });
    syncState = s;
    syncRenderState();
    toast("导入成功");
    syncLog(`导入${syncImportMode === "private" ? "私钥" : "公钥"}成功`, "success");
    document.getElementById("syncImportModal").style.display = "none";
  } catch (e) {
    toast("导入失败: " + (e?.message || e), "error");
    syncLog("导入失败: " + (e?.message || e), "error");
  }
}

async function syncClearKeys() {
  if (!confirm("确定要清除所有密钥吗？清除后将无法解密已有的加密配置。")) return;
  try {
    const s = await invoke("sync_clear_keys");
    syncState = s;
    syncRenderState();
    toast("密钥已清除");
    syncLog("密钥已清除", "info");
  } catch (e) {
    toast("清除失败: " + (e?.message || e), "error");
  }
}

async function syncSaveUrl() {
  const urlInput = document.getElementById("syncUrlInput");
  const url = urlInput?.value.trim() || null;
  if (url && !/^https?:\/\//i.test(url)) { toast("请输入有效的 HTTP/HTTPS URL", "error"); return; }
  try {
    await invoke("sync_set_url", { url });
    if (syncState) syncState.sync_url = url;
    syncRenderState();
    toast("同步地址已保存");
    syncLog("同步地址已更新: " + (url || "(空)"), "info");
  } catch (e) {
    toast("保存失败: " + (e?.message || e), "error");
  }
}

async function syncSetInterval() {
  const sel = document.getElementById("syncIntervalSelect");
  const val = parseInt(sel?.value || "0");
  const minutes = val > 0 ? val : null;
  try {
    await invoke("sync_set_auto_interval", { minutes });
    if (syncState) syncState.auto_sync_interval_min = minutes;
    syncSetupAutoTimer();
    toast(minutes ? `已设置每 ${minutes} 分钟自动同步` : "已关闭自动同步");
    syncLog(minutes ? `自动同步间隔设为 ${minutes} 分钟` : "已关闭自动同步", "info");
  } catch (e) {
    toast("设置失败: " + (e?.message || e), "error");
  }
}

function syncSetupAutoTimer() {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  const mins = syncState?.auto_sync_interval_min;
  if (mins && mins > 0) {
    autoSyncTimer = setInterval(() => {
      syncPull(true);
    }, mins * 60 * 1000);
  }
}

async function syncPull(silent = false) {
  if (!syncState?.sync_url) { if (!silent) toast("请先配置同步 URL", "error"); return; }
  if (!syncState?.private_key_pem) { if (!silent) toast("请先配置私钥", "error"); return; }

  if (!silent) {
    syncLog("正在从 " + syncState.sync_url + " 拉取...", "info");
    const btn = document.getElementById("syncPullBtn");
    if (btn) { btn.disabled = true; btn.textContent = "同步中..."; }
  }

  try {
    const remote = await invoke("sync_fetch_remote");
    pendingRemoteConfig = remote;

    const providers = Object.keys(remote);
    const totalKeys = providers.reduce((sum, p) => sum + (remote[p]?.keys?.length || 0), 0);

    if (silent) {
      // 自动同步默认合并
      await invoke("sync_merge_config", { remote });
      await loadConfig();
      renderAllCards();
      syncLog(`自动同步完成：${providers.length} 个厂商，${totalKeys} 个 Key`, "success");
    } else {
      // 手动同步：弹窗确认
      const body = document.getElementById("syncConfirmBody");
      if (body) {
        body.innerHTML = `
          <p>从远端获取到：</p>
          <ul style="margin:8px 0;padding-left:20px;">
            <li>${providers.length} 个厂商</li>
            <li>${totalKeys} 个 API Key</li>
          </ul>
          <p style="margin-top:8px;font-size:13px;color:var(--text-muted);">选择同步方式：</p>
        `;
      }
      document.getElementById("syncConfirmModal").style.display = "";
    }

    await syncLoadState();
  } catch (e) {
    const msg = e?.message || e;
    if (!silent) {
      toast("同步失败: " + msg, "error");
      syncLog("同步失败: " + msg, "error");
    } else {
      syncLog("自动同步失败: " + msg, "error");
    }
    await syncLoadState();
  } finally {
    if (!silent) {
      const btn = document.getElementById("syncPullBtn");
      if (btn) { btn.disabled = false; btn.textContent = "⬇ 从 URL 拉取"; }
    }
  }
}

async function syncDoMerge() {
  if (!pendingRemoteConfig) return;
  try {
    await invoke("sync_merge_config", { remote: pendingRemoteConfig });
    await loadConfig();
    renderAllCards();
    toast("同步成功（已合并）");
    syncLog("同步完成（合并模式）", "success");
    document.getElementById("syncConfirmModal").style.display = "none";
    pendingRemoteConfig = null;
  } catch (e) {
    toast("合并失败: " + (e?.message || e), "error");
  }
}

async function syncDoOverwrite() {
  if (!pendingRemoteConfig) return;
  if (!confirm("确定要用远端配置完全覆盖本地吗？本地所有未同步的更改将丢失。")) return;
  try {
    await invoke("sync_overwrite_config", { remote: pendingRemoteConfig });
    await loadConfig();
    renderAllCards();
    toast("同步成功（已覆盖）");
    syncLog("同步完成（覆盖模式）", "success");
    document.getElementById("syncConfirmModal").style.display = "none";
    pendingRemoteConfig = null;
  } catch (e) {
    toast("覆盖失败: " + (e?.message || e), "error");
  }
}

async function syncExport() {
  if (!syncState?.public_key_pem) { toast("请先配置公钥", "error"); return; }
  try {
    const encrypted = await invoke("sync_encrypt_config");
    // 下载为文件
    const blob = new Blob([encrypted], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `api-key-config-${Date.now()}.enc.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("加密配置已导出");
    syncLog("导出加密配置文件", "success");
  } catch (e) {
    toast("导出失败: " + (e?.message || e), "error");
    syncLog("导出失败: " + (e?.message || e), "error");
  }
}

function syncCopyText(targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(
    () => toast("已复制"),
    () => { el.select(); document.execCommand("copy"); toast("已复制"); }
  );
}

// ===== Bootstrap =====
let deletePendingProvider = null;

async function main() {
  await loadConfig();
  renderAllCards();
  await applySavedTheme();
  await syncLoadState();
  syncSetupAutoTimer();

  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", async () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      setTheme(next);
      try { await invoke("set_theme", { theme: next, scope: "app" }); } catch {}
    });
  }

  const addBtn = document.getElementById("addProviderBtn");
  const fabAddBtn = document.getElementById("fabAddBtn");
  const openProviderModal = () => {
    const modal = document.getElementById("providerModal");
    if (modal) modal.style.display = "";
    const input = document.getElementById("newProviderName");
    if (input) input.value = "";
    const urlInput = document.getElementById("newProviderUrl");
    if (urlInput) urlInput.value = "";
    if (input) input.focus();
  };
  if (addBtn) addBtn.addEventListener("click", openProviderModal);
  if (fabAddBtn) fabAddBtn.addEventListener("click", openProviderModal);

  const providerNameInput = document.getElementById("newProviderName");
  const providerUrlInput = document.getElementById("newProviderUrl");
  const handleProviderSubmit = async () => {
    const name = providerNameInput?.value.trim();
    const baseUrl = providerUrlInput?.value.trim();
    if (!name || !baseUrl) { toast("请填写完整信息", "error"); return; }
    await addProvider(name, baseUrl);
    document.getElementById("providerModal").style.display = "none";
  };
  providerNameInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); handleProviderSubmit(); } });
  providerUrlInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); handleProviderSubmit(); } });

  document.getElementById("saveProviderBtn")?.addEventListener("click", handleProviderSubmit);

  document.getElementById("cancelProviderBtn")?.addEventListener("click", () => {
    document.getElementById("providerModal").style.display = "none";
  });

  document.getElementById("confirmDeleteBtn")?.addEventListener("click", async () => {
    if (deletePendingProvider) {
      await deleteProvider(deletePendingProvider);
      deletePendingProvider = null;
    }
    document.getElementById("deleteModal").style.display = "none";
  });

  document.getElementById("cancelDeleteBtn")?.addEventListener("click", () => {
    deletePendingProvider = null;
    document.getElementById("deleteModal").style.display = "none";
  });

  $$(".modal-overlay").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target === el) el.style.display = "none";
    });
  });

  // 窗口重新聚焦时刷新
  window.addEventListener("focus", refreshFromServer);

  // ===== 同步 UI 事件绑定 =====
  const syncBtn = document.getElementById("syncBtn");
  const mobileSyncBtn = document.getElementById("mobileSyncBtn");
  const openSyncModal = () => {
    const modal = document.getElementById("syncModal");
    if (modal) modal.style.display = "";
  };
  if (syncBtn) syncBtn.addEventListener("click", openSyncModal);
  if (mobileSyncBtn) mobileSyncBtn.addEventListener("click", openSyncModal);

  document.getElementById("syncCloseBtn")?.addEventListener("click", () => {
    document.getElementById("syncModal").style.display = "none";
  });

  document.getElementById("syncSaveUrlBtn")?.addEventListener("click", syncSaveUrl);
  document.getElementById("syncGenKeyBtn")?.addEventListener("click", syncGenerateKeypair);
  document.getElementById("syncImportPrivBtn")?.addEventListener("click", () => syncOpenImport("private"));
  document.getElementById("syncImportPubBtn")?.addEventListener("click", () => syncOpenImport("public"));
  document.getElementById("syncClearKeysBtn")?.addEventListener("click", syncClearKeys);
  document.getElementById("syncIntervalSelect")?.addEventListener("change", syncSetInterval);
  document.getElementById("syncPullBtn")?.addEventListener("click", () => syncPull(false));
  document.getElementById("syncExportBtn")?.addEventListener("click", syncExport);

  document.getElementById("syncImportConfirmBtn")?.addEventListener("click", syncImportKey);
  document.getElementById("syncImportCancelBtn")?.addEventListener("click", () => {
    document.getElementById("syncImportModal").style.display = "none";
  });

  document.getElementById("syncMergeBtn")?.addEventListener("click", syncDoMerge);
  document.getElementById("syncOverwriteBtn")?.addEventListener("click", syncDoOverwrite);
  document.getElementById("syncCancelBtn")?.addEventListener("click", () => {
    document.getElementById("syncConfirmModal").style.display = "none";
    pendingRemoteConfig = null;
  });

  // 复制密钥按钮
  $$(".btn-copy-mini").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      if (target) syncCopyText(target);
    });
  });
}
document.addEventListener("DOMContentLoaded", main);

if (window.visualViewport) {
  let lastHeight = window.visualViewport.height;
  window.visualViewport.addEventListener("resize", () => {
    const diff = lastHeight - window.visualViewport.height;
    lastHeight = window.visualViewport.height;
    if (diff > 100) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) {
        setTimeout(() => {
          active.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      }
    }
  });
}