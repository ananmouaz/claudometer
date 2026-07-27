import type { Bucket, LimitEntry, Money, RawUsage } from "./types";

/**
 * Reading the usage response. Prefer the `limits` array — it's the only place
 * newer per-model limits (Fable and whatever follows) show up. Fall back to the
 * legacy top-level buckets when a response has no `limits`.
 */

export type UsageRow = {
  key: string;
  label: string;
  /** Set for per-model rows; drives the "You haven't used X yet" subtitle. */
  model?: string;
  bucket: Bucket;
  /** claude.ai's own severity ("normal" | "critical" | …); null on legacy responses. */
  severity: string | null;
  /** The API's flag for the limit currently binding this account. */
  isActive: boolean;
};

const toBucket = (l: LimitEntry): Bucket => ({
  utilization: typeof l.percent === "number" ? l.percent : 0,
  resets_at: l.resets_at ?? null,
});

const entries = (usage: RawUsage): LimitEntry[] =>
  Array.isArray(usage.limits) ? usage.limits : [];

const isWeekly = (l: LimitEntry): boolean =>
  l.group === "weekly" || l.kind.startsWith("weekly");

const rowFrom = (l: LimitEntry, key: string, label: string, model?: string): UsageRow => ({
  key,
  label,
  ...(model ? { model } : {}),
  bucket: toBucket(l),
  severity: l.severity ?? null,
  isActive: l.is_active === true,
});

/** Human name for a scoped limit — the model, else the surface it applies to. */
function scopeName(l: LimitEntry): string | null {
  const scope = l.scope;
  if (!scope) return null;
  const model = scope.model?.display_name;
  if (model) return model;
  const surface =
    typeof scope.surface === "string" ? scope.surface : scope.surface?.display_name;
  return surface || null;
}

export function sessionRow(usage: RawUsage): UsageRow | null {
  const l = entries(usage).find((x) => x.kind === "session" || x.group === "session");
  if (l) return rowFrom(l, "session", "Current session");
  const b = usage.five_hour;
  return b
    ? { key: "session", label: "Current session", bucket: b, severity: null, isActive: false }
    : null;
}

export function sessionBucket(usage: RawUsage): Bucket | null {
  return sessionRow(usage)?.bucket ?? null;
}

export function weeklyAllBucket(usage: RawUsage): Bucket | null {
  const l = entries(usage).find((x) => x.kind === "weekly_all");
  return l ? toBucket(l) : (usage.seven_day ?? null);
}

const LEGACY_WEEKLY: { key: "seven_day" | "seven_day_opus" | "seven_day_sonnet"; label: string; model?: string }[] = [
  { key: "seven_day", label: "All models" },
  { key: "seven_day_opus", label: "Opus only", model: "Opus" },
  { key: "seven_day_sonnet", label: "Sonnet only", model: "Sonnet" },
];

/** Weekly rows in the order claude.ai returns them, so new models just appear. */
export function weeklyRows(usage: RawUsage): UsageRow[] {
  const weekly = entries(usage).filter(isWeekly);
  if (weekly.length > 0) {
    return weekly.flatMap((l, i) => {
      const name = scopeName(l);
      if (name) return [rowFrom(l, `${l.kind}-${name}-${i}`, `${name} only`, name)];
      // Unscoped weekly limit = the account-wide one. A scoped entry we can't
      // name is dropped rather than rendered as a mystery bar.
      if (l.kind === "weekly_all" || !l.scope) {
        return [rowFrom(l, `${l.kind}-${i}`, "All models")];
      }
      return [];
    });
  }

  return LEGACY_WEEKLY.flatMap((row) => {
    const b = usage[row.key];
    return b ? [{ ...row, bucket: b, severity: null, isActive: false }] : [];
  });
}

/**
 * Limits the account is currently up against. Prefers the API's `is_active`
 * flag and falls back to severity / a full bar, so legacy responses still warn.
 */
export function reachedLimits(usage: RawUsage): UsageRow[] {
  const all = [sessionRow(usage), ...weeklyRows(usage)].filter(
    (r): r is UsageRow => r !== null,
  );
  const maxed = (r: UsageRow) => r.severity === "critical" || r.bucket.utilization >= 100;
  const active = all.filter((r) => r.isActive && maxed(r));
  return active.length > 0 ? active : all.filter(maxed);
}

/* ---------- Extra usage (pay-as-you-go credits) ---------- */

export type SpendView = {
  used: Money | null;
  limit: Money | null;
  /** The configured ceiling — `spend.cap.money`, else `spend.limit`. */
  cap: Money | null;
  percent: number;
  severity: string | null;
  /** True once claude.ai says further spend is blocked. */
  limitReached: boolean;
  canPurchase: boolean;
  disclaimer: string | null;
  /** Why the account can't spend, when claude.ai says so. */
  disabledReason: string | null;
};

const isMoney = (m: unknown): m is Money =>
  !!m &&
  typeof m === "object" &&
  typeof (m as Money).amount_minor === "number" &&
  typeof (m as Money).currency === "string";

const moneyOrNull = (m: unknown): Money | null => (isMoney(m) ? m : null);

export const moneyValue = (m: Money): number =>
  m.amount_minor / 10 ** (typeof m.exponent === "number" ? m.exponent : 2);

/**
 * The extra-usage panel, or null when the account has never touched credits —
 * no point rendering an all-zeroes section for a plain subscription.
 */
export function spendView(usage: RawUsage): SpendView | null {
  const spend = usage.spend ?? null;
  const extra = usage.extra_usage ?? null;
  if (!spend && !extra) return null;

  const everEnabled =
    extra?.credits_ever_enabled === true ||
    extra?.is_enabled === true ||
    spend?.enabled === true;
  if (!everEnabled) return null;

  const used = moneyOrNull(spend?.used);
  const limit = moneyOrNull(spend?.limit);
  const cap = moneyOrNull(spend?.cap?.money) ?? limit;

  return {
    used,
    limit,
    cap,
    percent: typeof spend?.percent === "number" ? spend.percent : 0,
    severity: spend?.severity ?? null,
    limitReached: extra?.spend_limit_reached === true,
    canPurchase: spend?.can_purchase_credits === true,
    disclaimer: spend?.disclaimer ?? null,
    disabledReason: spend?.disabled_reason ?? extra?.disabled_reason ?? null,
  };
}
