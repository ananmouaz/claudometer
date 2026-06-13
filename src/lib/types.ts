/** A single usage limit bucket as returned by claude.ai's /usage endpoint. */
export type Bucket = {
  utilization: number; // 0–100 integer
  resets_at: string | null; // ISO-8601, or null when nothing has been used
};

/** Raw shape of GET /api/organizations/{org}/usage (only the keys we render). */
export type RawUsage = {
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
  fetchedAt: string; // ISO-8601
};

export type UsageError = {
  error: string;
  /** true when the cookie was rejected (401/403) and the user should re-paste. */
  auth?: boolean;
};
