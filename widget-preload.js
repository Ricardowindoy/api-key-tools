const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronWidget", {
  toggle: () => ipcRenderer.send("widget-toggle"),
  setExpanded: (expanded) => ipcRenderer.send("widget-set-expanded", !!expanded),
  getPosition: () => ipcRenderer.invoke("widget-get-position"),
  savePosition: (x, y) => ipcRenderer.send("widget-save-position", { x, y }),
  resetPosition: () => ipcRenderer.send("widget-reset-position"),
  getLoginItem: () => ipcRenderer.invoke("widget-get-login-item"),
  setLoginItem: (enabled) => ipcRenderer.send("widget-set-login-item", { enabled }),
  getTheme: () => ipcRenderer.invoke("widget-get-theme"),
  setTheme: (theme) => ipcRenderer.send("widget-set-theme", theme),
});
