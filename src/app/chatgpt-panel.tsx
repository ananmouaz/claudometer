"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenAIPayload } from "@/lib/openai-types";
import type { StatusInfo } from "@/lib/types";
import {
  headlineUsedPercent,
  reachedBanner,
  resetCredits,
  usageRows,
  type OpenAIRow,
} from "@/lib/openai-usage";
import { clampPct, formatRelative, formatUnixReset } from "@/lib/format";
import { reportUsage } from "./tray-usage";

const TOKEN_KEY = "openai_usage_token";
const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
const STATUS_PAGE_URL = "https://status.openai.com";

/**
 * OpenAI's own wording on the Usage screen. Worth keeping verbatim: it's the
 * only place the user is told this quota excludes plain Chat conversations, and
 * paraphrasing it would over-promise what the app can see.
 */
const SCOPE_NOTE =
  "Usage is shared across Codex, Work, Workspace Agents, and ChatGPT for Excel. It doesn't include Chat conversations.";

export function ChatGptPanel() {
  const [data, setData] = useState<OpenAIPayload | null>(null);
  // Starts true: the first fetch is fired from an effect on mount, so the very
  // first paint would otherwise flash "No usage data yet" before it lands.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [, setTick] = useState(0); // forces relative-time labels to refresh

  const load = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background ?? false;
    setLoading(true);
    if (!background) setError(null);
    // Sent only when the user pasted one; otherwise the route uses the Codex
    // CLI's own local login and nothing leaves this machine but the API call.
    const token = localStorage.getItem(TOKEN_KEY) || undefined;

    // Same retry shape as the Claude panel: first launch can race the
    // standalone server's boot, and the popover briefly loses localhost on
    // sleep/wake. An HTTP error is a real answer — don't retry that.
    const MAX_TRIES = 3;
    try {
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        try {
          const res = await fetch("/api/openai", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          });
          const body = await res.json();
          if (!res.ok) {
            setError(body?.error ?? "Something went wrong.");
            if (body?.auth) setShowSetup(true);
            return;
          }
          const payload = body as OpenAIPayload;
          setData(payload);
          setError(null);
          reportUsage("openai", clampPct(headlineUsedPercent(payload.usage)));
          return;
        } catch {
          if (attempt < MAX_TRIES) {
            await new Promise((r) => setTimeout(r, attempt * 400));
            continue;
          }
          if (!background) setError("Network error — couldn't reach the server.");
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // First fetch. The localStorage read lives in a nested async fn so we're
  // syncing from an external system, not setting state in the effect body.
  useEffect(() => {
    void (async () => {
      setTokenDraft(localStorage.getItem(TOKEN_KEY) ?? "");
      await load();
    })();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const live = useRef({ loading });
  useEffect(() => {
    live.current = { loading };
  });

  // 60s auto-refresh + refresh on reopen, matching the Claude panel so both
  // halves of the menu-bar glyph stay current while the popover is hidden.
  useEffect(() => {
    const refresh = () => {
      if (!live.current.loading) load({ background: true });
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

  function saveToken() {
    const t = tokenDraft.trim();
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
    setShowSetup(false);
    load();
  }

  const banner = data ? reachedBanner(data.usage) : null;
  const rows = data ? usageRows(data.usage) : [];
  const resets = data ? resetCredits(data.usage) : null;

  // Card frame and brand bar live in the tab shell (see shell.tsx).
  return (
    <div className="flex flex-col gap-6 p-7">
      <>
        {/* Heading */}
        <div className="flex items-center justify-between gap-3 border-b border-edge pb-4">
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-semibold tracking-tight text-ink">
              ChatGPT usage limits
            </h1>
            {data?.plan && <span className="text-sm text-muted">{data.plan}</span>}
          </div>
          <a
            href={CHATGPT_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-faint transition hover:text-ink"
            title="Open ChatGPT's own usage page"
          >
            chatgpt.com ↗
          </a>
        </div>

        {error && (
          <div className="rounded-lg border border-[#5c3631] bg-[#3a221f] px-3.5 py-2.5 text-sm text-[#f0b3a8]">
            {error}
          </div>
        )}

        {data ? (
          <>
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-base font-semibold text-ink">Usage</h2>
                <p className="mt-1 text-sm text-muted">{SCOPE_NOTE}</p>
              </div>

              {banner && (
                <div className="rounded-lg border border-[#5c3631] bg-[#3a221f] px-3.5 py-3 text-sm">
                  <div className="font-semibold text-[#f5c8bf]">{banner.title}</div>
                  <div className="mt-0.5 text-[#f0b3a8]">{banner.body}</div>
                </div>
              )}

              {rows.length > 0 ? (
                rows.map((row) => <RemainingRow key={row.key} row={row} />)
              ) : (
                <div className="text-sm text-muted">
                  No usage limits reported for this account.
                </div>
              )}
            </div>

            <div className="border-t border-edge pt-4">
              <h2 className="text-base font-semibold text-ink">Usage limit resets</h2>
              <p className="mt-2 text-sm text-muted">
                {resets && resets.owned > 0
                  ? `${resets.owned} usage limit reset${resets.owned === 1 ? "" : "s"} available.`
                  : "No usage limit resets available at this time."}
              </p>
              {/* Owned but not applicable is the normal state: a reset can only
                  be spent once a limit is actually reached. */}
              {resets && resets.owned > 0 && resets.applicableNow === 0 && (
                <p className="mt-1 text-sm text-faint">
                  You can use one once you reach a usage limit.
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 text-sm text-muted">
              <span>Last updated: {formatRelative(data.fetchedAt)}</span>
              <button
                onClick={() => load()}
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
          !error && (
            <div className="text-sm text-muted">
              {loading ? "Loading your ChatGPT usage…" : "No usage data yet."}
            </div>
          )
        )}

        <div className="border-t border-edge pt-4">
          <button
            onClick={() => setShowSetup((s) => !s)}
            className="text-sm text-muted transition hover:text-ink"
          >
            {showSetup ? "Hide ChatGPT sign-in" : "ChatGPT sign-in"}
          </button>
          {showSetup && (
            <TokenSetup
              draft={tokenDraft}
              setDraft={setTokenDraft}
              onSave={saveToken}
              saving={loading}
            />
          )}
        </div>
      </>
    </div>
  );
}

/**
 * A limit row in chatgpt.com's own shape: label and **remaining** percentage on
 * one line, a full-width bar under it, then the absolute reset time. The bar
 * still fills with what's been *used*, so it reads "nearly full = nearly out".
 *
 * OpenAI sends no per-limit severity (unlike claude.ai), so the tint here is
 * genuinely ours — the same green/amber/red thresholds the rest of the app
 * falls back to.
 */
function RemainingRow({ row }: { row: OpenAIRow }) {
  const used = clampPct(row.usedPercent);
  const remaining = 100 - used;
  const color = used >= 85 ? "var(--bad)" : used >= 60 ? "var(--warn)" : "var(--fill)";
  const reset = formatUnixReset(row.resetAt);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-medium text-ink">{row.label}</div>
        <div className="shrink-0 text-sm text-muted">{remaining}% remaining</div>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bar">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${used}%`, background: color }}
        />
      </div>
      {reset && <div className="mt-1.5 text-sm text-muted">{reset}</div>}
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
        title="Open status.openai.com"
      >
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm text-ink group-hover:underline">
          {status.description}
        </span>
        <span className="ml-auto text-xs text-faint opacity-0 transition group-hover:opacity-100">
          status.openai.com ↗
        </span>
      </a>
      <div className="mt-1 pl-[18px] text-xs text-faint">
        Tracks ChatGPT, Codex, the OpenAI API · checked {formatRelative(fetchedAt)}
      </div>
    </div>
  );
}

/**
 * Fallback sign-in. Unlike claude.ai there's no Cloudflare cookie to copy and
 * no User-Agent to match — a bearer token is enough — so the happy path needs
 * no setup at all and this panel only exists for people without the Codex CLI.
 */
function TokenSetup({
  draft,
  setDraft,
  onSave,
  saving,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="mt-3 rounded-xl border border-edge bg-panel-2 p-4">
      <h3 className="text-sm font-semibold text-ink">Connect your ChatGPT account</h3>
      <p className="mt-1 text-xs text-muted">
        Nothing to do if you use the Codex CLI — we read the login it already
        stores in <code className="text-ink">~/.codex/auth.json</code>. If that
        errors, run{" "}
        <code className="rounded bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink">
          codex login
        </code>{" "}
        and refresh.
      </p>

      <p className="mt-3 text-xs text-muted">
        No Codex CLI? Paste an access token instead: open{" "}
        <code className="text-ink">chatgpt.com</code>, DevTools →{" "}
        <strong className="text-ink">Network</strong>, click the{" "}
        <code className="text-ink">usage</code> request, and copy the{" "}
        <code className="text-ink">Authorization</code> value.
      </p>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder="eyJhbGciOi… (the Bearer prefix is optional)"
        className="mt-3 h-20 w-full resize-none rounded-lg border border-edge bg-bg p-3 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-fill"
      />

      <div className="mt-3 flex gap-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="rounded-lg bg-fill px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
        >
          {saving ? "Fetching…" : "Save & fetch usage"}
        </button>
        <button
          onClick={() => setDraft("")}
          disabled={!draft}
          className="rounded-lg border border-edge px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-panel hover:text-ink disabled:opacity-50"
        >
          Clear token
        </button>
      </div>

      <p className="mt-3 text-xs text-faint">
        🔒 Your token stays on this machine and is sent straight to chatgpt.com to
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
