import type { Bucket, LimitEntry, RawUsage } from "./types";

/**
 * Reading the usage response. Prefer the `limits` array — it's the only place
 * newer per-model limits (Fable and whatever follows) show up. Fall back to the
 * legacy top-level buckets when a response has no `limits`.
 */

export type WeeklyRow = {
  key: string;
  label: string;
  /** Set for per-model rows; drives the "You haven't used X yet" subtitle. */
  model?: string;
  bucket: Bucket;
};

const toBucket = (l: LimitEntry): Bucket => ({
  utilization: typeof l.percent === "number" ? l.percent : 0,
  resets_at: l.resets_at ?? null,
});

const entries = (usage: RawUsage): LimitEntry[] =>
  Array.isArray(usage.limits) ? usage.limits : [];

const isWeekly = (l: LimitEntry): boolean =>
  l.group === "weekly" || l.kind.startsWith("weekly");

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

export function sessionBucket(usage: RawUsage): Bucket | null {
  const l = entries(usage).find((x) => x.kind === "session" || x.group === "session");
  return l ? toBucket(l) : (usage.five_hour ?? null);
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
export function weeklyRows(usage: RawUsage): WeeklyRow[] {
  const weekly = entries(usage).filter(isWeekly);
  if (weekly.length > 0) {
    return weekly.flatMap((l, i) => {
      const name = scopeName(l);
      if (name) {
        return [{ key: `${l.kind}-${name}-${i}`, label: `${name} only`, model: name, bucket: toBucket(l) }];
      }
      // Unscoped weekly limit = the account-wide one. A scoped entry we can't
      // name is dropped rather than rendered as a mystery bar.
      if (l.kind === "weekly_all" || !l.scope) {
        return [{ key: `${l.kind}-${i}`, label: "All models", bucket: toBucket(l) }];
      }
      return [];
    });
  }

  return LEGACY_WEEKLY.flatMap((row) => {
    const b = usage[row.key];
    return b ? [{ ...row, bucket: b }] : [];
  });
}
