import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchWithTimeout } from "./http";

/**
 * How a claude.ai API call gets made.
 *
 * Preferred: the Chromium bridge in the Electron shell (see
 * electron/claude-bridge.js). Cloudflare rejects requests from Node's HTTP stack
 * on client fingerprint — a direct `fetch` gets the "Just a moment…" challenge
 * page even with a valid cf_clearance and a matching User-Agent — so the only
 * transport that actually reaches the API is one that originates in Chromium.
 *
 * Fallback: a direct cookie-forwarding fetch, for the plain-browser build where
 * there is no Chromium session to borrow. It's kept because it costs nothing and
 * still works against any surface Cloudflare isn't challenging, but expect 403s.
 */

const CLAUDE = "https://claude.ai";

export type ApiResult = { status: number; json: unknown };
export type ClaudeTransport = {
  kind: "bridge" | "cookie";
  get: (apiPath: string) => Promise<ApiResult>;
};

type BridgeInfo = { port: number; token: string };

/** Candidate bridge files: dev uses the package name, packaged the productName. */
function bridgeFileCandidates(): string[] {
  const support = join(homedir(), "Library", "Application Support");
  return [
    process.env.CLAUDE_BRIDGE_FILE ?? "",
    join(support, "claude-usage", "bridge.json"),
    join(support, "Claudometer", "bridge.json"),
  ].filter(Boolean);
}

async function readBridgeInfo(): Promise<BridgeInfo | null> {
  const port = Number(process.env.CLAUDE_BRIDGE_PORT);
  const token = process.env.CLAUDE_BRIDGE_TOKEN;
  if (port > 0 && token) return { port, token };

  for (const file of bridgeFileCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as BridgeInfo;
      if (parsed?.port > 0 && parsed?.token) return parsed;
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }
  return null;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Probe the bridge, falling back to direct fetch. A stale bridge.json left by a
 * dead run is rejected by its own token, so a failed probe just falls through.
 */
export async function claudeTransport(
  cookie: string,
  userAgent: string,
): Promise<ClaudeTransport> {
  const info = await readBridgeInfo();
  if (info) {
    const get = async (apiPath: string): Promise<ApiResult> => {
      const url = `http://127.0.0.1:${info.port}/?path=${encodeURIComponent(apiPath)}`;
      const res = await fetchWithTimeout(url, {
        headers: { "x-bridge-token": info.token },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`bridge returned ${res.status}`);
      // The bridge answers 200 with the upstream status inside the envelope.
      const env = (await res.json()) as { status: number; body: string };
      return { status: env.status, json: parse(env.body) };
    };

    try {
      // One cheap call proves the bridge is alive before we commit to it.
      await get("/api/organizations");
      return { kind: "bridge", get };
    } catch {
      // Fall through to the cookie transport.
    }
  }

  return { kind: "cookie", get: (apiPath) => cookieGet(apiPath, cookie, userAgent) };
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function cookieGet(
  apiPath: string,
  cookie: string,
  userAgent: string,
): Promise<ApiResult> {
  const res = await fetchWithTimeout(`${CLAUDE}${apiPath}`, {
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": userAgent || DEFAULT_UA,
      Referer: `${CLAUDE}/settings/usage`,
    },
    cache: "no-store",
  });
  return { status: res.status, json: parse(await res.text()) };
}
