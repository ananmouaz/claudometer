const { contextBridge, ipcRenderer } = require("electron");

// The only bridge the renderer needs: push the current session % up to the main
// process so it can render it as the menu-bar title.
contextBridge.exposeInMainWorld("electronAPI", {
  // pct → menu-bar title; iconDataURL → a tinted sparkle drawn by the renderer.
  setUsage: (pct, iconDataURL) =>
    ipcRenderer.send("set-usage", { pct, iconDataURL }),
});
