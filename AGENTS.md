<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Claudometer — notes for the next agent

A macOS **menu-bar app** showing Claude usage limits the same way claude.ai's
*Settings → Usage* screen does, plus live service status. **Next.js UI + Electron
shell.** Repo: `github.com/ananmouaz/claudometer` (public; the user's personal
`ananmouaz` GitHub account — it's their only public repo).

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

- **Cloudflare is the whole ballgame.** claude.ai sits behind Cloudflare. A plain
  server fetch gets a `403 "Just a moment…"`. It works only because we forward the
  user's `cf_clearance` cookie **and the exact User-Agent that earned it** (CF binds
  clearance to IP + UA). The browser sends `navigator.userAgent`; Electron sends a
  cleaned Chrome UA (strips the `Electron/…` token in `electron/main.js`) plus an
  editable UA field. **Don't hardcode/normalize the UA away** or it 403s.
- **The cookie is sensitive.** It lives only in the browser/app `localStorage`
  (keys `claude_usage_cookie`, `claude_usage_ua`) and is sent to our local proxy
  purely to relay to claude.ai. **Never persist it server-side, log it, or add
  telemetry.** Keep the privacy promise in the README true.
- **Proxy route**: `src/app/api/usage/route.ts`. Flow: `GET /api/organizations`
  → fetch `/organizations/{id}/usage` for **every** org in parallel →
  **auto-select the most active org** (live reset window + highest utilization).
  The user may have multiple orgs; picking the first is wrong (an empty personal
  org reads 0%). UI exposes an org switcher when >1.
- **Usage buckets**: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
  each `{ utilization (0–100), resets_at }`.
- **Service status**: from `status.claude.com/api/v2/summary.json`. Color comes from
  the **incident's `impact`** or the worst **component status** — NOT the page
  rollup (the rollup can read "none/green" during a minor incident). The circle dot
  is only in the status section.
- **Menu-bar glyph** is a `✳` drawn on a canvas in the renderer, tinted by danger
  (green <60% / amber <85% / red ≥85%), sent to main via IPC and set as the tray
  image (macOS can't color tray *text*). Keep it dynamic; don't swap for the static
  app logo.

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
