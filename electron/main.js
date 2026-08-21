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
const bridge = require("./claude-bridge");

const PORT = Number(process.env.PORT) || 41247;
// When ELECTRON_START_URL is set (dev), we attach to an already-running Next
// server instead of spawning one. Otherwise we run `next start` ourselves.
const EXTERNAL_URL = process.env.ELECTRON_START_URL || "";
const APP_URL = EXTERNAL_URL || `http://localhost:${PORT}`;

const PROJECT_ROOT = path.join(__dirname, "..");

let tray = null;
let win = null;
let nextProc = null;
let authWin = null;
let bridgeInfo = null;

// Electron's default UA carries "Electron/x.y.z" + the app name, which won't
// match the cf_clearance Cloudflare issues to a real browser. Strip those tokens
// so we look like plain Chrome. Computed once and used for BOTH the sign-in
// window and the UA we hand the renderer — Cloudflare binds cf_clearance to the
// exact UA that solved its challenge, so those two must never diverge.
let cleanUA = "";
function getCleanUA(contents) {
  if (!cleanUA) {
    cleanUA = contents.getUserAgent().replace(/ (claude-usage|Electron)\/[^\s]+/g, "");
  }
  return cleanUA;
}

/**
 * Bridge coordinates for a server we spawn ourselves. `npm run app:dev` attaches
 * to an already-running `next dev` that never sees this env, which is why the
 * bridge also writes them to a file the route can read.
 */
function bridgeEnv() {
  if (!bridgeInfo) return {};
  return {
    CLAUDE_BRIDGE_PORT: String(bridgeInfo.port),
    CLAUDE_BRIDGE_TOKEN: bridgeInfo.token,
    CLAUDE_BRIDGE_FILE: bridgeInfo.file,
  };
}

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
        ...bridgeEnv(),
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
      env: { ...process.env, PORT: String(PORT), ...bridgeEnv() },
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
    // One tab is visible at a time, so this only has to fit the taller of the
    // two (Claude, with its connection controls); the page scrolls past that.
    height: 720,
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
      // The popover is hidden most of the time, but it owns the 60s refresh
      // that keeps the tray glyph/% current. Without this, Chromium throttles
      // (and eventually freezes) the timer while hidden, so the menu bar goes
      // stale until you reopen the popover.
      backgroundThrottling: false,
    },
  });

  win.webContents.setUserAgent(getCleanUA(win.webContents));

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

// Last painted title/icon. Every `setTitle` / `setImage` makes macOS redraw the
// tray item, which reads as a flicker — and with two provider panels reporting
// on independent timers, most messages carry the value that's already up there.
// Guard both ends: the renderer skips unchanged reports, and so do we (a window
// reload replays the current values through here regardless).
let lastTitle = null;
let lastIconURL = null;

// The renderer draws the entire readout — both providers, each tinted by its own
// danger level — and sends it as a PNG data URL. macOS can't color tray *text*,
// so the image is the only way to show two independently coloured numbers; the
// tray title is used purely as a fallback when the canvas is unavailable.
ipcMain.on("set-usage", (_event, payload) => {
  if (!tray || !payload) return;

  const url = payload.iconDataURL;
  const width = Number(payload.iconWidth);
  let painted = false;

  if (typeof url === "string" && url.startsWith("data:image") && width > 0) {
    if (url !== lastIconURL) {
      lastIconURL = url;
      try {
        // The data URL is the @2x representation of a `width`×18pt icon.
        const img = nativeImage.createEmpty();
        img.addRepresentation({ scaleFactor: 2, width, height: 18, dataURL: url });
        if (!img.isEmpty()) {
          img.setTemplateImage(false); // keep our colors; don't monochrome them
          tray.setImage(img);
          // The image carries the numbers, so an extra text title would just
          // duplicate them (and macOS can't tint it anyway).
          if (lastTitle !== "") {
            lastTitle = "";
            tray.setTitle("");
          }
        }
      } catch {
        // Fall through to the text fallback below.
      }
    }
    painted = true;
  }

  if (!painted && typeof payload.title === "string" && payload.title !== lastTitle) {
    lastTitle = payload.title;
    tray.setTitle(` ${payload.title}`);
  }

  if (typeof payload.tooltip === "string" && payload.tooltip) {
    tray.setToolTip(payload.tooltip);
  }
});

/* ---------- claude.ai sign-in ---------- */

const CLAUDE_LOGIN_URL = "https://claude.ai/login";

/**
 * Sign in to claude.ai inside the app. Nothing is copied out afterwards — the
 * session lives in Electron's own cookie jar and every API call is made through
 * the Chromium bridge, so there's no cookie for the user (or us) to handle.
 *
 * Success is decided by an actual `/api/organizations` 200, never by the
 * presence of a `sessionKey` cookie: claude.ai sets that cookie partway through
 * the login flow, so trusting it reports success on a session that isn't valid
 * yet — which is exactly the bug this replaces.
 *
 * Starts hidden. An already-valid session resolves in a beat with no window ever
 * appearing; the window is only shown once we know a login is really needed.
 */
ipcMain.handle("claude-sign-in", async () => {
  if (authWin && !authWin.isDestroyed()) {
    authWin.show();
    authWin.focus();
    return { ok: false, reason: "in-progress" };
  }

  // Maybe we're already signed in and there's nothing to do.
  bridge.invalidate();
  if (await bridge.isSignedIn()) return { ok: true };

  authWin = new BrowserWindow({
    width: 520,
    height: 720,
    show: false,
    title: "Sign in to Claude",
    backgroundColor: "#1a1a18",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  authWin.webContents.setUserAgent(getCleanUA(authWin.webContents));

  const target = authWin;
  let cancelled = false;
  target.on("closed", () => {
    cancelled = true;
    if (authWin === target) authWin = null;
  });

  try {
    await target.loadURL(CLAUDE_LOGIN_URL);
  } catch {
    // A navigation error still leaves the window usable for a manual retry.
  }
  target.show();
  target.focus();

  const started = Date.now();
  const TIMEOUT_MS = 5 * 60_000; // generous: the user may need email codes / 2FA

  while (!cancelled && Date.now() - started < TIMEOUT_MS) {
    if (target.isDestroyed()) break;
    await new Promise((r) => setTimeout(r, 1_500));
    // Ask claude.ai, not the cookie jar. The bridge window shares this session,
    // so a completed login here shows up there.
    bridge.invalidate();
    if (await bridge.isSignedIn()) {
      if (!target.isDestroyed()) target.destroy();
      authWin = null;
      return { ok: true };
    }
  }

  if (!target.isDestroyed()) target.destroy();
  authWin = null;
  return { ok: false, reason: cancelled ? "cancelled" : "timeout" };
});

/** Lets the UI show "signed in / not signed in" without opening a window. */
ipcMain.handle("claude-session-status", async () => {
  bridge.invalidate();
  return { signedIn: await bridge.isSignedIn() };
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide(); // menu-bar only, no dock icon
  if (app.setActivationPolicy) app.setActivationPolicy("accessory");

  // Must come before the server starts: the Next route reads the bridge's
  // port/token from this file (and from the env we pass below when we spawn it).
  bridgeInfo = await bridge.startBridge({
    userDataDir: app.getPath("userData"),
    userAgentFor: (contents) => getCleanUA(contents),
  });

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
  bridge.stopBridge();
  if (nextProc) nextProc.kill();
});
