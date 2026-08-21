const { contextBridge, ipcRenderer } = require("electron");

// The bridge the renderer needs: push the current usage % up to the main process
// so it can render it as the menu-bar title, and hand back a claude.ai cookie
// captured by signing in inside the app.
contextBridge.exposeInMainWorld("electronAPI", {
  // The renderer draws the whole "C 42%  G 100%" readout to a canvas (macOS
  // can't color tray text) and sends it as a PNG plus a text fallback.
  setUsage: (payload) => ipcRenderer.send("set-usage", payload),

  // Opens claude.ai in-app and resolves { ok: true } once the session actually
  // answers an API call — no cookie ever leaves the shell. Its presence is also
  // what the UI uses to decide whether in-app sign-in is available at all; in a
  // plain browser it's undefined and the manual cookie paste is shown instead.
  claudeSignIn: () => ipcRenderer.invoke("claude-sign-in"),

  // { signedIn: boolean } — lets the UI label the button without opening a window.
  claudeSessionStatus: () => ipcRenderer.invoke("claude-session-status"),
});
