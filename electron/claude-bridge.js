/**
 * Chromium transport for claude.ai.
 *
 * Cloudflare no longer accepts requests from Node's HTTP stack, whatever cookies
 * they carry: a plain `fetch` from the Next server gets the "Just a moment…"
 * challenge page even with a fresh cf_clearance and the exact User-Agent that
 * earned it. The block is on the client fingerprint (TLS/HTTP2), not headers, so
 * forwarding a cookie can't fix it. Requests have to *originate* in Chromium.
 *
 * So we keep one hidden window parked on the claude.ai origin and run the API
 * calls inside it as same-origin `fetch()`. Those carry the real session, real
 * client hints and a real browser fingerprint — Cloudflare passes them through.
 *
 * The Next route reaches this over a loopback HTTP server. That server is bound
 * to 127.0.0.1, needs a per-run bearer token, and only forwards paths under
 * `/api/` on claude.ai — it must never become an open relay.
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { BrowserWindow } = require("electron");

const ORIGIN = "https://claude.ai";
// A page whose origin is claude.ai but which isn't the full SPA — the window
// exists only to host `fetch`, and booting the real app in it would burn memory
// and CPU forever. Falls back to a real page if this ever stops being fetchable.
const HOST_PAGES = [`${ORIGIN}/robots.txt`, `${ORIGIN}/settings/usage`];

let hostWin = null;
let server = null;
let token = "";
let bridgeFile = "";
let getUA = () => "";

/** Create (or revive) the hidden claude.ai window. */
async function ensureWindow() {
  if (hostWin && !hostWin.isDestroyed()) {
    const url = hostWin.webContents.getURL();
    if (url.startsWith(ORIGIN)) return hostWin;
  }

  if (hostWin && !hostWin.isDestroyed()) hostWin.destroy();
  hostWin = new BrowserWindow({
    show: false,
    width: 480,
    height: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // This window is only a fetch host; it must never be throttled or the
      // background refresh stalls while the popover is hidden.
      backgroundThrottling: false,
    },
  });
  const ua = getUA(hostWin.webContents);
  if (ua) hostWin.webContents.setUserAgent(ua);

  for (const page of HOST_PAGES) {
    try {
      await hostWin.loadURL(page);
      if (hostWin.webContents.getURL().startsWith(ORIGIN)) return hostWin;
    } catch {
      // Try the next candidate.
    }
  }
  return hostWin;
}

/**
 * Run one same-origin GET inside the claude.ai window.
 * Returns { status, body } — never throws for HTTP errors.
 */
async function bridgeGet(apiPath) {
  if (!apiPath.startsWith("/api/")) {
    return { status: 400, body: '{"error":"path not allowed"}' };
  }
  const win = await ensureWindow();
  if (!win || win.isDestroyed()) {
    return { status: 0, body: '{"error":"bridge window unavailable"}' };
  }
  const js = `
    fetch(${JSON.stringify(apiPath)}, {
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    })
      .then(async (r) => ({ status: r.status, body: await r.text() }))
      .catch((e) => ({ status: 0, body: JSON.stringify({ error: String((e && e.message) || e) }) }))
  `;
  try {
    return await win.webContents.executeJavaScript(js, true);
  } catch (err) {
    return { status: 0, body: JSON.stringify({ error: String(err && err.message) }) };
  }
}

/**
 * Is there a usable claude.ai session right now? This is the only trustworthy
 * signal — the presence of a `sessionKey` cookie is not, because claude.ai sets
 * one before a login completes.
 */
async function isSignedIn() {
  const res = await bridgeGet("/api/organizations");
  return res.status === 200;
}

/** Drop the cached window so the next call re-reads the session. */
function invalidate() {
  if (hostWin && !hostWin.isDestroyed()) hostWin.destroy();
  hostWin = null;
}

function writeBridgeFile(port) {
  const payload = JSON.stringify({ port, token });
  // 0600: the token is a capability to query claude.ai as this user.
  fs.writeFileSync(bridgeFile, payload, { mode: 0o600 });
  try {
    fs.chmodSync(bridgeFile, 0o600);
  } catch {
    // Best effort — the token is still single-run and loopback-only.
  }
}

/**
 * Start the loopback bridge. Resolves with { port, token, file } so the caller
 * can hand the same values to the Next server via env as well.
 */
function startBridge({ userDataDir, userAgentFor }) {
  getUA = userAgentFor || getUA;
  token = crypto.randomBytes(24).toString("hex");
  bridgeFile = path.join(userDataDir, "bridge.json");

  server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    if (req.headers["x-bridge-token"] !== token) return reply(403, '{"error":"bad token"}');

    const url = new URL(req.url, "http://127.0.0.1");
    const target = url.searchParams.get("path") || "";
    if (!target.startsWith("/api/")) return reply(400, '{"error":"path not allowed"}');

    const out = await bridgeGet(target);
    reply(200, JSON.stringify(out));
  });

  return new Promise((resolve) => {
    // 127.0.0.1 only — never 0.0.0.0. Port 0 = let the OS pick a free one.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      writeBridgeFile(port);
      resolve({ port, token, file: bridgeFile });
    });
  });
}

function stopBridge() {
  if (server) {
    server.close();
    server = null;
  }
  invalidate();
  try {
    if (bridgeFile) fs.rmSync(bridgeFile, { force: true });
  } catch {
    // Nothing to do — a stale file is rejected by its dead token anyway.
  }
}

module.exports = { startBridge, stopBridge, bridgeGet, isSignedIn, invalidate, ORIGIN };
