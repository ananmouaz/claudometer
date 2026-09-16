import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchWithTimeout, json } from "@/lib/http";
import { OPENAI_STATUS_URL, fetchStatus } from "@/lib/status";
import type {
  OpenAIPayload,
  OpenAIResetCredit,
  RawOpenAIUsage,
} from "@/lib/openai-types";
import { planLabel } from "@/lib/openai-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

/**
 * Unlike claude.ai, this endpoint is **not** behind Cloudflare — a bearer token
 * is enough, with no cf_clearance and no User-Agent pinning. So instead of
 * asking the user to paste a cookie, we reuse the OAuth token the Codex CLI
 * already stores locally. Nothing is sent anywhere except chatgpt.com.
 */
function authPaths(): string[] {
  const codexHome = process.env.CODEX_HOME;
  const paths = codexHome ? [join(codexHome, "auth.json")] : [];
  paths.push(join(homedir(), ".codex", "auth.json"));
  return paths;
}

type CodexAuth = {
  tokens?: {
    access_token?: string;
    account_id?: string;
  } | null;
};

/** The locally stored Codex login, or null when the user hasn't signed in. */
async function readCodexAuth(): Promise<{ token: string; accountId: string } | null> {
  for (const p of authPaths()) {
    try {
      const parsed = JSON.parse(await readFile(p, "utf8")) as CodexAuth;
      const token = parsed.tokens?.access_token;
      if (token) {
        return { token, accountId: parsed.tokens?.account_id ?? "" };
      }
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }
  return null;
}

const SIGN_IN_HINT =
  "No ChatGPT login found. Sign in with `codex login` (or paste an access token), then refresh.";

export async function POST(req: Request): Promise<Response> {
  // An explicitly supplied token wins, so someone without the Codex CLI can
  // paste one from chatgpt.com's own Usage request instead.
  let override = "";
  try {
    const body = (await req.json()) as { token?: string };
    override = (body?.token ?? "").trim().replace(/^Bearer\s+/i, "");
  } catch {
    // No body is fine — fall through to the local Codex login.
  }

  const local = override ? null : await readCodexAuth();
  const token = override || local?.token || "";
  if (!token) return json({ error: SIGN_IN_HINT, auth: true }, 401);
  const accountId = local?.accountId ?? "";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  // Team/enterprise tokens are workspace-scoped; without this the response can
  // resolve to the wrong account. Omitted when we don't know the id.
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const [usageRes, resetCredits, status] = await Promise.all([
    fetchUsage(headers),
    fetchResetCredits(headers),
    fetchStatus(OPENAI_STATUS_URL),
  ]);

  if ("error" in usageRes) {
    return json({ error: usageRes.error, auth: usageRes.auth }, usageRes.status);
  }

  const payload: OpenAIPayload = {
    plan: planLabel(usageRes.usage.plan_type),
    usage: usageRes.usage,
    resetCredits,
    status,
    fetchedAt: new Date().toISOString(),
  };
  return json(payload);
}

type UsageResult =
  | { usage: RawOpenAIUsage }
  | { error: string; status: number; auth?: boolean };

/**
 * Only the keys the UI renders are forwarded — `user_id` / `account_id` /
 * `email` and the referral/upsell payloads stay on the server.
 */
function pick(raw: Record<string, unknown>): RawOpenAIUsage {
  const keys = [
    "plan_type",
    "rate_limit",
    "code_review_rate_limit",
    "additional_rate_limits",
    "credits",
    "spend_control",
    "rate_limit_reached_type",
    "rate_limit_reset_credits",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in raw) out[k] = raw[k];
  return out as RawOpenAIUsage;
}

/** Only the keys the UI renders — the credit `id` and the grant's profile stay here. */
function pickCredit(raw: Record<string, unknown>): OpenAIResetCredit {
  const keys = [
    "status",
    "title",
    "description",
    "expires_at",
    "is_supported_by_plan",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in raw) out[k] = raw[k];
  return out as OpenAIResetCredit;
}

/**
 * The per-credit list, which is the only place OpenAI says when a reset
 * **expires** — the inline `rate_limit_reset_credits` block is counts only.
 * Best-effort on purpose: a failure here returns null and the panel falls back
 * to those counts rather than showing an error for a secondary detail.
 */
async function fetchResetCredits(
  headers: Record<string, string>,
): Promise<OpenAIResetCredit[] | null> {
  try {
    const res = await fetchWithTimeout(RESET_CREDITS_URL, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const raw = (await res.json()) as { credits?: unknown };
    if (!Array.isArray(raw?.credits)) return null;
    return raw.credits
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map(pickCredit);
  } catch {
    return null;
  }
}

async function fetchUsage(headers: Record<string, string>): Promise<UsageResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(USAGE_URL, { headers, cache: "no-store" });
  } catch {
    return { error: "Couldn't reach chatgpt.com. Check your connection.", status: 502 };
  }

  if (res.status === 401 || res.status === 403) {
    // Codex refreshes its own token on any command; that's the cheapest fix.
    return {
      error:
        "ChatGPT token expired. Run any `codex` command (or `codex login`) to refresh it, then refresh here.",
      status: 401,
      auth: true,
    };
  }
  if (!res.ok) {
    console.error("[openai] wham/usage failed", res.status);
    return { error: `chatgpt.com returned ${res.status} fetching usage.`, status: 502 };
  }

  const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return { error: "chatgpt.com returned an unreadable response.", status: 502 };
  return { usage: pick(raw) };
}
