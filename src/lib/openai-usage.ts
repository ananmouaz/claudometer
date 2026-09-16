import type {
  OpenAIExtraLimit,
  OpenAIResetCredit,
  OpenAIWindow,
  RawOpenAIUsage,
} from "./openai-types";

/**
 * Reading chatgpt.com's usage response. Mirrors `usage.ts` for claude.ai: the
 * UI never touches the raw JSON.
 *
 * The presentation deliberately follows chatgpt.com's own Usage screen, which
 * reports **remaining**, not used — "0% remaining" on a full bar. The bar still
 * fills with what's been consumed, so `usedPercent` is what's stored and
 * `remainingPercent` is derived at the edge.
 */

export type OpenAIRow = {
  key: string;
  label: string; // "Weekly usage limit"
  usedPercent: number; // 0–100
  resetAt: number | null; // unix seconds
  /** Window length in seconds, or null when OpenAI didn't say. */
  windowSeconds: number | null;
};

const HOUR_S = 3_600;
const DAY_S = 86_400;

/** Windows OpenAI actually returns; anything else falls back to a duration. */
const WINDOW_LABELS: Record<number, string> = {
  [5 * HOUR_S]: "5-hour usage limit",
  [DAY_S]: "Daily usage limit",
  [7 * DAY_S]: "Weekly usage limit",
  [30 * DAY_S]: "Monthly usage limit",
};

/** "Weekly usage limit" / "12-hour usage limit" / bare "Usage limit". */
function windowLabel(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "Usage limit";
  }
  const known = WINDOW_LABELS[seconds];
  if (known) return known;
  if (seconds % DAY_S === 0) {
    const d = seconds / DAY_S;
    return `${d}-day usage limit`;
  }
  const h = Math.round(seconds / HOUR_S);
  return h > 0 ? `${h}-hour usage limit` : "Usage limit";
}

const pct = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;

const resetOf = (w: OpenAIWindow): number | null =>
  typeof w.reset_at === "number" && Number.isFinite(w.reset_at) ? w.reset_at : null;

const windowSecondsOf = (w: OpenAIWindow): number | null =>
  typeof w.limit_window_seconds === "number" && Number.isFinite(w.limit_window_seconds)
    ? w.limit_window_seconds
    : null;

const rowFrom = (w: OpenAIWindow, key: string, label?: string): OpenAIRow => ({
  key,
  label: label ?? windowLabel(w.limit_window_seconds),
  usedPercent: pct(w.used_percent),
  resetAt: resetOf(w),
  windowSeconds: windowSecondsOf(w),
});

/**
 * Per-model limits (Codex Spark and friends). Unconfirmed shape — every account
 * seen so far returns null — so accept several spellings of the name and both a
 * nested and an inline window. Anything we can't name is dropped.
 */
function extraRows(list: OpenAIExtraLimit[] | null | undefined): OpenAIRow[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((e, i) => {
    const name = e.title || e.label || e.name || e.id || e.slug;
    if (!name) return [];
    const windows: OpenAIWindow[] = [
      e.window ?? null,
      e.rate_limit?.primary_window ?? null,
      e.rate_limit?.secondary_window ?? null,
    ].filter((w): w is OpenAIWindow => w !== null);
    // No nested window at all → the entry is itself a window.
    if (windows.length === 0) windows.push(e);
    return windows.map((w, j) => {
      const suffix = w.limit_window_seconds
        ? ` · ${windowLabel(w.limit_window_seconds).replace(/ usage limit$/, "")}`
        : "";
      return rowFrom(w, `extra-${i}-${j}`, `${name}${suffix}`);
    });
  });
}

/**
 * The account-wide windows only. Which one lands in `primary_window` is
 * plan-dependent, so callers must read `windowSeconds`, never the position.
 */
function mainRows(usage: RawOpenAIUsage): OpenAIRow[] {
  const rl = usage.rate_limit ?? null;
  return [rl?.primary_window ?? null, rl?.secondary_window ?? null]
    .filter((w): w is OpenAIWindow => w !== null)
    .map((w, i) => rowFrom(w, `window-${i}`));
}

/** Every limit to render, in the order chatgpt.com lists them. */
export function usageRows(usage: RawOpenAIUsage): OpenAIRow[] {
  return [...mainRows(usage), ...extraRows(usage.additional_rate_limits)];
}

/** True once OpenAI says the account is capped — drives the red banner. */
export function limitReached(usage: RawOpenAIUsage): boolean {
  const rl = usage.rate_limit ?? null;
  if (!rl) return false;
  return rl.limit_reached === true || rl.allowed === false;
}

