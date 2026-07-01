// ===== State =====
const state = {
  stepfun:  { baseUrl:"https://api.stepfun.com/v1",        keys:[], models:[], selectedModel:"" },
  opencode: { baseUrl:"https://opencode.ai/zen/go/v1",    keys:[], models:[], selectedModel:"" },
};
let saveTimer = null;
let uid = 0;
const genId = () => `k${Date.now()}_${uid++}`;

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

// ===== Toast =====
function toast(msg, type="success") {
  const c = $(".toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ===== Auto-save =====
function autoSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveConfig, 600); }

// 定向更新选中项，避免全量覆写导致 widget 数据丢失
async function saveSelect(provider, { keyId, modelId } = {}) {
  const payload = { provider };
  if (keyId !== undefined) payload.keyId = keyId;
  if (modelId !== undefined) payload.modelId = modelId;
  try {
    const r = await fetch("/api/config/select", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
    if (!r.ok) toast("保存失败", "error");
  } catch(e) { console.error("save select:", e); toast("保存失败", "error"); }
}

async function saveConfig() {
  const config = {
    stepfun:  { baseUrl: state.stepfun.baseUrl,  keys: state.stepfun.keys,  selectedModel: state.stepfun.selectedModel },
    opencode: { baseUrl: state.opencode.baseUrl, keys: state.opencode.keys, selectedModel: state.opencode.selectedModel },
  };
  try {
    const r = await fetch("/api/config", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(config) });
    if (r.ok) $$(".badge").forEach(b => { b.textContent="已保存"; b.classList.add("saved"); });
    else toast("保存失败", "error");
  } catch(e) { console.error("save:", e); toast("保存失败", "error"); }
}

async function loadConfig() {
  try {
    const r = await fetch(`/api/config?_t=${Date.now()}`);
    if (!r.ok) return;
    const c = await r.json();
    ["stepfun","opencode"].forEach(p => {
      if (c[p]) {
        state[p].baseUrl = c[p].baseUrl || state[p].baseUrl;
        state[p].keys    = Array.isArray(c[p].keys) ? c[p].keys : [];
        state[p].selectedModel = c[p].selectedModel || "";
      }
    });
  } catch(e) { console.error("load:", e); }
}

// 刷新 config 并同步 widget 端的选中状态变更，但保留本地 keys（不覆盖添加/删除）
async function refreshFromServer() {
  try {
    const r = await fetch(`/api/config?_t=${Date.now()}`);
    if (!r.ok) return;
    const c = await r.json();
    ["stepfun","opencode"].forEach(p => {
      if (c[p]) {
        state[p].selectedModel = c[p].selectedModel || state[p].selectedModel;
        // 同步 widget 端的 key 选中状态，但不覆盖本地 keys 列表
        if (Array.isArray(c[p].keys)) {
          state[p].keys.forEach(localKey => {
            const serverKey = c[p].keys.find(sk => sk.id === localKey.id);
            if (serverKey) localKey.selected = !!serverKey.selected;
          });
        }
      }
    });
    ["stepfun","opencode"].forEach(p => { renderKeyList(p); });
  } catch(e) { console.error("refresh:", e); }
}

// ===== Helpers =====
function getSelectedKey(provider) {
  return state[provider].keys.find(k => k.selected) || state[provider].keys[0] || { key:"" };
}

function getBaseUrl(provider) {
  const chip = document.querySelector(`[data-provider="${provider}"] .url-chip`);
  return chip ? chip.dataset.url : state[provider].baseUrl;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0,2) + "***";
  return key.slice(0,6) + "..." + key.slice(-4);
}

function normalizeModels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(m => {
    if (typeof m === "string") return { id: m, description:"" };
    return { id: m.id || m.model || m.name || "", description: m.description || "" };
  }).filter(m => m.id);
}

