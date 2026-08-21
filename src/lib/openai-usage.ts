import type {
  OpenAIExtraLimit,
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

const rowFrom = (w: OpenAIWindow, key: string, label?: string): OpenAIRow => ({
  key,
  label: label ?? windowLabel(w.limit_window_seconds),
  usedPercent: pct(w.used_percent),
  resetAt: resetOf(w),
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

/** Every limit to render, in the order chatgpt.com lists them. */
export function usageRows(usage: RawOpenAIUsage): OpenAIRow[] {
  const rl = usage.rate_limit ?? null;
  const main = [rl?.primary_window ?? null, rl?.secondary_window ?? null]
    .filter((w): w is OpenAIWindow => w !== null)
    .map((w, i) => rowFrom(w, `window-${i}`));
  return [...main, ...extraRows(usage.additional_rate_limits)];
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

/** How many one-off "usage limit resets" the account can spend right now. */
export function resetCreditCount(usage: RawOpenAIUsage): number {
  const c = usage.rate_limit_reset_credits ?? null;
  const n = c?.applicable_available_count ?? c?.available_count;
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** The highest used-% across every window, for the menu-bar glyph. */
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
