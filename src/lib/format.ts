// Pure formatting helpers — safe to import on both server and client. All times
// render in the viewer's own locale / timezone.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "Resets in 33 min" / "Resets at 6:19 PM" / "Resets Tue 12:59 PM". */
export function formatSessionReset(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const d = new Date(resetsAt);
  const ms = d.getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "Resets shortly";
  if (ms < HOUR) {
    const mins = Math.max(1, Math.round(ms / MIN));
    return `Resets in ${mins} min`;
  }
  if (ms < DAY) {
    return `Resets at ${timeOnly(d)}`;
  }
  return `Resets ${weekdayTime(d)}`;
}

/** "Resets Tue 12:59 PM". */
export function formatWeeklyReset(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return "";
  return `Resets ${weekdayTime(d)}`;
}

/** "less than a minute ago" / "3 min ago" / "2 hr ago". */
export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  if (ms < MIN) return "less than a minute ago";
  if (ms < HOUR) {
    const m = Math.round(ms / MIN);
    return `${m} min ago`;
  }
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `${h} hr ago`;
  }
  const days = Math.round(ms / DAY);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function timeOnly(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function weekdayTime(d: Date): string {
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${timeOnly(d)}`;
}

export function clampPct(n: number | undefined): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** "€0.00" — falls back to a plain number if the currency code is unusable. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** "$3.20 of $10.00" for the dollar-metered buckets. */
export function formatDollars(n: number): string {
  return formatMoney(n, "USD");
}

/**
 * Splits a one-link markdown string into the parts around it, so the caller can
 * render a real anchor. Returns null when there's no `[text](url)` to pull out.
 */
export function splitMarkdownLink(
  md: string,
): { before: string; text: string; href: string; after: string } | null {
  const m = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(md);
  if (!m) return null;
  return {
    before: md.slice(0, m.index),
    text: m[1],
    href: m[2],
    after: md.slice(m.index + m[0].length),
  };
}
