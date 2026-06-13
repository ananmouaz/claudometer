import type { OrgInfo, OrgSummary, RawUsage, StatusInfo, UsagePayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAUDE = "https://claude.ai";
// summary.json carries the same rollup as status.json PLUS per-component status,
// active (unresolved) incidents and scheduled maintenance — so our one-liner can
// match what the status website actually shows, not just the headline.
const STATUS_URL = "https://status.claude.com/api/v2/summary.json";

// statuspage component → overall indicator severity.
const COMPONENT_INDICATOR: Record<string, StatusInfo["indicator"]> = {
  degraded_performance: "minor",
  partial_outage: "major",
  major_outage: "critical",
  under_maintenance: "maintenance",
};

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Cloudflare ties the cf_clearance cookie to the IP + the exact User-Agent that
// solved the challenge, so we forward the caller's real UA (from the browser)
// rather than a hardcoded one — otherwise Cloudflare re-challenges with a 403.
// The cookie is forwarded verbatim and never stored on our side.
function claudeHeaders(cookie: string, userAgent: string): HeadersInit {
  return {
    Cookie: cookie,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": userAgent || DEFAULT_UA,
    Referer: `${CLAUDE}/settings/usage`,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseOrgs(orgs: unknown): OrgInfo[] {
  if (!Array.isArray(orgs)) return [];
  return orgs
    .filter((o) => o?.uuid)
    .map((o) => ({
      uuid: String(o.uuid),
      name: String(o.name ?? "Organization"),
      plan: planLabel(o),
    }));
}

// Only surface a badge for plan names we recognise — claude.ai exposes billing
// internals (e.g. "stripe_subscription", "none") that aren't real plan labels.
const PLAN_MAP: Record<string, string> = {
  claude_max: "Max",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  raven: "Team",
  max: "Max",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
};

/** Human plan label ("Max", "Pro", "Team", …); null when not clearly known. */
function planLabel(o: Record<string, unknown>): string | null {
  for (const v of [o.organization_type, o.billing_type, o.rate_limit_tier]) {
    const key = String(v ?? "").toLowerCase();
    if (PLAN_MAP[key]) return PLAN_MAP[key];
  }
  return null;
}

const pct = (n: unknown): number =>
  typeof n === "number" && !Number.isNaN(n) ? n : 0;

/** Higher = more active. Any live reset window dominates; ties break on % used. */
function activityScore(u: RawUsage): number {
  const active = (u.five_hour?.resets_at ? 1 : 0) + (u.seven_day?.resets_at ? 1 : 0);
  const used =
    pct(u.five_hour?.utilization) +
    pct(u.seven_day?.utilization) +
    pct(u.seven_day_opus?.utilization) +
    pct(u.seven_day_sonnet?.utilization);
  return active * 1000 + used;
}

export async function POST(req: Request): Promise<Response> {
  let cookie = "";
  let userAgent = "";
  let wantUuid = "";
  try {
    const body = (await req.json()) as {
      cookie?: string;
      userAgent?: string;
      orgUuid?: string;
    };
    cookie = (body.cookie ?? "").trim();
    userAgent = (body.userAgent ?? "").trim();
    wantUuid = (body.orgUuid ?? "").trim();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (!cookie) return json({ error: "Paste your claude.ai cookie first." }, 400);

  const headers = claudeHeaders(cookie, userAgent);

  // 1) List organizations.
  let orgRes: Response;
  try {
    orgRes = await fetch(`${CLAUDE}/api/organizations`, { headers, cache: "no-store" });
  } catch {
    return json({ error: "Couldn't reach claude.ai. Check your connection." }, 502);
  }
  if (!orgRes.ok) {
    const snippet = (await orgRes.text().catch(() => "")).slice(0, 300);
    console.error("[usage] /api/organizations failed", orgRes.status, snippet.slice(0, 120));
    if (orgRes.status === 401) {
      return json(
        { error: "Cookie expired or invalid — paste a fresh one.", auth: true },
        401,
      );
    }
    if (orgRes.status === 403) {
      return json(
        {
          error:
            "claude.ai blocked the request (403, Cloudflare). Re-copy the entire Cookie header — it must include cf_clearance — from the same browser.",
          auth: true,
        },
        403,
      );
    }
    return json({ error: `claude.ai returned ${orgRes.status} fetching organizations.` }, 502);
  }

  const orgs = parseOrgs(await orgRes.json().catch(() => null));
  if (orgs.length === 0) {
    return json({ error: "No organization found for this account." }, 502);
  }

  // 2) Fetch usage for every org (so we can auto-pick the active one) + status.
  const [usages, statusInfo] = await Promise.all([
    Promise.all(orgs.map((o) => fetchUsage(o.uuid, headers))),
    fetchStatus(),
  ]);

  if (usages.every((u) => u.status === 401 || u.status === 403)) {
    return json({ error: "Cookie expired or invalid — paste a fresh one.", auth: true }, 401);
  }

  const summaries: OrgSummary[] = orgs.map((o, i) => ({
    ...o,
    session: pct(usages[i].usage.five_hour?.utilization),
    weekly: pct(usages[i].usage.seven_day?.utilization),
  }));

  // Pick the requested org, else the most active one.
  let idx = wantUuid ? orgs.findIndex((o) => o.uuid === wantUuid) : -1;
  if (idx < 0) {
    idx = usages.reduce(
      (best, u, i) =>
        activityScore(u.usage) > activityScore(usages[best].usage) ? i : best,
      0,
    );
  }

  const payload: UsagePayload = {
    org: orgs[idx],
    usage: usages[idx].usage,
    orgs: summaries,
    status: statusInfo,
    fetchedAt: new Date().toISOString(),
  };
  return json(payload);
}

async function fetchUsage(
  uuid: string,
  headers: HeadersInit,
): Promise<{ status: number; usage: RawUsage }> {
  try {
    const res = await fetch(`${CLAUDE}/api/organizations/${uuid}/usage`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { status: res.status, usage: {} };
    return { status: 200, usage: (await res.json().catch(() => ({}))) as RawUsage };
  } catch {
    return { status: 0, usage: {} };
  }
}

type StatusComponent = { name: string; status: string; group?: boolean };
type StatusIncident = { name: string; impact?: string };
type SummaryJson = {
  status?: StatusInfo;
  components?: StatusComponent[];
  incidents?: StatusIncident[];
};

async function fetchStatus(): Promise<StatusInfo | null> {
  try {
    const res = await fetch(STATUS_URL, { cache: "no-store" });
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
