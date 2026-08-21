<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Claudometer — notes for the next agent

A macOS **menu-bar app** showing Claude usage limits the same way claude.ai's
*Settings → Usage* screen does, plus live service status. **Next.js UI + Electron
shell.** Repo: `github.com/ananmouaz/claudometer` (public; the user's personal
`ananmouaz` GitHub account — it's their only public repo).

Two providers now: a Claude tab (`src/app/usage-panel.tsx`) and a ChatGPT tab
(`src/app/chatgpt-panel.tsx`), each with its own proxy route and normalizer,
inside a tabbed shell (`src/app/shell.tsx`) that owns the card frame, brand bar
and tab strip. They're deliberately independent — one failing or unconfigured
must not blank the other.

- **Both panels stay mounted**; the shell only toggles `hidden`. Conditionally
  rendering would kill the inactive panel's 60s refresh, and the menu bar shows
  both providers — it has to keep hearing from both.
- Tab badges come from `subscribeUsage()` in `tray-usage.ts`, the same store that
  feeds the tray. Don't add a second source of truth for those numbers.

## Run / build / release

```bash
npm run dev      # Next dev server at http://localhost:3000 (browser preview)
npm run dist     # build Claudometer.app (host arch) → ./release
npm run pack:all # build arm64 + x64 DMGs (no publish)
npm run release  # build both arches + create/update the v<version> GitHub release
```

- Bump `version` in `package.json`, then `npm run release` (reads version, tags
  `v<version>`, infers repo from git remote, attaches both DMGs).
- Local Electron preview against the dev server: `npm run app:dev` (needs `npm run dev`
  running). `npm run app` builds then runs the packaged-style server.
- Ports: **dev = 3000**, the **packaged standalone server = 41247**.
- Builds are **unsigned** (no Apple Developer cert). Gatekeeper needs right-click→Open.
- Apple Silicon machine: the x64 build is testable via Rosetta, not real Intel hardware.

## Architecture & non-obvious gotchas — read before changing

- **Cloudflare killed the cookie-forwarding design; don't try to revive it.**
  claude.ai sits behind Cloudflare, and it now blocks requests from Node's HTTP
  stack on **client fingerprint** (TLS/JA3 + HTTP2), not on headers. Measured:
  the same request with a *fresh, valid* `cf_clearance` and the exact matching UA
  returns the `403 "Just a moment…"` challenge page from Node `fetch`, while
  Chromium reaches the API. Adding client hints, `Origin`, `sec-fetch-*` or
  `Referer` changes nothing — all four variants 403. **A cookie cannot fix this.**
  If you see that challenge page, the fix is never "get a better cookie".
- **So claude.ai calls go through Chromium** — `electron/claude-bridge.js` keeps a
  hidden window parked on the claude.ai origin and runs the API calls inside it as
  same-origin `fetch()`, which carries the real session, client hints and
  fingerprint. It exposes them over a loopback HTTP server that is
  **127.0.0.1-only, requires a per-run bearer token, and refuses any path not
  under `/api/`** — don't loosen any of those three; it would be an open relay to
  the user's account. Coordinates are handed to the Next server by env
  (`CLAUDE_BRIDGE_PORT`/`_TOKEN`/`_FILE`) *and* written to `bridge.json` (mode
  0600) in `app.getPath("userData")`, because `npm run app:dev` attaches to an
  external `next dev` that never sees our env.
  - `userData` is `claude-usage` in **both** dev and packaged builds: Electron
    takes it from the package.json `name`, and `productName` lives under the
    `build` key where `app.getName()` never sees it. Verified against a real DMG.
    `src/lib/claude-transport.ts` also checks a `Claudometer` path in case
    `productName` is ever hoisted to the top level — harmless either way.
- **Sign-in success must be proven by an API 200, never by a cookie.** claude.ai
  sets a `sessionKey` cookie *partway through* the login flow, so treating its
  presence as success stores a session that answers
  `403 account_session_invalid`. `claude-sign-in` polls `bridge.isSignedIn()`
  (a real `/api/organizations` call) and only then closes the window.
- **The pasted cookie is now fallback-only**, for the plain-browser build where
  there's no Chromium session to borrow — and Cloudflare will usually block it, so
  don't treat a 403 there as a bug. `UsagePayload.via` says which transport ran
  (`"bridge"` | `"cookie"`) and the UI/error copy branches on it: a bridge failure
  means "sign in again", a cookie 403 means "use the menu-bar app". Keys
  `claude_usage_cookie` / `claude_usage_ua` still exist for that path only.
  **Never persist a cookie server-side, log it, or add telemetry.**
- **Proxy route**: `src/app/api/usage/route.ts`, transport-agnostic — it calls
  `claudeTransport()` and is otherwise unchanged. Flow: `GET /api/organizations`
  → fetch `/organizations/{id}/usage` for **every** org in parallel →
  **auto-select the most active org** (live reset window + highest utilization).
  The user may have multiple orgs; picking the first is wrong (an empty personal
  org reads 0%). UI exposes an org switcher when >1.
- **Usage buckets**: read them through `src/lib/usage.ts`, never off the raw JSON.
  The endpoint's authoritative source is now the **`limits` array** — entries of
  `{ kind, group, percent, severity, resets_at, scope, is_active }` with
  `kind` ∈ `session` / `weekly_all` / `weekly_scoped`. Per-model limits only appear
  as `weekly_scoped` + `scope.model.display_name` (e.g. `"Fable"`), and the legacy
  top-level `seven_day_opus` / `seven_day_sonnet` keys now come back **`null` even
  when that model's limit is at 100%** — don't render from them. The old
  `five_hour` / `seven_day` `{ utilization, resets_at }` buckets still populate and
  serve as the fallback when a response has no `limits`. Responses also carry
  unrelated null keys (`tangelo`, `seven_day_omelette`, …) — don't pattern-match
  bucket names.
- **Bar color comes from the API's `severity`**, not our own thresholds; the
  60/85 percentage rule is only the fallback for responses with no `limits`.
  `is_active` marks the limit currently binding the account — that's what drives
  the red "You've hit your X limit" banner. Don't reintroduce hardcoded tiers.
- **Extra usage / credits**: `spend` (money in minor units — `amount_minor /
  10**exponent`) plus the older `extra_usage` block. `spendView()` returns null
  for accounts that never enabled credits so subscriptions don't get an empty
  section. `extra_usage.daily` / `.weekly` are typed `unknown` — only ever seen
  null, so don't render them until the shape is confirmed.
- **Service status**: from `status.claude.com/api/v2/summary.json`. Color comes from
  the **incident's `impact`** or the worst **component status** — NOT the page
  rollup (the rollup can read "none/green" during a minor incident). The circle dot
  is only in the status section.
- **Menu-bar readout** is `C 42%  G 100%` — *both* providers, each tinted by its
  own danger level (green <60% / amber <85% / red ≥85%). The whole string is
  drawn to a canvas in `src/app/tray-usage.ts` and sent to main as a PNG, because
  **macOS can't color tray text** — an image is the only way to tint the two
  numbers differently. Main sets it via `addRepresentation({scaleFactor: 2,
  width, height: 18})`, so the renderer must send `iconWidth` (measured from the
  text) or the icon is squashed. The tray *title* is only a fallback for when the
  canvas is unavailable; don't render numbers in both.
  - It used to be a single `✳` plus the worst of the two percentages. That was
    removed as actively misleading: the glyph read "Claude" while the number
    could be ChatGPT's. **Don't reintroduce a single shared number.**
  - Providers appear only once they've reported, in a fixed order, so a
    disconnected account leaves a gap rather than showing a fake 0%.
  - Claude reports its **session** %, ChatGPT its **worst** window. Asymmetric on
    purpose — session is the number people watch on Claude — but if you unify
    them, unify both labels too.

## ChatGPT side — different rules, don't copy the Claude assumptions

- **No Cloudflare.** `GET https://chatgpt.com/backend-api/wham/usage` needs only
  `Authorization: Bearer <token>` (+ `chatgpt-account-id` for workspace tokens).
  No `cf_clearance`, no UA pinning. Don't add the UA dance here.
- **No cookie paste.** `src/app/api/openai/route.ts` reads the token the Codex CLI
  stores in `$CODEX_HOME/auth.json` / `~/.codex/auth.json` (`tokens.access_token`,
  `tokens.account_id`) **server-side** — the local Next server has fs access in
  both dev and packaged. A pasted token overrides it. There's no refresh flow: on
  401 we tell the user to run any `codex` command, which refreshes it for us.
- **The route strips identity.** The response carries `user_id` / `account_id` /
  `email`; `pick()` forwards only the render keys. Keep it that way.
- **Never label `primary_window` as the 5-hour one.** Which window lands there is
  plan-dependent — a `team` account puts the *weekly* window in `primary_window`
  and returns `secondary_window: null`. Label off `limit_window_seconds`
  (18000 = 5-hour, 604800 = weekly), which is what `openai-usage.ts` does.
- **This quota is not "ChatGPT usage".** OpenAI's own wording: shared across
  Codex, Work, Workspace Agents and ChatGPT for Excel, *excluding* Chat
  conversations. There is no endpoint for chat message limits — don't imply one.
- **The UI reports `% remaining`**, not % used, because chatgpt.com's screen does.
  The bar still fills with what's consumed. One deliberate deviation: the fill
  uses our green/amber/red thresholds instead of OpenAI's always-blue bar, since
  OpenAI sends no per-limit severity and a red bar matches the rest of the app.
- **Banner copy is client-side.** `rate_limit_upsell.title` is a marketing
  headline ("Get 500 credits"), *not* the banner. The real banner keys on
  `rate_limit_reached_type.type` — see `reachedBanner()`. Upsell CTAs
  ("Notify owner", referrals) are intentionally not rendered: read-only app.
- **Unconfirmed shapes**: `additional_rate_limits` (per-model, e.g. Codex Spark)
  is null on every account seen, so `extraRows()` reads the name tolerantly and
  drops entries it can't name. `spend_control` amounts are decimal *strings* with
  no currency field anywhere — unit genuinely unknown, and chatgpt.com doesn't
  render it either, so neither do we. Don't guess dollars.
- `rate_limit_reset_credits` comes inline, so we never call
  `/backend-api/wham/rate-limit-reset-credits` — it returns the same counts.
- **Statuspage reader is shared**: `src/lib/status.ts`, parameterised by URL.
  Anthropic and OpenAI publish the identical schema. Same rule as before — color
  from incident `impact` / worst component, never the page rollup.

## Packaging specifics (fragile, don't regress)

- `next.config.ts` sets `output: "standalone"`; `prepare:standalone` copies
  `.next/static` + `public` into the bundle.
- Electron runs the standalone `server.js` with its own Node
  (`ELECTRON_RUN_AS_NODE`) when `app.isPackaged`.
- **`electron/after-pack.js` copies the standalone `node_modules` into the app** —
  electron-builder skips `node_modules` inside `extraResources`, which caused a
  `Cannot find module 'next'` crash. Don't remove it.
- `sharp` in the bundle is host-arch but never loaded (UI uses a plain `<img>`,
  not `next/image`), so the x64 build still boots.

## Conventions

- Forced **dark theme**, Claude's clay/cream palette; tokens in `src/app/globals.css`.
- ESLint (flat config) ignores `electron/`, `scripts/`, `release/`, `build/`.
  Two rules bite: no `setState` synchronously in an effect body (wrap in a nested
  async fn or a follow-up effect), and no writing refs during render.
- Always run `npx tsc --noEmit` + `npm run lint` before building.
- Not affiliated with Anthropic; MIT licensed. Keep the README disclaimer.
