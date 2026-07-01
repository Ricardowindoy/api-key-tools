const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronApp", {
  getTheme: () => ipcRenderer.invoke("app-get-theme"),
  setTheme: (theme) => ipcRenderer.send("app-set-theme", theme),
});