/**
 * chatgpt.com's banner copy. The API's `rate_limit_upsell.title` is a marketing
 * headline ("Get 500 credits"), not this — the real banner is client-side text
 * keyed on `rate_limit_reached_type.type`, so we key on it the same way and fall
 * back to the generic wording for types we haven't seen.
 */
export function reachedBanner(
  usage: RawOpenAIUsage,
): { title: string; body: string } | null {
  if (!limitReached(usage)) return null;
  const title = "You're out of usage for now";
  switch (usage.rate_limit_reached_type?.type) {
    case "workspace_member_credits_depleted":
      return {
        title,
        body: "Wait for your usage to reset, or ask your workspace owner to add credits.",
      };
    default:
      return { title, body: "Wait for your usage to reset." };
  }
}

/**
 * One-off "usage limit resets".
 *
 * Two different numbers, and conflating them hid the section on every healthy
 * account: a live response reads `{ available_count: 3,
 * applicable_available_count: 0 }` — three resets owned, none *applicable*
 * because no limit is currently reached. chatgpt.com shows the balance, so
 * `owned` is the headline; `applicableNow` only says whether one can be spent
 * this moment. Don't collapse them back into one number.
 */
export function resetCredits(usage: RawOpenAIUsage): {
  owned: number;
  applicableNow: number;
} {
  const c = usage.rate_limit_reset_credits ?? null;
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
  return {
    owned: n(c?.available_count ?? c?.applicable_available_count),
    applicableNow: n(c?.applicable_available_count),
  };
}

export type ResetCreditRow = {
  key: string;
  title: string; // "Full reset"
  expiresAt: string | null; // ISO-8601
  /** Within a week of expiring — worth calling out, they're use-it-or-lose-it. */
  expiringSoon: boolean;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The unspent credits, soonest to expire first.
 *
 * Only `status === "available"` entries: the list also carries spent and expired
 * ones, and showing those as available would overstate what the account has.
 * Entries with no expiry sort last rather than being dropped — an undated credit
 * is still a credit.
 */
export function resetCreditRows(
  list: OpenAIResetCredit[] | null | undefined,
): ResetCreditRow[] {
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  return list
    .filter((c) => (c.status ?? "available") === "available")
    .map((c, i) => {
      const t = c.expires_at ? Date.parse(c.expires_at) : NaN;
      const expiresAt = Number.isNaN(t) ? null : (c.expires_at as string);
      return {
        key: `reset-${i}`,
        title: c.title?.trim() || "Usage limit reset",
        expiresAt,
        expiringSoon: expiresAt !== null && t - now < WEEK_MS,
      };
    })
    .sort((a, b) => {
      const at = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
      const bt = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
      return at - bt;
    });
}

/**
 * Used-% at or above which a window takes over the menu-bar readout. Same 85
 * that turns the tray number red in `tray-usage.ts` — so whenever the escalation
 * below swaps which window is shown, the number is already red and the swap is
 * visible rather than silent.
 */
const ESCALATE_AT = 85;

/**
 * The number for the menu bar.
 *
 * Normally the **shortest** account-wide window, so it matches the session
 * reading on the Claude side and stays stable — "worst window" silently swapped
 * meaning as the week filled up, with nothing on screen to mark the swap. Plans
 * that publish only a weekly window (team/business) fall through to that one.
 *
 * The exception: once a longer window crosses `ESCALATE_AT`, it becomes the
 * number instead. A green "5-hour 8%" while the weekly sits at 97% is the one
 * case where the stable choice actively misleads — three more messages and
 * you're capped for days. Per-model entries from `additional_rate_limits` are
 * excluded throughout; they aren't the account's limit.
 */
export function headlineUsedPercent(usage: RawOpenAIUsage): number {
  const rows = mainRows(usage);
  if (rows.length === 0) return peakUsedPercent(usage);
  const worst = rows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  if (worst.usedPercent >= ESCALATE_AT) return worst.usedPercent;
  return rows.reduce((best, r) =>
    (r.windowSeconds ?? Infinity) < (best.windowSeconds ?? Infinity) ? r : best,
  ).usedPercent;
}

/** The highest used-% across every window. */
export function peakUsedPercent(usage: RawOpenAIUsage): number {
  return usageRows(usage).reduce((max, r) => Math.max(max, r.usedPercent), 0);
}

const PLAN_MAP: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

/** Human plan label, or null for values we don't recognise. */
export function planLabel(planType: string | null | undefined): string | null {
  return PLAN_MAP[String(planType ?? "").toLowerCase()] ?? null;
}
