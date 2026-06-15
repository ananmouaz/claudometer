"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Bucket, RawUsage, StatusInfo, UsagePayload } from "@/lib/types";
import {
  clampPct,
  formatRelative,
  formatSessionReset,
  formatWeeklyReset,
} from "@/lib/format";

const APP_NAME = "Claudometer";
const STORAGE_KEY = "claude_usage_cookie";
const UA_KEY = "claude_usage_ua";
const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";
const STATUS_PAGE_URL = "https://status.claude.com";

declare global {
  interface Window {
    // Present only inside the Electron menu-bar shell (see electron/preload.js).
    electronAPI?: { setUsage: (pct: number, iconDataURL?: string) => void };
  }
}

// Danger tint for the menu-bar sparkle, matching the in-app status colors.
function dangerColor(pct: number): string {
  if (pct >= 85) return "#e8654f"; // red
  if (pct >= 60) return "#f0b03a"; // amber
  return "#43c478"; // green
}

// Draw the ✳ glyph (text presentation, so it takes our fill color) as a 36px
// PNG = the @2x rep of an 18pt tray icon. No emoji container, fully tinted.
function sparkleIconDataURL(color: string): string | undefined {
  const px = 36;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = color;
  ctx.font = `${Math.round(px * 0.92)}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("✳︎", px / 2, px / 2 + 1);
  return canvas.toDataURL("image/png");
}

function updateTray(sessionPct: number) {
  if (!window.electronAPI) return;
  window.electronAPI.setUsage(sessionPct, sparkleIconDataURL(dangerColor(sessionPct)));
}

type WeeklyRow = { key: keyof RawUsage; label: string; model?: string };

const WEEKLY_ROWS: WeeklyRow[] = [
  { key: "seven_day", label: "All models" },
  { key: "seven_day_opus", label: "Opus only", model: "Opus" },
  { key: "seven_day_sonnet", label: "Sonnet only", model: "Sonnet" },
];

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
              if (body?.auth) setShowSetup(true);
              return;
            }
            const payload = body as UsagePayload;
            setData(payload);
            setError(null);
            setDetail(null);
            // Mirror the session % onto the macOS menu bar (tinted by danger) in Electron.
            updateTray(clampPct(payload.usage.five_hour?.utilization));
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
      setUaDraft(localStorage.getItem(UA_KEY) || navigator.userAgent);
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setCookie(saved);
        setDraft(saved);
        await load(saved);
      } else {
        setShowSetup(true);
      }
    })();
  }, [load]);

  // Keep "Last updated …" / "checked …" labels honest.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Latest values for the auto-refresh timer to read without stale closures.
  const live = useRef({ cookie, orgUuid: data?.org.uuid, loading });
  useEffect(() => {
    live.current = { cookie, orgUuid: data?.org.uuid, loading };
  });

  // Auto-refresh every 60s — even while the popover is hidden, so the menu-bar
  // glyph and % stay current (that's the whole point of a menu-bar meter).
  // Relies on the Electron window disabling backgroundThrottling, otherwise
  // Chromium freezes this timer once the window is hidden. Also refresh the
  // instant the popover is reopened, so it's never stale on open.
  useEffect(() => {
    const refresh = () => {
      const { cookie, orgUuid, loading } = live.current;
      if (cookie && !loading) load(cookie, orgUuid, { background: true });
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

  const session = data?.usage.five_hour ?? null;

  return (
    <div className="w-full max-w-xl rounded-2xl border border-edge bg-panel shadow-2xl shadow-black/40">
      <div className="flex flex-col gap-6 p-7">
        {/* App brand bar */}
        <div className="flex items-center gap-2.5 border-b border-edge pb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" className="h-7 w-7 rounded-[7px]" />
          <span className="text-base font-semibold tracking-tight text-ink">
            {APP_NAME}
          </span>
        </div>

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
              onChange={(e) => cookie && load(cookie, e.target.value)}
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
            <LimitRow
              label="Current session"
              subtitle={formatSessionReset(session?.resets_at ?? null)}
              bucket={session}
            />

            <div className="flex flex-col gap-5">
              <h2 className="text-base font-semibold text-ink">Weekly limits</h2>

              {WEEKLY_ROWS.map((row) => {
                const b = data.usage[row.key];
                if (!b) return null;
                const subtitle =
                  row.model && clampPct(b.utilization) === 0
                    ? `You haven't used ${row.model} yet`
                    : formatWeeklyReset(b.resets_at);
                return (
                  <LimitRow
                    key={row.key}
                    label={row.label}
                    subtitle={subtitle}
                    bucket={b}
                  />
                );
              })}
            </div>

            {/* Last updated + refresh */}
            <div className="flex items-center gap-2 text-sm text-muted">
              <span>Last updated: {formatRelative(data.fetchedAt)}</span>
              <button
                onClick={() => cookie && load(cookie, data.org.uuid)}
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
              : "Paste your claude.ai cookie below to see your usage."}
          </div>
        )}

        {/* Cookie controls */}
        <div className="border-t border-edge pt-4">
          <button
            onClick={() => setShowSetup((s) => !s)}
            className="text-sm text-muted transition hover:text-ink"
          >
            {showSetup ? "Hide cookie" : cookie ? "Show cookie" : "Set up cookie"}
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
    </div>
  );
}

function LimitRow({
  label,
  subtitle,
  bucket,
}: {
  label: string;
  subtitle: string;
  bucket: Bucket | null;
}) {
  const pct = clampPct(bucket?.utilization);
  return (
    <div className="flex items-center gap-4">
      <div className="w-40 shrink-0">
        <div className="text-[15px] font-medium text-ink">{label}</div>
        {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
      </div>
      <div className="flex-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-bar">
          <div
            className="h-full rounded-full bg-fill transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="w-16 shrink-0 text-right text-sm text-muted">{pct}% used</div>
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
