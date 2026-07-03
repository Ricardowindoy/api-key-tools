// Tauri 重构版 widget：所有后端调用通过 invoke
const nav = window.__TAURI__;
const core = nav?.core;
const invoke = core?.invoke ? core.invoke.bind(core) : (...args) => Promise.reject("Tauri invoke not available");
const win = nav?.window;
const getCurrentWindow = win?.getCurrentWindow?.bind(win) ?? (() => { throw new Error("Tauri window not available"); });
console.log("__TAURI__ IPC:", !!core?.invoke, "| window:", !!win?.getCurrentWindow);

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let configData = {};
let modelsData = {};
let currentProvider = "";
let providerList = [];
let isExpanded = false;
let isDragging = false;
let autoHideTimer = null;
let configPollTimer = null;
let configPollSeq = 0;

// ===== 主题 =====
function getTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("#themeBtn");
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

// ===== 配置加载 =====
async function loadConfig() {
  try {
    configData = await invoke("get_config");
  } catch (e) {
    console.error("config load:", e);
  }
}

async function loadModels() {
  const section = configData[currentProvider];
  if (!section) return;
  const keys = section.keys || [];
  const selectedKey = keys.find((k) => k.selected) || keys[0];
  const apiKey = selectedKey?.key || "";
  const baseUrl = section.base_url || "";
  if (!apiKey || !baseUrl) {
    modelsData[currentProvider] = [];
    return;
  }
  try {
    const models = await invoke("fetch_models_command", {
      provider: currentProvider,
      baseUrl,
      key: apiKey,
    });
    modelsData[currentProvider] = models || [];
  } catch (e) {
    console.error("models load:", e);
    modelsData[currentProvider] = [];
  }
}

async function saveSelect(provider, { keyId, modelId } = {}) {
  try {
    await invoke("save_select", {
      provider,
      keyId: keyId ?? null,
      modelId: modelId ?? null,
    });
  } catch (e) {
    console.error("save select:", e);
    showToast("保存失败");
  }
}

function getSelectedKey() {
  const keys = configData[currentProvider]?.keys || [];
  return keys.find((k) => k.selected) || keys[0] || null;
}

function populateProviderSelect() {
  const select = $("#providerSelect");
  select.innerHTML = "";
  providerList = Object.keys(configData).sort();
  if (providerList.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "无厂商";
    select.appendChild(opt);
    return;
  }
  providerList.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  });
  if (currentProvider && providerList.includes(currentProvider)) {
    select.value = currentProvider;
  } else {
    currentProvider = providerList[0] || "";
    select.value = currentProvider;
  }
}

function render() {
  const section = configData[currentProvider] || {};
  const selectedKey = getSelectedKey();
  const baseUrl = section.base_url || "";
  const model = section.selected_model || "";

  // Key 选择器
  const keySelect = $("#widgetKeySelect");
  keySelect.innerHTML = '<option value="">未选择</option>';
  (section.keys || []).forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k.id;
    const label = k.name || "未命名";
    const masked = k.key ? k.key.slice(0, 6) + "..." + k.key.slice(-4) : "";
    opt.textContent = masked ? `${label} · ${masked}` : label;
    keySelect.appendChild(opt);
  });
  if (selectedKey && [...keySelect.options].some((o) => o.value === selectedKey.id)) {
    keySelect.value = selectedKey.id;
  }

  // 模型选择器
  const modelSelect = $("#widgetModelSelect");
  modelSelect.innerHTML = '<option value="">未选择</option>';
  (modelsData[currentProvider] || []).forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.id;
    opt.title = m.description || "";
    modelSelect.appendChild(opt);
  });
  if (model && [...modelSelect.options].some((o) => o.value === model)) {
    modelSelect.value = model;
  }

  // 显示
  $("#widgetUrl").textContent = baseUrl || "-";
  if (baseUrl && model) {
    $("#widgetFull").textContent = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  } else {
    $("#widgetFull").textContent = "-";
  }
}

// ===== 复制 =====
async function copyText(text) {
  if (!text || text === "-") return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  showToast("已复制");
}

function showToast(msg) {
  let t = $(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1500);
}

// ===== 展开/收起 =====
async function setExpandedUI(expanded) {
  const widget = document.querySelector(".widget");
  const body = document.getElementById("widgetBody");
  if (!widget || !body) return;
  widget.classList.toggle("collapsed", !expanded);
  body.classList.toggle("open", expanded);
  isExpanded = expanded;
  // 通过 Tauri command 调整窗口大小
  try {
    await invoke("widget_set_expanded", { expanded });
  } catch (e) {
    console.error("set expanded:", e);
    showToast("窗口缩放失败: " + (e?.message || String(e)));
  }
  if (expanded) {
    await loadConfig();
    populateProviderSelect();
    await loadModels();
    render();
    startConfigPolling();
  } else {
    stopConfigPolling();
  }
}

async function expandWidget() {
  if (isExpanded) return;
  clearTimeout(autoHideTimer);
  await setExpandedUI(true);
}

async function collapseWidget() {
  if (!isExpanded) return;
  await setExpandedUI(false);
}

function resetAutoHide() {
  clearTimeout(autoHideTimer);
  if (isExpanded) {
    autoHideTimer = setTimeout(() => collapseWidget(), 800);
  }
}

