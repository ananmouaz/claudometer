import type { StatusInfo } from "./types";
import { fetchWithTimeout } from "./http";

/**
 * Statuspage summaries. Both Anthropic and OpenAI publish the same schema, so
 * one reader serves both — pass the provider's summary.json URL.
 *
 * summary.json carries the same rollup as status.json PLUS per-component status,
 * active (unresolved) incidents and scheduled maintenance — so our one-liner can
 * match what the status website actually shows, not just the headline.
 */
export const CLAUDE_STATUS_URL = "https://status.claude.com/api/v2/summary.json";
export const OPENAI_STATUS_URL = "https://status.openai.com/api/v2/summary.json";

// statuspage component → overall indicator severity.
const COMPONENT_INDICATOR: Record<string, StatusInfo["indicator"]> = {
  degraded_performance: "minor",
  partial_outage: "major",
  major_outage: "critical",
  under_maintenance: "maintenance",
};

type StatusComponent = { name: string; status: string; group?: boolean };
type StatusIncident = { name: string; impact?: string };
type SummaryJson = {
  status?: StatusInfo;
  components?: StatusComponent[];
  incidents?: StatusIncident[];
};

export async function fetchStatus(url: string): Promise<StatusInfo | null> {
  try {
    const res = await fetchWithTimeout(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as SummaryJson;
    const rollup = data.status ?? null;

    // An unresolved incident is the most important thing to surface — and its
    // own `impact` (none/minor/major/critical/maintenance) is the real color,
    // not the page rollup (which can still read "none" during a minor incident).
    const incident = data.incidents?.[0];
    if (incident?.name) {
      const impact = incident.impact;
      const indicator = impact && impact !== "none" ? impact : "minor";
      return { indicator, description: incident.name };
    }

    // Otherwise reflect the single most-degraded component, if any.
    const degraded = (data.components ?? [])
      .filter((c) => !c.group && c.status && c.status !== "operational")
      .map((c) => ({ c, sev: COMPONENT_INDICATOR[c.status] ?? "minor" }));
    if (degraded.length > 0) {
      const order = ["minor", "maintenance", "major", "critical"];
      const worst = degraded.reduce((a, b) =>
        order.indexOf(b.sev) > order.indexOf(a.sev) ? b : a,
      );
      const label = worst.c.status.replace(/_/g, " ");
      return { indicator: worst.sev, description: `${worst.c.name}: ${label}` };
    }

    return rollup;
  } catch {
    return null;
  }
}
