const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let configData = {};
let modelsData = {};
let currentProvider = "";
let providerList = [];

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
    const theme = await window.electronWidget.getTheme();
    setTheme(theme);
  } catch {
    setTheme("dark");
  }
}

async function loadConfig() {
  try {
    const r = await fetch(`/api/config?_t=${Date.now()}`);
    if (r.ok) configData = await r.json();
  } catch (e) {
    console.error("config load:", e);
  }
}

async function loadModels() {
  const providerData = configData[currentProvider] || {};
  const selectedKey = getSelectedKey();
  const apiKey = selectedKey?.key || "";
  const baseUrl = providerData.baseUrl || "";
  if (!apiKey || !baseUrl) {
    modelsData[currentProvider] = [];
    return;
  }
  try {
    const r = await fetch(`/api/models/${currentProvider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: apiKey, baseUrl }),
    });
    if (r.ok) {
      const data = await r.json();
      modelsData[currentProvider] = data.models || [];
    }
  } catch (e) {
    console.error("models load:", e);
  }
}

async function saveSelect(provider, { keyId, modelId } = {}) {
  const payload = { provider };
  if (keyId !== undefined) payload.keyId = keyId;
  if (modelId !== undefined) payload.modelId = modelId;
  try {
    const r = await fetch("/api/config/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      showToast(data.error || "保存失败");
    }
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
  // 保持当前 provider 有效
  if (currentProvider && providerList.includes(currentProvider)) {
    select.value = currentProvider;
  } else {
    currentProvider = providerList[0] || "";
    select.value = currentProvider;
  }
}

function render() {
  const providerData = configData[currentProvider] || {};
  const selectedKey = getSelectedKey();
  const baseUrl = providerData.baseUrl || "";
  const model = providerData.selectedModel || "";

  // Populate key selector
  const keySelect = $("#widgetKeySelect");
  keySelect.innerHTML = '<option value="">未选择</option>';
  (providerData.keys || []).forEach((k) => {
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

  // Populate model selector
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

  // Update displays
  $("#widgetUrl").textContent = baseUrl || "-";
  if (baseUrl && model) {
    $("#widgetFull").textContent = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  } else {
    $("#widgetFull").textContent = "-";
  }
}

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

let isExpanded = false;
let autoHideTimer = null;
let configPollTimer = null;
let configPollSeq = 0;

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

async function setExpandedUI(expanded) {
  const widget = document.querySelector(".widget");
  const body = document.getElementById("widgetBody");
  if (!widget || !body) return;
  widget.classList.toggle("collapsed", !expanded);
  body.classList.toggle("open", expanded);
  isExpanded = expanded;
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
  window.electronWidget.setExpanded(true);
}

function collapseWidget() {
  if (!isExpanded) return;
  setExpandedUI(false);
  window.electronWidget.setExpanded(false);
}

function resetAutoHide() {
  clearTimeout(autoHideTimer);
  if (isExpanded) {
    autoHideTimer = setTimeout(collapseWidget, 800);
  }
}

function initToggle() {
  const widget = document.querySelector(".widget");
  if (!widget) return;

  window.addEventListener("mousemove", () => {
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
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  window.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
    isDragging = true;
    e.preventDefault();
    startX = e.screenX;
    startY = e.screenY;
    startLeft = window.screenX || 0;
    startTop = window.screenY || 0;
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    window.moveTo(startLeft + (e.screenX - startX), startTop + (e.screenY - startY));
  });

  window.addEventListener("mouseup", async (e) => {
    if (!isDragging) return;
    isDragging = false;
    await window.electronWidget.savePosition(startLeft + (e.screenX - startX), startTop + (e.screenY - startY));
  });
}

// Provider switch
$("#providerSelect")?.addEventListener("change", async (e) => {
  currentProvider = e.target.value;
  await loadModels();
  render();
});

// Key selection
$("#widgetKeySelect")?.addEventListener("change", async (e) => {
  const id = e.target.value;
  const keys = configData[currentProvider]?.keys || [];
  keys.forEach((k) => { k.selected = k.id === id; });
  await saveSelect(currentProvider, { keyId: id });
  await loadModels();
  render();
  showToast("Key 已切换");
});

// Model selection
$("#widgetModelSelect")?.addEventListener("change", async (e) => {
  configData[currentProvider].selectedModel = e.target.value;
  await saveSelect(currentProvider, { modelId: e.target.value });
  render();
  if (e.target.value) showToast("模型已切换");
});

// Copy buttons
$$(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    const action = e.currentTarget.dataset.action;
    const providerData = configData[currentProvider] || {};
    const selectedKey = getSelectedKey();
    const keyValue = selectedKey?.key || "";
    const baseUrl = providerData.baseUrl || "";
    const model = providerData.selectedModel || "";

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

// Click-to-copy on display items
$("#widgetUrl")?.addEventListener("click", () => {
  const providerData = configData[currentProvider] || {};
  if (providerData.baseUrl) copyText(providerData.baseUrl);
});
$("#widgetFull")?.addEventListener("click", () => {
  const providerData = configData[currentProvider] || {};
  const selectedKey = getSelectedKey();
  if (providerData.baseUrl && providerData.selectedModel) {
    copyText(`BASE_URL="${providerData.baseUrl}"\nAPI_KEY="${selectedKey?.key || ""}"\nMODEL="${providerData.selectedModel}"`);
  }
});

async function updateAutoStartBtn() {
  const btn = $("#autoStartBtn");
  if (!btn) return;
  const enabled = await window.electronWidget.getLoginItem();
  btn.classList.toggle("active", !!enabled);
  btn.title = enabled ? "已开启开机自启" : "开启开机自启";
}

$("#autoStartBtn")?.addEventListener("click", async () => {
  const current = await window.electronWidget.getLoginItem();
  const next = !current;
  await window.electronWidget.setLoginItem(next);
  updateAutoStartBtn();
  showToast(next ? "已开启开机自启" : "已关闭开机自启");
});

$("#resetPosBtn")?.addEventListener("click", async () => {
  window.electronWidget.resetPosition();
  showToast("已重置为顶部居中，重启生效");
});

$("#themeBtn")?.addEventListener("click", async () => {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  await window.electronWidget.setTheme(next);
});

document.addEventListener("DOMContentLoaded", async () => {
  setExpandedUI(false);
  await loadConfig();
  populateProviderSelect();
  await loadModels();
  render();
  await applySavedTheme();
  updateAutoStartBtn();
  initToggle();
  initDrag();
});