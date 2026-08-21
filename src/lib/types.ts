/** A single usage limit bucket as returned by claude.ai's /usage endpoint. */
export type Bucket = {
  utilization: number; // 0–100 integer
  resets_at: string | null; // ISO-8601, or null when nothing has been used
  // Only populated on dollar-metered accounts (null on subscription plans), and
  // only on the legacy top-level buckets — `limits` entries carry no dollars.
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
};

/**
 * One row of the newer `limits` array claude.ai's usage endpoint returns. This
 * is now the authoritative list: the old per-model `seven_day_opus` /
 * `seven_day_sonnet` keys come back `null` even when a model limit is maxed,
 * and new models (Fable) only ever appear here as a `weekly_scoped` entry.
 * `kind` is left as a string — Anthropic adds new kinds without notice.
 */
export type LimitEntry = {
  kind: string; // "session" | "weekly_all" | "weekly_scoped" | future kinds
  group?: string; // "session" | "weekly"
  percent?: number; // 0–100
  severity?: string; // "normal" | "critical" | …
  resets_at?: string | null;
  scope?: {
    model?: { id: string | null; display_name?: string | null } | null;
    // Observed null so far; tolerate a bare string or an object either way.
    surface?: { display_name?: string | null } | string | null;
  } | null;
  is_active?: boolean;
};

/** An amount of money in minor units — `amount_minor / 10 ** exponent`. */
export type Money = {
  amount_minor: number;
  currency: string; // ISO-4217, e.g. "EUR"
  exponent: number;
};

/** The pay-as-you-go side of the usage page: credits spent against a cap. */
export type SpendInfo = {
  used?: Money | null;
  limit?: Money | null;
  percent?: number;
  severity?: string;
  enabled?: boolean;
  disabled_reason?: string | null;
  cap?: { money?: Money | null; credits?: number | null } | null;
  balance?: number | null;
  can_purchase_credits?: boolean;
  can_toggle?: boolean;
  /** Markdown — contains a single `[text](url)` link. */
  disclaimer?: string | null;
};

/**
 * The older credits block, still returned alongside `spend`. `daily` / `weekly`
 * are left `unknown` — they've only ever been observed null, so their shape is
 * unconfirmed and rendering them would be a guess.
 */
export type ExtraUsage = {
  is_enabled?: boolean;
  monthly_limit?: number;
  used_credits?: number;
  utilization?: number | null;
  currency?: string;
  decimal_places?: number;
  disabled_reason?: string | null;
  user_disabled?: boolean;
  spend_limit_reached?: boolean;
  credits_ever_enabled?: boolean;
  daily?: unknown;
  weekly?: unknown;
};

/** Raw shape of GET /api/organizations/{org}/usage (only the keys we render). */
export type RawUsage = {
  limits?: LimitEntry[] | null;
  spend?: SpendInfo | null;
  extra_usage?: ExtraUsage | null;
  // Legacy top-level buckets, kept as a fallback for accounts/responses that
  // predate `limits`. Per-model ones are dead on current responses.
  five_hour?: Bucket | null;
  seven_day?: Bucket | null;
  seven_day_opus?: Bucket | null;
  seven_day_sonnet?: Bucket | null;
};

export type StatusInfo = {
  indicator: "none" | "minor" | "major" | "critical" | "maintenance" | string;
  description: string;
};

export type OrgInfo = { uuid: string; name: string; plan: string | null };

/** A row in the org switcher — org identity plus its headline percentages. */
export type OrgSummary = OrgInfo & { session: number; weekly: number };

/** Everything the /api/usage proxy hands back to the client. */
export type UsagePayload = {
  org: OrgInfo; // the auto-selected (most active) org
  usage: RawUsage;
  /** All orgs on the account, so the client can offer a switcher. */
  orgs: OrgSummary[];
  status: StatusInfo | null;
  /**
   * How the data was fetched: `bridge` = through the Electron shell's Chromium
   * session (no cookie involved), `cookie` = a direct fetch forwarding a pasted
   * cookie. The UI uses it to show the right connection controls.
   */
  via: "bridge" | "cookie";
  fetchedAt: string; // ISO-8601
};

export type UsageError = {
  error: string;
  /** true when the cookie was rejected (401/403) and the user should re-paste. */
  auth?: boolean;
};