// ===== Render Key List =====
function renderKeyList(provider) {
  const el = document.getElementById(`keylist-${provider}`);
  if (!el) return;
  const keys = state[provider].keys;
  const selectedId = keys.find(k => k.selected)?.id || "";

  el.innerHTML = "";
  if (keys.length === 0) {
    el.innerHTML = `<div class="key-empty">暂无 Key，点击上方「+ 添加」</div>`;
    return;
  }

  keys.forEach(k => {
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
// 直接保存，不走 debounce，避免与 refreshFromServer（focus 触发）竞争
function addKey(provider, name, key) {
  const id = genId();
  state[provider].keys.push({ id, name: name || `Key ${state[provider].keys.length + 1}`, key, selected: true });
  state[provider].keys.forEach(k => { if (k.id !== id) k.selected = false; });
  renderKeyList(provider);
  saveConfig();
}

function removeKey(provider, id) {
  const idx = state[provider].keys.findIndex(k => k.id === id);
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
  state[provider].keys.forEach(k => { k.selected = k.id === id; });
  renderKeyList(provider);
  saveSelect(provider, { keyId: id });
}

// ===== Model Logic =====
function renderModelList(provider) {
  const el = document.getElementById(`list-${provider}`);
  if (!el) return;
  const models = state[provider].models;
  const selId  = state[provider].selectedModel;
  el.innerHTML = "";
  models.forEach(m => {
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
      document.getElementById(`select-${provider}`).value = m.id;
      showDesc(provider);
      showCopy(provider);
      el.querySelectorAll(".model-item").forEach(x => x.classList.remove("active"));
      item.classList.add("active");
    });
    el.appendChild(item);
  });
}

function showDesc(provider) {
  const el = document.getElementById(`desc-${provider}`);
  const id = state[provider].selectedModel;
  const desc = state[provider].models.find(m => m.id === id)?.description;
  id && desc ? (el.textContent = desc, el.style.display = "") : el.style.display = "none";
}

function showCopy(provider) {
  const el   = document.getElementById(`copy-${provider}`);
  const prev = document.getElementById(`preview-${provider}`);
  const model = state[provider].selectedModel;
  const key   = getSelectedKey(provider).key;
  const baseUrl = getBaseUrl(provider);
  if (model && key) { el.style.display = ""; prev.textContent = `BASE_URL="${baseUrl}"\nAPI_KEY="${key}"\nMODEL="${model}"`; }
  else              { el.style.display = "none"; }
}

async function fetchModels(provider) {
  const statusEl   = document.getElementById(`status-${provider}`);
  const select     = document.getElementById(`select-${provider}`);
  const refreshBtn = document.getElementById(`refresh-${provider}`);
  const key        = getSelectedKey(provider).key;
  const baseUrl    = getBaseUrl(provider);

  if (!baseUrl) { statusEl.textContent="未配置 Base URL"; statusEl.className="status error"; return; }

  const isBuiltin = !key;
  statusEl.textContent = isBuiltin ? "加载内置模型…" : "正在查询…";
  statusEl.className   = "status loading";
  refreshBtn.disabled  = true;
  select.disabled      = true;

  try {
    const r = await fetch(`/api/models/${provider}`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ key, baseUrl }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "查询失败");

    const models = normalizeModels(data.models || []);
    state[provider].models = models;

    select.innerHTML = '<option value="">请选择模型</option>';
    models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id; opt.textContent = m.id; opt.title = m.description || "";
      select.appendChild(opt);
    });

    const saved = state[provider].selectedModel;
    if (saved && models.some(m => m.id === saved)) select.value = saved;

    renderModelList(provider);
    select.disabled = false;
    statusEl.textContent = data.fromBuiltin ? `内置模型 ${models.length} 个（填 Key 可查实时列表）` : `找到 ${models.length} 个模型`;
    statusEl.className   = "status success";

    if (select.value) { showDesc(provider); showCopy(provider); }
    else document.getElementById(`copy-${provider}`).style.display = "none";
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.className   = "status error";
    select.disabled      = true;
  } finally {
    refreshBtn.disabled = false;
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
  const key   = getSelectedKey(provider).key;
  const baseUrl = getBaseUrl(provider);
  const model = state[provider].selectedModel;
  if (!model) return;
  let text = "";
  switch (type) {
    case "baseUrl": text = baseUrl; break;
    case "key":     text = key;     break;
    case "model":   text = model;   break;
    case "all":     text = `BASE_URL="${baseUrl}"\nAPI_KEY="${key}"\nMODEL="${model}"`; break;
  }
  if (text) copyToClipboard(text);
}

// ===== Init Card =====
function initCard(provider) {
  // Key inputs
  const addBtn    = document.getElementById(`addkey-${provider}`);
  const nameInput = document.getElementById(`newname-${provider}`);
  const keyInput  = document.getElementById(`newkey-${provider}`);
  const saveBtn   = document.getElementById(`savekey-${provider}`);
  const cancelBtn = document.getElementById(`cancelkey-${provider}`);
  const formEl    = document.getElementById(`keyform-${provider}`);
  const refreshBtn = document.getElementById(`refresh-${provider}`);
  const select    = document.getElementById(`select-${provider}`);

  renderKeyList(provider);

  addBtn.addEventListener("click", () => {
    formEl.style.display = formEl.style.display === "none" ? "" : "none";
  });

  cancelBtn.addEventListener("click", () => {
    formEl.style.display = "none";
    nameInput.value = "";
    keyInput.value  = "";
  });

  saveBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    const key  = keyInput.value.trim();
    if (!key) { toast("请输入 API Key", "error"); return; }
    addKey(provider, name, key);
    formEl.style.display = "none";
    nameInput.value = "";
    keyInput.value  = "";
    toast("Key 已添加");
  });

  // Key enter to save
  keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });

  refreshBtn.addEventListener("click", () => fetchModels(provider));

  select.addEventListener("change", () => {
    state[provider].selectedModel = select.value;
    showDesc(provider);
    document.querySelectorAll(`#list-${provider} .model-item`).forEach(item => {
      item.classList.toggle("active", item.dataset.id === select.value);
    });
    if (select.value) showCopy(provider);
    else document.getElementById(`copy-${provider}`).style.display = "none";
    saveSelect(provider, { modelId: select.value });
  });

  document.querySelectorAll(`#copy-${provider} .copy-btn`).forEach(btn => {
    btn.addEventListener("click", e => handleCopy(e, provider));
  });
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
    const theme = await window.electronApp?.getTheme();
    setTheme(theme);
  } catch {
    const saved = localStorage.getItem("theme");
    setTheme(saved === "light" ? "light" : "dark");
  }
}

// ===== Bootstrap =====
async function main() {
  await loadConfig();
  initCard("stepfun");
  initCard("opencode");
  await applySavedTheme();

  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", async () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      setTheme(next);
      localStorage.setItem("theme", next);
      try {
        await window.electronApp?.setTheme(next);
      } catch {}
    });
  }

  // 窗口重新聚焦时从服务器刷新，同步 widget 端的选中项变更
  window.addEventListener("focus", refreshFromServer);
}
document.addEventListener("DOMContentLoaded", main);