// ===== 配置轮询（同步主窗口的选中项变更）=====
function startConfigPolling() {
  if (configPollTimer) return;
  if (!isExpanded) return;
  const loop = () => {
    configPollSeq++;
    const t = configPollSeq;
    loadConfig()
      .then(() => {
        if (configPollSeq === t && isExpanded) {
          populateProviderSelect();
          render();
        }
      })
      .catch(() => {});
  };
  loop();
  configPollTimer = setInterval(loop, 3000);
}

function stopConfigPolling() {
  if (configPollTimer) {
    clearInterval(configPollTimer);
    configPollTimer = null;
  }
}

// ===== 拖动 =====
function initToggle() {
  const widget = document.querySelector(".widget");
  if (!widget) return;

  window.addEventListener("mousemove", (e) => {
    if (isDragging && e.buttons === 0) {
      isDragging = false;
    }
    if (isDragging) return;
    if (!isExpanded) {
      expandWidget();
    } else {
      clearTimeout(autoHideTimer);
    }
  });

  widget.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON" || e.target.tagName === "SELECT") return;
    if (!isExpanded) expandWidget();
  });

  document.addEventListener("mouseleave", resetAutoHide);
  window.addEventListener("blur", resetAutoHide);
}

function initDrag() {
  // 使用 Tauri 的 startDragging
  window.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
    isDragging = true;
    // 调用 Tauri 原生拖动
    try {
      getCurrentWindow().startDragging();
    } catch (e) {
      console.error("start drag:", e);
      showToast("拖动失败: " + (e?.message || String(e)));
    }
  });

  window.addEventListener("mouseup", async () => {
    if (!isDragging) return;
    isDragging = false;
    // 保存位置
    try {
      const pos = await getCurrentWindow().outerPosition();
      await invoke("save_widget_position", { x: pos.x, y: pos.y });
    } catch (e) {
      console.error("save position:", e);
      showToast("保存位置失败: " + (e?.message || String(e)));
    }
  });
}

// ===== 事件绑定 =====
$("#providerSelect")?.addEventListener("change", async (e) => {
  currentProvider = e.target.value;
  await loadModels();
  render();
});

$("#widgetKeySelect")?.addEventListener("change", async (e) => {
  const id = e.target.value;
  const keys = configData[currentProvider]?.keys || [];
  keys.forEach((k) => { k.selected = k.id === id; });
  await saveSelect(currentProvider, { keyId: id });
  await loadModels();
  render();
  showToast("Key 已切换");
});

$("#widgetModelSelect")?.addEventListener("change", async (e) => {
  if (!configData[currentProvider]) return;
  configData[currentProvider].selected_model = e.target.value;
  await saveSelect(currentProvider, { modelId: e.target.value });
  render();
  if (e.target.value) showToast("模型已切换");
});

$$(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    const action = e.currentTarget.dataset.action;
    const section = configData[currentProvider] || {};
    const selectedKey = getSelectedKey();
    const keyValue = selectedKey?.key || "";
    const baseUrl = section.base_url || "";
    const model = section.selected_model || "";

    switch (action) {
      case "copyKey":
        await copyText(keyValue);
        break;
      case "copyModel":
        await copyText(model);
        break;
      case "copyUrl":
        await copyText(baseUrl);
        break;
      case "copyFull":
        if (!baseUrl || !model) return;
        await copyText(`BASE_URL="${baseUrl}"\nAPI_KEY="${keyValue}"\nMODEL="${model}"`);
        break;
    }
  });
});

$("#widgetUrl")?.addEventListener("click", () => {
  const section = configData[currentProvider] || {};
  if (section.base_url) copyText(section.base_url);
});
$("#widgetFull")?.addEventListener("click", () => {
  const section = configData[currentProvider] || {};
  const selectedKey = getSelectedKey();
  if (section.base_url && section.selected_model) {
    copyText(`BASE_URL="${section.base_url}"\nAPI_KEY="${selectedKey?.key || ""}"\nMODEL="${section.selected_model}"`);
  }
});

// ===== 自启动 =====
async function updateAutoStartBtn() {
  const btn = $("#autoStartBtn");
  if (!btn) return;
  try {
    const enabled = await invoke("plugin:autostart|is_enabled");
    btn.classList.toggle("active", !!enabled);
    btn.title = enabled ? "已开启开机自启" : "开启开机自启";
  } catch (e) {
    console.error("autostart:", e);
  }
}

$("#autoStartBtn")?.addEventListener("click", async () => {
  try {
    const current = await invoke("plugin:autostart|is_enabled");
    if (current) {
      await invoke("plugin:autostart|disable");
    } else {
      await invoke("plugin:autostart|enable");
    }
    updateAutoStartBtn();
    showToast(current ? "已关闭开机自启" : "已开启开机自启");
  } catch (e) {
    console.error("autostart toggle:", e);
    showToast("操作失败");
  }
});

$("#resetPosBtn")?.addEventListener("click", async () => {
  try {
    await invoke("reset_widget_position");
    showToast("已重置位置，重启生效");
  } catch (e) {
    console.error("reset pos:", e);
  }
});

$("#themeBtn")?.addEventListener("click", async () => {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  try { await invoke("set_theme", { theme: next }); } catch {}
});

// ===== 初始化 =====
document.addEventListener("DOMContentLoaded", async () => {
  await setExpandedUI(false);
  await loadConfig();
  populateProviderSelect();
  await loadModels();
  render();
  await applySavedTheme();
  updateAutoStartBtn();
  initToggle();
  initDrag();
});