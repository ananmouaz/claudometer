"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Bucket, StatusInfo, UsagePayload } from "@/lib/types";
import {
  clampPct,
  formatDollars,
  formatMoney,
  formatRelative,
  formatSessionReset,
  formatWeeklyReset,
  splitMarkdownLink,
} from "@/lib/format";
import {
  moneyValue,
  reachedLimits,
  sessionRow,
  spendView,
  weeklyRows,
  type SpendView,
  type UsageRow,
} from "@/lib/usage";
import { reportUsage } from "./tray-usage";

const STORAGE_KEY = "claude_usage_cookie";
const UA_KEY = "claude_usage_ua";
const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";
const STATUS_PAGE_URL = "https://status.claude.com";

export function UsagePanel() {
  const [cookie, setCookie] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [uaDraft, setUaDraft] = useState("");
  const [data, setData] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [, setTick] = useState(0); // forces relative-time labels to refresh
  // Automatic capture only exists inside the Electron shell; a plain browser
  // has no cookie jar we can read, so there it stays false and the manual
  // paste is the only path. Set from an effect — `window` isn't there on SSR.
  const [canAutoCapture, setCanAutoCapture] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureNote, setCaptureNote] = useState<string | null>(null);

  const load = useCallback(
    async (c: string, orgUuid?: string, opts?: { background?: boolean }) => {
      const background = opts?.background ?? false;
      setLoading(true);
      // Keep any existing banner during a silent background refresh; a clean
      // run below clears it. Foreground loads reset it up front.
      if (!background) {
        setError(null);
        setDetail(null);
      }
      // Cloudflare's cf_clearance is bound to the UA that solved its challenge.
      // Prefer the user-saved browser UA; fall back to this runtime's UA.
      const ua = localStorage.getItem(UA_KEY) || navigator.userAgent;
      const reqBody = JSON.stringify({ cookie: c, userAgent: ua, orgUuid });

      // Retry transient failures reaching our own local proxy before surfacing
      // them: first launch can race the standalone server's boot, and the
      // menu-bar app briefly loses localhost on sleep/wake. Both self-heal in
      // under a second. An HTTP error (4xx/5xx) is a real answer — don't retry.
      const MAX_TRIES = 3;
      try {
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
          try {
            const res = await fetch("/api/usage", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: reqBody,
            });
            const body = await res.json();
            if (!res.ok) {
              setError(body?.error ?? "Something went wrong.");
              setDetail(body?.detail || null);
              // With one-click sign-in available, don't shove the paste helper
              // open on a dead session — the button right below it is enough.
              if (body?.auth && !window.electronAPI?.claudeSignIn) {
                setShowSetup(true);
              }
              return;
            }
            const payload = body as UsagePayload;
            setData(payload);
            setError(null);
            setDetail(null);
            // Mirror the session % onto the macOS menu bar (tinted by danger) in Electron.
            reportUsage("claude", clampPct(sessionRow(payload.usage)?.bucket.utilization));
            return;
          } catch {
            if (attempt < MAX_TRIES) {
              await new Promise((r) => setTimeout(r, attempt * 400));
              continue;
            }
            // Retries exhausted. Don't clobber a good screen mid-background
            // refresh — keep the last data and try again next cycle.
            if (!background) {
              setError("Network error — couldn't reach the server.");
            }
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Restore a saved cookie and fetch on first mount. The reads live in a nested
  // async fn so we're syncing from an external system (localStorage), not
  // setting state synchronously in the effect body.
  useEffect(() => {
    void (async () => {
      const auto = !!window.electronAPI?.claudeSignIn;
      setCanAutoCapture(auto);
      setUaDraft(localStorage.getItem(UA_KEY) || navigator.userAgent);
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setCookie(saved);
        setDraft(saved);
      }
      // In the shell the bridge carries the session, so fetch regardless of
      // whether a cookie was ever pasted. In the browser there's nothing to try
      // without one, so open the paste helper instead.
      if (auto || saved) await load(saved ?? "");
      else setShowSetup(true);
    })();
  }, [load]);

  // Keep "Last updated …" / "checked …" labels honest.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Latest values for the auto-refresh timer to read without stale closures.
  const live = useRef({ cookie, orgUuid: data?.org.uuid, loading, canAutoCapture });
  useEffect(() => {
    live.current = { cookie, orgUuid: data?.org.uuid, loading, canAutoCapture };
  });

  // Auto-refresh every 60s — even while the popover is hidden, so the menu-bar
  // glyph and % stay current (that's the whole point of a menu-bar meter).
  // Relies on the Electron window disabling backgroundThrottling, otherwise
  // Chromium freezes this timer once the window is hidden. Also refresh the
  // instant the popover is reopened, so it's never stale on open.
  useEffect(() => {
    const refresh = () => {
      const { cookie, orgUuid, loading, canAutoCapture } = live.current;
      // In the shell the bridge holds the session, so there's nothing to check
      // for — only skip when neither a cookie nor a bridge is available.
      if ((cookie || canAutoCapture) && !loading) {
        load(cookie ?? "", orgUuid, { background: true });
      }
    };
    const id = setInterval(refresh, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  function save() {
    const c = draft.trim();
    if (!c) return;
    localStorage.setItem(STORAGE_KEY, c);
    const ua = uaDraft.trim();
    if (ua) localStorage.setItem(UA_KEY, ua);
    else localStorage.removeItem(UA_KEY);
    setCookie(c);
    setShowSetup(false);
    load(c);
  }

  /**
   * One-click connect: the shell opens claude.ai in-app and reports success only
   * once the session actually answers an API call. Nothing is returned or stored
   * here — the session lives in the shell and the proxy reads it through the
   * Chromium bridge, so there's no cookie to manage at all.
   */
  async function signIn() {
    const start = window.electronAPI?.claudeSignIn;
    if (!start) return;
    setCapturing(true);
    setCaptureNote(null);
    try {
      const res = await start();
      if (res.ok) {
        setShowSetup(false);
        await load(cookie ?? "");
      } else if (res.reason === "cancelled") {
        setCaptureNote("Sign-in window closed — not connected.");
      } else if (res.reason === "in-progress") {
        setCaptureNote("The sign-in window is already open.");
      } else {
        setCaptureNote("Sign-in timed out. Try again.");
      }
    } catch {
      setCaptureNote("Couldn't open the sign-in window.");
    } finally {
      setCapturing(false);
    }
  }

  function clear() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(UA_KEY);
    setCookie(null);
    setDraft("");
    setUaDraft(navigator.userAgent);
    setData(null);
    setError(null);
    setShowSetup(true);
  }

  const sessionInfo = data ? sessionRow(data.usage) : null;
  const session = sessionInfo?.bucket ?? null;
  const sessionSeverity = sessionInfo?.severity ?? null;

  // The card frame and the brand bar belong to the tab shell (see shell.tsx);
  // this renders only the Claude tab's contents.
  return (
    <div className="flex flex-col gap-6 p-7">
      {/* Heading */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-semibold tracking-tight text-ink">
              Your usage limits
            </h1>
            {data?.org.plan && (
              <span className="text-sm text-muted">{data.org.plan}</span>
            )}
          </div>
          {data && data.orgs.length > 1 && (
            <select
              value={data.org.uuid}
              onChange={(e) => load(cookie ?? "", e.target.value)}
              className="max-w-[55%] truncate rounded-lg border border-edge bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-fill"
              title="Switch organization"
            >
              {data.orgs.map((o) => (
                <option key={o.uuid} value={o.uuid}>
                  {o.name} · {o.session}% / {o.weekly}%
                </option>
              ))}
            </select>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-[#5c3631] bg-[#3a221f] px-3.5 py-2.5 text-sm text-[#f0b3a8]">
            <div>{error}</div>
            {detail && (
              <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] text-[#d9a79c]">
                {detail}
              </pre>
            )}
          </div>
        )}

        {/* Usage body */}
        {data ? (
          <>
            <ReachedLimits rows={reachedLimits(data.usage)} />

            <LimitRow
              label="Current session"
              subtitle={formatSessionReset(session?.resets_at ?? null)}
              bucket={session}
              severity={sessionSeverity}
            />

            <div className="flex flex-col gap-5">
              <h2 className="text-base font-semibold text-ink">Weekly limits</h2>

              {weeklyRows(data.usage).map((row) => {
                const subtitle =
                  row.model && clampPct(row.bucket.utilization) === 0
                    ? `You haven't used ${row.model} yet`
                    : formatWeeklyReset(row.bucket.resets_at);
                return (
                  <LimitRow
                    key={row.key}
                    label={row.label}
                    subtitle={subtitle}
                    bucket={row.bucket}
                    severity={row.severity}
                  />
                );
              })}
            </div>

            <ExtraUsage spend={spendView(data.usage)} />

            {/* Last updated + refresh */}
            <div className="flex items-center gap-2 text-sm text-muted">
              <span>Last updated: {formatRelative(data.fetchedAt)}</span>
              <button
                onClick={() => load(cookie ?? "", data.org.uuid)}
                disabled={loading}
                aria-label="Refresh"
                className="rounded-md p-1 text-muted transition hover:bg-panel-2 hover:text-ink disabled:opacity-50"
              >
                <RefreshIcon spinning={loading} />
              </button>
            </div>

            <StatusLine status={data.status} fetchedAt={data.fetchedAt} />
          </>
        ) : (
          <div className="text-sm text-muted">
            {loading
              ? "Loading your usage…"
              : canAutoCapture
                ? "Sign in to Claude below to see your usage."
                : "Paste your claude.ai cookie below to see your usage."}
          </div>
        )}

      {/* Connection controls */}
      <div className="flex flex-col gap-2 border-t border-edge pt-4">
        {canAutoCapture && (
          <div className="flex items-center gap-3">
            <button
              onClick={signIn}
              disabled={capturing || loading}
              className="rounded-lg bg-fill px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {capturing
                ? "Waiting for sign-in…"
                : cookie
                  ? "Reconnect Claude account"
                  : "Sign in to Claude"}
            </button>
            {captureNote && <span className="text-xs text-muted">{captureNote}</span>}
          </div>
        )}

        <button
          onClick={() => setShowSetup((s) => !s)}
          className="self-start text-sm text-muted transition hover:text-ink"
        >
          {showSetup
            ? "Hide cookie"
            : canAutoCapture
              ? "Paste a cookie manually instead"
              : cookie
                ? "Show cookie"
                : "Set up cookie"}
        </button>

        {showSetup && (
          <CookieSetup
            draft={draft}
            setDraft={setDraft}
            uaDraft={uaDraft}
            setUaDraft={setUaDraft}
            onSave={save}
            onClear={clear}
            hasCookie={!!cookie}
            saving={loading}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Bar tint. claude.ai now sends its own `severity` per limit, so trust that over
 * our thresholds — it knows about caps we can't see. The percentage fallback is
 * for legacy responses that carry no `limits` array.
 */
function barColor(severity: string | null, pct: number): string {
  switch (severity) {
    case "critical":
      return "var(--bad)";
    case "warning":
    case "warn":
      return "var(--warn)";
    case "normal":
      return "var(--fill)";
    default:
      return pct >= 85 ? "var(--bad)" : pct >= 60 ? "var(--warn)" : "var(--fill)";
  }
}

/** "$3.20 of $10.00" when the account is dollar-metered, else "". */
function dollarLine(bucket: Bucket | null): string {
  if (!bucket || typeof bucket.limit_dollars !== "number") return "";
  const used = typeof bucket.used_dollars === "number" ? bucket.used_dollars : 0;
  return `${formatDollars(used)} of ${formatDollars(bucket.limit_dollars)}`;
}

function LimitRow({
  label,
  subtitle,
  bucket,
  severity = null,
}: {
  label: string;
  subtitle: string;
  bucket: Bucket | null;
  severity?: string | null;
}) {
  const pct = clampPct(bucket?.utilization);
  const dollars = dollarLine(bucket);
  return (
    <div className="flex items-center gap-4">
      <div className="w-40 shrink-0">
        <div className="text-[15px] font-medium text-ink">{label}</div>
        {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
        {dollars && <div className="mt-0.5 text-sm text-muted">{dollars}</div>}
      </div>
      <div className="flex-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-bar">
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%`, background: barColor(severity, pct) }}
          />
        </div>
      </div>
      <div className="w-16 shrink-0 text-right text-sm text-muted">{pct}% used</div>
    </div>
  );
}

/** Banner for limits claude.ai says are spent — the actionable bit up top. */
function ReachedLimits({ rows }: { rows: UsageRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-[#5c3631] bg-[#3a221f] px-3.5 py-2.5 text-sm text-[#f0b3a8]">
      {rows.map((row) => {
        const what = row.model ?? row.label.replace(/ only$/, "");
        const reset = formatWeeklyReset(row.bucket.resets_at) || "shortly";
        return (
          <div key={row.key}>
            {`You've hit your ${what} limit — ${reset.replace(/^Resets/, "resets")}`}
          </div>
        );
      })}
    </div>
  );
}

/** Pay-as-you-go credits, mirroring the extra-usage block on claude.ai. */
function ExtraUsage({ spend }: { spend: SpendView | null }) {
  if (!spend) return null;

  const currency = spend.used?.currency ?? spend.cap?.currency ?? "USD";
  const used = spend.used ? moneyValue(spend.used) : 0;
  const cap = spend.cap ? moneyValue(spend.cap) : 0;
  const pct = clampPct(spend.percent);
  const disclaimer = spend.disclaimer ? splitMarkdownLink(spend.disclaimer) : null;

  return (
    <div className="flex flex-col gap-2.5 border-t border-edge pt-4">
      <h2 className="text-base font-semibold text-ink">Extra usage</h2>

      {cap > 0 ? (
        <LimitRow
          label="Credits spent"
          subtitle={`${formatMoney(used, currency)} of ${formatMoney(cap, currency)}`}
          bucket={{ utilization: pct, resets_at: null }}
          severity={spend.severity}
        />
      ) : (
        <div className="text-sm text-muted">
          {`${formatMoney(used, currency)} spent · no spend limit set`}
        </div>
      )}

      {spend.limitReached && (
        <div className="text-sm text-[#f0b3a8]">
          Spend limit reached — extra usage is paused.
        </div>
      )}
      {spend.disabledReason && (
        <div className="text-sm text-muted">{spend.disabledReason}</div>
      )}
      {!spend.canPurchase && !spend.disabledReason && (
        <div className="text-sm text-muted">
          Buying more credits isn&apos;t available on this account.
        </div>
      )}

      {disclaimer && (
        <div className="text-sm text-muted">
          {disclaimer.before}
          <a
            href={disclaimer.href}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-ink"
          >
            {disclaimer.text}
          </a>
          {disclaimer.after}
        </div>
      )}
    </div>
  );
}

function StatusLine({
  status,
  fetchedAt,
}: {
  status: StatusInfo | null;
  fetchedAt: string;
}) {
  if (!status) return null;
  const color =
    status.indicator === "none"
      ? "var(--ok)"
      : status.indicator === "minor" || status.indicator === "maintenance"
        ? "var(--warn)"
        : "var(--bad)";
  return (
    <div className="border-t border-edge pt-4">
      <h2 className="mb-2 text-base font-semibold text-ink">Service status</h2>
      <a
        href={STATUS_PAGE_URL}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center gap-2"
        title="Open status.claude.com"
      >
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm text-ink group-hover:underline">
          {status.description}
        </span>
        <span className="ml-auto text-xs text-faint opacity-0 transition group-hover:opacity-100">
          status.claude.com ↗
        </span>
      </a>
      <div className="mt-1 pl-[18px] text-xs text-faint">
        Tracks claude.ai, Claude Console, Claude API, Claude Code · checked{" "}
        {formatRelative(fetchedAt)}
      </div>
    </div>
  );
}

// Live, client-side sanity checks on the pasted cookie so the user gets instant
// ✓/✗ feedback and knows they grabbed the right (whole) thing.
function inspectCookie(raw: string) {
  const v = raw.trim();
  return {
    empty: v.length === 0,
    hasSessionKey: /sessionKey=sk-ant-sid/i.test(v),
    hasClearance: /cf_clearance=/i.test(v),
    length: v.length,
    looksLong: v.length >= 200,
  };
}

function CheckItem({ state, children }: { state: "ok" | "warn" | "bad"; children: ReactNode }) {
  const color =
    state === "ok" ? "var(--ok)" : state === "warn" ? "var(--warn)" : "var(--bad)";
  const mark = state === "ok" ? "✓" : state === "warn" ? "!" : "✕";
  return (
    <li className="flex items-start gap-2">
      <span style={{ color }} className="font-bold leading-5">
        {mark}
      </span>
      <span className={state === "ok" ? "text-muted" : "text-ink"}>{children}</span>
    </li>
  );
}

function CookieSetup({
  draft,
  setDraft,
  uaDraft,
  setUaDraft,
  onSave,
  onClear,
  hasCookie,
  saving,
}: {
  draft: string;
  setDraft: (v: string) => void;
  uaDraft: string;
  setUaDraft: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
  hasCookie: boolean;
  saving: boolean;
}) {
  const c = inspectCookie(draft);
  const canSave = !saving && c.hasSessionKey;

  return (
    <div className="mt-3 rounded-xl border border-edge bg-panel-2 p-4">
      <h3 className="text-sm font-semibold text-ink">Connect your Claude account</h3>
      <p className="mt-1 text-xs text-muted">
        One-time setup. We read your usage with your own session cookie — copy it
        once and you&rsquo;re done.
      </p>

      <a
        href={CLAUDE_USAGE_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-fill px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
      >
        Open claude.ai usage page ↗
      </a>

      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>
          On that page, open DevTools:{" "}
          <kbd className="rounded bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink">
            ⌘ ⌥ I
          </kbd>{" "}
          <span className="text-faint">(Mac)</span> or{" "}
          <kbd className="rounded bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink">
            F12
          </kbd>{" "}
          <span className="text-faint">(Windows)</span>.
        </li>
        <li>
          Click the <strong className="text-ink">Network</strong> tab, then refresh
          the page.
        </li>
        <li>
          In the list, click the request named{" "}
          <code className="text-ink">usage</code>.
        </li>
        <li>
          Scroll to <strong className="text-ink">Request Headers</strong> and find
          the <code className="text-ink">Cookie</code> row.
        </li>
        <li>
          <strong className="text-ink">Right-click its value → “Copy value”</strong>{" "}
          <span className="text-faint">(this grabs the whole line at once)</span>,
          then paste below.
        </li>
      </ol>

      {/* What good looks like */}
      <div className="mt-3 rounded-lg border border-edge bg-bg p-3 text-xs">
        <p className="text-muted">
          It&rsquo;s <strong className="text-ink">one very long line</strong> (usually
          1,000+ characters) that <strong className="text-ink">starts with</strong>{" "}
          <code className="text-ink">anthropic-device-id=</code> and must also contain{" "}
          <code className="text-ink">sessionKey=sk-ant-sid…</code> and{" "}
          <code className="text-ink">cf_clearance=…</code>:
        </p>
        <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-faint">
          <span className="text-ink">anthropic-device-id=</span>…;{" "}
          <span className="text-ink">sessionKey=sk-ant-sid</span>…;{" "}
          <span className="text-ink">cf_clearance=</span>…
        </p>
        <p className="mt-1.5 text-faint">
          Don&rsquo;t copy just part of it — paste the entire long line.
        </p>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder="Paste the full Cookie line here — anthropic-device-id=…; sessionKey=sk-ant-sid…; cf_clearance=…"
        className="mt-3 h-24 w-full resize-none rounded-lg border border-edge bg-bg p-3 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-fill"
      />

      {/* Live validation */}
      {!c.empty && (
        <ul className="mt-2 space-y-1 text-xs">
          <CheckItem state={c.hasSessionKey ? "ok" : "bad"}>
            {c.hasSessionKey
              ? "Session key found (sk-ant-sid…)"
              : "No sessionKey yet — you haven’t copied the whole line"}
          </CheckItem>
          <CheckItem state={c.hasClearance ? "ok" : "warn"}>
            {c.hasClearance
              ? "Cloudflare token found (cf_clearance)"
              : "No cf_clearance — claude.ai may block this with a 403"}
          </CheckItem>
          <CheckItem state={c.looksLong ? "ok" : "warn"}>
            {c.looksLong
              ? `Looks complete (${c.length} characters)`
              : `Only ${c.length} characters — the real cookie is much longer`}
          </CheckItem>
        </ul>
      )}

      <label className="mt-3 block text-xs font-medium text-muted">
        Browser User-Agent
        <span className="ml-1 font-normal text-faint">
          — pre-filled. Only change it if you get a 403: right under{" "}
          <code>Cookie</code>, copy the <code>User-Agent</code> row from the same
          request (it must be the same browser).
        </span>
      </label>
      <input
        value={uaDraft}
        onChange={(e) => setUaDraft(e.target.value)}
        spellCheck={false}
        placeholder="Mozilla/5.0 (Macintosh; …) Chrome/… Safari/537.36"
        className="mt-1.5 w-full rounded-lg border border-edge bg-bg p-2.5 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-fill"
      />

      <div className="mt-3 flex gap-2">
        <button
          onClick={onSave}
          disabled={!canSave}
          title={c.hasSessionKey ? undefined : "Paste the full Cookie line first"}
          className="rounded-lg bg-fill px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
        >
          {saving ? "Fetching…" : "Save & fetch usage"}
        </button>
        <button
          onClick={onClear}
          disabled={!hasCookie && !draft}
          className="rounded-lg border border-edge px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-panel hover:text-ink disabled:opacity-50"
        >
          Clear cookie
        </button>
      </div>

      <p className="mt-3 text-xs text-faint">
        🔒 Your cookie stays in this app only and is sent straight to claude.ai to
        read your usage — never stored on any server.
      </p>
    </div>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? "animate-spin" : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
