const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
} = require("electron");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT) || 41247;
// When ELECTRON_START_URL is set (dev), we attach to an already-running Next
// server instead of spawning one. Otherwise we run `next start` ourselves.
const EXTERNAL_URL = process.env.ELECTRON_START_URL || "";
const APP_URL = EXTERNAL_URL || `http://localhost:${PORT}`;

const PROJECT_ROOT = path.join(__dirname, "..");

let tray = null;
let win = null;
let nextProc = null;

function startNextServer() {
  if (EXTERNAL_URL) return; // attached to an external dev server

  if (app.isPackaged) {
    // Packaged: run the bundled Next standalone server with Electron's own Node.
    const serverDir = path.join(process.resourcesPath, "app-server");
    const serverJs = path.join(serverDir, "server.js");
    nextProc = spawn(process.execPath, [serverJs], {
      cwd: serverDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        PORT: String(PORT),
        HOSTNAME: "127.0.0.1",
      },
      stdio: "inherit",
    });
  } else {
    // Dev/from-source: run `next start` from the local install.
    const bin = path.join(
      PROJECT_ROOT,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "next.cmd" : "next",
    );
    nextProc = spawn(bin, ["start", "-p", String(PORT)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: "inherit",
    });
  }
  nextProc.on("error", (err) => console.error("[electron] server spawn failed:", err));
}

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(url, (res) => {
        res.destroy();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error("server timeout"));
        else setTimeout(ping, 400);
      });
    };
    ping();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 660,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: false,
    skipTaskbar: true,
    backgroundColor: "#1a1a18",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Electron's default UA carries "Electron/x.y.z" + the app name, which won't
  // match the cf_clearance Cloudflare issued to a real browser. Strip those
  // tokens so the renderer's navigator.userAgent reads as plain Chrome — the
  // closest no-input default. Users can still override it in the UI.
  const cleanUA = win.webContents
    .getUserAgent()
    .replace(/ (claude-usage|Electron)\/[^\s]+/g, "");
  win.webContents.setUserAgent(cleanUA);

  win.loadURL(APP_URL);

  // Hide when it loses focus, like a real menu-bar popover.
  win.on("blur", () => {
    if (win && !win.webContents.isDevToolsOpened()) win.hide();
  });

  // Open external links (status page, tutorial, …) in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function positionWindow() {
  const trayBounds = tray.getBounds();
  const { width } = win.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  win.setPosition(x, y, false);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    positionWindow();
    win.show();
    win.focus();
  }
}

function createTray() {
  // No icon file needed — macOS shows the title text; we prefix a sparkle to
  // echo Claude's mark. The title is replaced with the live % once data loads.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle(" Claudometer");
  tray.setToolTip("Claudometer");

  const menu = Menu.buildFromTemplate([
    { label: "Open / Close", click: toggleWindow },
    { label: "Refresh", click: () => win && win.webContents.reload() },
    { type: "separator" },
    { label: "Quit Claudometer", role: "quit" },
  ]);

  tray.on("click", toggleWindow);
  tray.on("right-click", () => tray.popUpContextMenu(menu));
}

// The renderer draws a clean, danger-tinted sparkle (no emoji container) and
// sends it as a PNG data URL; we show it as the tray icon next to the % text.
ipcMain.on("set-usage", (_event, payload) => {
  if (!tray || !payload) return;

  const pct = payload.pct;
  if (typeof pct === "number" && Number.isFinite(pct)) {
    tray.setTitle(` ${Math.round(pct)}%`);
  }

  const url = payload.iconDataURL;
  if (typeof url === "string" && url.startsWith("data:image")) {
    try {
      // The data URL is a 36px PNG = the @2x representation of an 18pt icon.
      const img = nativeImage.createEmpty();
      img.addRepresentation({ scaleFactor: 2, width: 18, height: 18, dataURL: url });
      if (!img.isEmpty()) {
        img.setTemplateImage(false); // keep our color; don't monochrome it
        tray.setImage(img);
      }
    } catch {
      // ignore a bad icon; the % text still updates
    }
  }
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide(); // menu-bar only, no dock icon
  if (app.setActivationPolicy) app.setActivationPolicy("accessory");

  startNextServer();
  try {
    await waitForServer(APP_URL);
  } catch (err) {
    console.error("[electron] could not reach app server:", err);
  }
  createTray();
  createWindow();
});

// Tray app: don't quit when the popover hides.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  if (nextProc) nextProc.kill();
});
