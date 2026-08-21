import type { OrgInfo, OrgSummary, RawUsage, UsagePayload } from "@/lib/types";
import { json } from "@/lib/http";
import { CLAUDE_STATUS_URL, fetchStatus } from "@/lib/status";
import { claudeTransport, type ClaudeTransport } from "@/lib/claude-transport";
import { sessionBucket, weeklyAllBucket, weeklyRows } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const session = sessionBucket(u);
  const weekly = weeklyRows(u);
  const active =
    (session?.resets_at ? 1 : 0) + (weekly.some((r) => r.bucket.resets_at) ? 1 : 0);
  const used = weekly.reduce(
    (sum, r) => sum + pct(r.bucket.utilization),
    pct(session?.utilization),
  );
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
  // The Chromium bridge carries the session itself, so a cookie is only needed
  // when we're falling back to a direct fetch (the plain-browser build).
  const transport = await claudeTransport(cookie, userAgent);
  if (transport.kind === "cookie" && !cookie) {
    return json({ error: "Paste your claude.ai cookie first." }, 400);
  }

  // 1) List organizations.
  let orgRes: { status: number; json: unknown };
  try {
    orgRes = await transport.get("/api/organizations");
  } catch {
    return json({ error: "Couldn't reach claude.ai. Check your connection." }, 502);
  }
  if (orgRes.status !== 200) {
    console.error("[usage] /api/organizations failed", orgRes.status, transport.kind);
    return json(authError(orgRes.status, transport), authStatus(orgRes.status));
  }

  const orgs = parseOrgs(orgRes.json);
  if (orgs.length === 0) {
    return json({ error: "No organization found for this account." }, 502);
  }

  // 2) Fetch usage for every org (so we can auto-pick the active one) + status.
  const [usages, statusInfo] = await Promise.all([
    Promise.all(orgs.map((o) => fetchUsage(o.uuid, transport))),
    fetchStatus(CLAUDE_STATUS_URL),
  ]);

  if (usages.every((u) => u.status === 401 || u.status === 403)) {
    return json(authError(401, transport), 401);
  }

  const summaries: OrgSummary[] = orgs.map((o, i) => ({
    ...o,
    session: pct(sessionBucket(usages[i].usage)?.utilization),
    weekly: pct(weeklyAllBucket(usages[i].usage)?.utilization),
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
    via: transport.kind,
    fetchedAt: new Date().toISOString(),
  };
  return json(payload);
}

const authStatus = (upstream: number): number =>
  upstream === 401 || upstream === 403 ? upstream : 502;

/**
 * Message the user can act on. The two transports fail for unrelated reasons, so
 * they need different advice: the bridge means the in-app session is dead (sign
 * in again), while a direct fetch that 403s is almost always Cloudflare refusing
 * Node's fingerprint — no cookie fixes that, so say so instead of sending the
 * user back to DevTools for a cookie that can't work.
 */
function authError(
  upstream: number,
  transport: ClaudeTransport,
): { error: string; auth?: boolean } {
  if (transport.kind === "bridge") {
    return {
      error: "Your Claude session expired. Click “Sign in to Claude” to reconnect.",
      auth: true,
    };
  }
  if (upstream === 403) {
    return {
      error:
        "Cloudflare blocked the request (403). It rejects requests from outside a browser regardless of cookie, so use the menu-bar app — it signs in and reads your usage through Chromium.",
      auth: true,
    };
  }
  if (upstream === 401) {
    return { error: "Cookie expired or invalid — paste a fresh one.", auth: true };
  }
  return { error: `claude.ai returned ${upstream} fetching organizations.` };
}

async function fetchUsage(
  uuid: string,
  transport: ClaudeTransport,
): Promise<{ status: number; usage: RawUsage }> {
  try {
    const res = await transport.get(`/api/organizations/${uuid}/usage`);
    if (res.status !== 200) return { status: res.status, usage: {} };
    return { status: 200, usage: (res.json ?? {}) as RawUsage };
  } catch {
    return { status: 0, usage: {} };
  }
}
