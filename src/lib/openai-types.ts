import type { StatusInfo } from "./types";

/**
 * Raw shape of GET https://chatgpt.com/backend-api/wham/usage.
 *
 * This is what powers chatgpt.com's *Settings → Usage* screen. Note the scope
 * OpenAI states there: the quota is shared across Codex, Work, Workspace Agents
 * and ChatGPT for Excel, and it does NOT include plain Chat conversations —
 * there is no endpoint for those. Don't relabel this as "ChatGPT usage".
 *
 * Fields below were read off a live `team` account. Anything marked unconfirmed
 * came back null there, so its shape is inferred — read everything through
 * `openai-usage.ts` rather than off the raw JSON.
 */

/**
 * One rate-limit window. `limit_window_seconds` is the only reliable way to
 * label it: which window lands in `primary_window` varies by plan (a team
 * account puts the *weekly* one there, with no secondary at all), so never
 * assume primary = 5-hour.
 */
export type OpenAIWindow = {
  used_percent?: number; // 0–100
  limit_window_seconds?: number; // 18000 = 5-hour, 604800 = weekly
  reset_after_seconds?: number;
  reset_at?: number; // unix *seconds*, not milliseconds
};

export type OpenAIRateLimit = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: OpenAIWindow | null;
  secondary_window?: OpenAIWindow | null;
};

/**
 * A named per-model limit (e.g. Codex Spark, as its own 5-hour + weekly pair).
 * Unconfirmed: `additional_rate_limits` is null on the account this was built
 * against, so the naming key is read tolerantly in `extraRows()` and entries we
 * can't name are dropped rather than rendered as a mystery bar.
 */
export type OpenAIExtraLimit = OpenAIWindow & {
  name?: string | null;
  id?: string | null;
  slug?: string | null;
  title?: string | null;
  label?: string | null;
  window?: OpenAIWindow | null;
  rate_limit?: OpenAIRateLimit | null;
};

export type OpenAICredits = {
  has_credits?: boolean;
  unlimited?: boolean;
  overage_limit_reached?: boolean;
  balance?: number | null;
  approx_local_messages?: number | null;
  approx_cloud_messages?: number | null;
};

/**
 * Workspace spend controls. Amounts arrive as decimal *strings* with no currency
 * field anywhere in the response, so the unit is genuinely unknown (credits or
 * dollars). chatgpt.com's own Usage screen doesn't render this block either —
 * so neither do we. Kept typed so it's a small change if the unit is confirmed.
 */
export type OpenAISpendLimit = {
  source?: string; // e.g. "workspace_spend_controls"
  limit?: string;
  used?: string;
  remaining?: string;
  used_percent?: number;
  remaining_percent?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

export type OpenAISpendControl = {
  reached?: boolean;
  individual_limit?: OpenAISpendLimit | null;
};

/** Why the account is capped — drives the banner copy, like chatgpt.com's does. */
export type OpenAIReachedType = {
  type?: string; // e.g. "workspace_member_credits_depleted"
  details?: unknown; // only ever seen null
};

/**
 * "Usage limit resets" — one-off resets the account can spend to un-cap itself
 * early. The same counts also come back from
 * GET /backend-api/wham/rate-limit-reset-credits, so we don't call it: the
 * inline block is enough for the read-only view.
 */
export type OpenAIResetCredits = {
  available_count?: number;
  applicable_available_count?: number;
};

export type RawOpenAIUsage = {
  plan_type?: string | null; // "team" | "plus" | "pro" | …
  rate_limit?: OpenAIRateLimit | null;
  code_review_rate_limit?: OpenAIRateLimit | null;
  additional_rate_limits?: OpenAIExtraLimit[] | null;
  credits?: OpenAICredits | null;
  spend_control?: OpenAISpendControl | null;
  rate_limit_reached_type?: OpenAIReachedType | null;
  rate_limit_reset_credits?: OpenAIResetCredits | null;
  // `rate_limit_upsell` and `promo` are marketing payloads (referral offers,
  // "Notify owner" CTAs). Claudometer is read-only and can't perform those
  // actions, so they're deliberately not typed or forwarded.
  //
  // The response also carries `user_id`, `account_id` and `email`. Nothing in
  // the UI needs them, so the route strips them instead of shipping identity
  // down to the renderer — same privacy line as the claude.ai cookie.
};

/** What the /api/openai proxy hands back. */
export type OpenAIPayload = {
  /** Human plan label ("Team", "Plus", …); null when unrecognised. */
  plan: string | null;
  usage: RawOpenAIUsage;
  status: StatusInfo | null;
  fetchedAt: string; // ISO-8601
};
