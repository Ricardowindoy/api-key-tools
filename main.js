const { app, BrowserWindow, screen, ipcMain } = require("electron");
const path = require("path");
const logger = require("./logger");
const { PORT: SERVER_PORT, serverReady, setConfigPath } = require("./server");
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

const WIDGET_WIDTH_COLLAPSED = 60;
const WIDGET_HEIGHT_COLLAPSED = 60;
const WIDGET_WIDTH_EXPANDED = 420;
const WIDGET_HEIGHT_EXPANDED = 460;
const AUTO_HIDE_DELAY = 800;

let widgetWindow = null;
let mainWindow = null;
let widgetExpanded = false;
let widgetPositionUserSet = false;
let lastUsedDisplay = null;

function snapToEdge(win) {
  const bounds = win.getBounds();
  const display = getCurrentDisplay(win);
  const area = display.workArea;
  const distances = {
    left: bounds.x - area.x,
    top: bounds.y - area.y,
    right: (area.x + area.width) - (bounds.x + bounds.width),
    bottom: (area.y + area.height) - (bounds.y + bounds.height),
  };
  const nearest = Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
  switch (nearest) {
    case "left":   win.setPosition(area.x, bounds.y); break;
    case "right":  win.setPosition(area.x + area.width - bounds.width, bounds.y); break;
    case "top":    win.setPosition(bounds.x, area.y); break;
    case "bottom": win.setPosition(bounds.x, area.y + area.height - bounds.height); break;
  }
}

function setWidgetExpanded(next) {
  widgetExpanded = next;
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const w = widgetExpanded ? WIDGET_WIDTH_EXPANDED : WIDGET_WIDTH_COLLAPSED;
  const h = widgetExpanded ? WIDGET_HEIGHT_EXPANDED : WIDGET_HEIGHT_COLLAPSED;
  widgetWindow.setSize(w, h);
  if (!widgetExpanded) snapToEdge(widgetWindow);
  if (widgetExpanded && !widgetPositionUserSet) positionWidgetToTopCenter(widgetWindow);
}

function positionWidgetToTopCenter(win) {
  const display = getCurrentDisplay(win);
  lastUsedDisplay = display;
  const area = display.workArea;
  const w = widgetExpanded ? WIDGET_WIDTH_EXPANDED : WIDGET_WIDTH_COLLAPSED;
  const x = Math.floor(area.x + (area.width - w) / 2);
  const y = Math.max(area.y, area.y + 8);
  win.setPosition(x, y);
}

function widgetStatePath() {
  return path.join(app.getPath("userData"), "widget-state.json");
}

// 统一读取 widget 状态，避免位置与主题互相覆盖
function readWidgetState() {
  try {
    const fs = require("fs");
    return JSON.parse(fs.readFileSync(widgetStatePath(), "utf-8")) || {};
  } catch {
    return {};
  }
}

// 合并写入：仅更新 patch 中的字段，保留其余字段
function writeWidgetState(patch) {
  try {
    const fs = require("fs");
    const p = widgetStatePath();
    const data = { ...readWidgetState(), ...patch };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data), "utf-8");
  } catch {}
}

function saveWidgetPosition(x, y) {
  const patch = { x, y };
  const display = getCurrentDisplay(widgetWindow);
  if (display) {
    patch.displayId = display.id;
    patch.displayBounds = display.bounds;
  }
  writeWidgetState(patch);
}

// 重置位置：移除位置相关字段，保留主题
function clearWidgetPosition() {
  const data = readWidgetState();
  delete data.x;
  delete data.y;
  delete data.displayId;
  delete data.displayBounds;
  try {
    const fs = require("fs");
    const p = widgetStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data), "utf-8");
  } catch {}
}

function loadWidgetPosition() {
  const data = readWidgetState();
  if (typeof data.x === "number" && typeof data.y === "number" && !Number.isNaN(data.x) && !Number.isNaN(data.y)) {
    return { x: data.x, y: data.y, displayId: data.displayId, displayBounds: data.displayBounds };
  }
  return null;
}

function saveWidgetTheme(theme) {
  writeWidgetState({ theme });
}

function loadWidgetTheme() {
  const data = readWidgetState();
  if (data.theme === "light" || data.theme === "dark") return data.theme;
  return "dark";
}

function saveAppTheme(theme) {
  try {
    const fs = require("fs");
    const p = path.join(app.getPath("userData"), "app-state.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ theme }), "utf-8");
  } catch {}
}

function loadAppTheme() {
  try {
    const fs = require("fs");
    const p = path.join(app.getPath("userData"), "app-state.json");
    const raw = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (data.theme === "light" || data.theme === "dark") return data.theme;
  } catch {}
  return null;
}

function getCurrentDisplay(win) {
  if (!win) return screen.getPrimaryDisplay();
  const bounds = win.getBounds();
  const displays = screen.getAllDisplays();
  const found = displays.find((d) => {
    const b = d.bounds;
    return (
      bounds.x >= b.x &&
      bounds.x < b.x + b.width &&
      bounds.y >= b.y &&
      bounds.y < b.y + b.height
    );
  });
  return found || screen.getPrimaryDisplay();
}

function clampToArea(x, y, w, h, area) {
  const cx = Math.max(area.x, Math.min(x, area.x + area.width - w));
  const cy = Math.max(area.y, Math.min(y, area.y + area.height - h));
  return { x: cx, y: cy };
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 820,
    minWidth: 720,
    minHeight: 600,
    frame: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f1117",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "app-preload.js"),
    },
    show: false,
  });

  win.loadURL(`${SERVER_URL}/`);
  win.webContents.on("did-finish-load", () => {
    const theme = loadAppTheme() || loadWidgetTheme();
    if (theme) win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', '${theme}')`).catch(() => {});
  });
  win.once("ready-to-show", () => {
    win.show();
    logger.info("主窗口已显示");
  });
  win.on("closed", () => {
    mainWindow = null;
    logger.info("主窗口已关闭");
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.close();
    }
  });

  mainWindow = win;
  return win;
}

function createWidgetWindow() {
  const widget = new BrowserWindow({
    width: WIDGET_WIDTH_COLLAPSED,
    height: WIDGET_HEIGHT_COLLAPSED,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "widget-preload.js"),
    },
    show: false,
  });

  widget.loadURL(`${SERVER_URL}/widget.html`);

  const savedPos = loadWidgetPosition();
  widgetPositionUserSet = !!savedPos;

  widget.once("ready-to-show", () => {
    if (widgetPositionUserSet && savedPos) {
      const display = getCurrentDisplay(widget);
      const area = display.workArea;
      const pos = clampToArea(savedPos.x, savedPos.y, WIDGET_WIDTH_COLLAPSED, WIDGET_HEIGHT_COLLAPSED, area);
      widget.setPosition(pos.x, pos.y);
      lastUsedDisplay = display;
    } else {
      positionWidgetToTopCenter(widget);
      snapToEdge(widget);
    }
    widget.show();
  });

  let autoHideTimer = null;

  widget.on("blur", () => {
    clearTimeout(autoHideTimer);
    if (widgetExpanded) autoHideTimer = setTimeout(() => setWidgetExpanded(false), AUTO_HIDE_DELAY);
  });

  widget.on("move", () => {
    const display = getCurrentDisplay(widget);
    if (!lastUsedDisplay || display.id !== lastUsedDisplay.id) {
      lastUsedDisplay = display;
      const area = display.workArea;
      const bounds = widget.getBounds();
      const pos = clampToArea(bounds.x, bounds.y, bounds.width, bounds.height, area);
      if (pos.x !== bounds.x || pos.y !== bounds.y) {
        widget.setPosition(pos.x, pos.y);
      }
    }
  });

  widget.on("closed", () => {
    clearTimeout(autoHideTimer);
    widgetWindow = null;
  });

  return widget;
}

ipcMain.on("widget-toggle", () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  setWidgetExpanded(!widgetExpanded);
});

ipcMain.on("widget-set-expanded", (_event, next) => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  setWidgetExpanded(!!next);
});

ipcMain.on("widget-set-login-item", (_event, { enabled }) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
});

ipcMain.handle("widget-get-login-item", () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});

ipcMain.on("widget-save-position", (_event, { x, y }) => {
  saveWidgetPosition(x, y);
});

ipcMain.handle("widget-get-position", () => loadWidgetPosition());

ipcMain.on("widget-reset-position", () => {
  clearWidgetPosition();
});

ipcMain.on("widget-set-theme", (_event, theme) => {
  saveWidgetTheme(theme);
});

ipcMain.handle("widget-get-theme", () => loadWidgetTheme());

ipcMain.on("app-set-theme", (_event, theme) => {
  saveAppTheme(theme);
});

ipcMain.handle("app-get-theme", () => loadAppTheme() || loadWidgetTheme());

// 使用 AppData 目录存储可写数据，避免打包到 asar 后无法写入
app.setPath("userData", path.join(app.getPath("appData"), "api-key-manager"));
app.whenReady().then(async () => {
  // 将配置文件路径切换到 userData，确保打包后可写
  const userDataPath = app.getPath("userData");
  setConfigPath(path.join(userDataPath, "config.json"));
  logger.info("应用启动中, 数据目录:", userDataPath);
  await serverReady;
  logger.info("HTTP 服务器就绪, URL:", SERVER_URL);
  createMainWindow();
  widgetWindow = createWidgetWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
