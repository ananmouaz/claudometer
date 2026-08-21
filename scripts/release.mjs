#!/usr/bin/env node
// One-command release: build arm64 + x64 DMGs and publish (or update) the
// matching GitHub release with both attached.
//
//   npm run release          # builds + releases v<package.json version>
//
// The tag is v<version>; bump "version" in package.json for a new release.
// Requires: gh CLI authenticated, run from inside the repo (origin remote).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });
const shOut = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const { version } = pkg;
const tag = `v${version}`;
const armDmg = `release/Claudometer-${version}-arm64.dmg`;
const x64Dmg = `release/Claudometer-${version}-x64.dmg`;

console.log(`\n▶ Building Claudometer ${tag} (arm64 + x64)…\n`);
sh("npm run pack:all");

for (const f of [armDmg, x64Dmg]) {
  if (!existsSync(f)) {
    console.error(`\n✗ Expected artifact missing: ${f}\n  (build may have failed)`);
    process.exit(1);
  }
}

const notes = `Claudometer ${version} — your **Claude and ChatGPT** usage limits in the macOS menu bar, each shown exactly the way its own settings screen shows them, with live service status for both.

The menu bar reads \`C 4%  G 100%\` — both accounts at a glance, each number coloured on its own (green → amber → red as you approach the cap).

### Download
- **Apple Silicon** (M-series Macs): \`Claudometer-${version}-arm64.dmg\`
- **Intel** Macs: \`Claudometer-${version}-x64.dmg\`

### Install
1. Download the DMG for your Mac, open it, and drag **Claudometer** to **Applications**.
2. It lives in your menu bar (no dock icon). Click it, then **Sign in to Claude** — you log in to claude.ai once inside the app and that's it. Nothing to copy or paste.
3. The **ChatGPT** tab needs no setup at all if you use the [Codex CLI](https://github.com/openai/codex) — it reuses the login Codex already keeps on your machine. Otherwise you can paste an access token.

### First launch (unsigned build)
This build isn't code-signed, so macOS blocks the first launch (*"Apple could not verify…"*). Open it one of two ways:
- **System Settings → Privacy & Security → "Open Anyway"** (it appears right after you try to open the app), then reopen it — or
- run once in Terminal: \`xattr -dr com.apple.quarantine "/Applications/Claudometer.app"\`

*(On macOS 14 and earlier you could right-click → Open; that no longer works on macOS 15+.)*

### What ChatGPT's usage number covers
OpenAI shares that quota across Codex, Work, Workspace Agents and ChatGPT for Excel. It does **not** include plain Chat conversations — OpenAI publishes no usage figures for those, so no app can show them.

### Notes
- Not sure which Mac you have? Apple menu → About This Mac. "Apple M…" = Apple Silicon; "Intel" = Intel.
- Your logins stay on your machine. Your Claude session lives in the app's own cookie jar and is used only to read your usage from claude.ai; the ChatGPT token is read from the Codex CLI's local file and sent only to chatgpt.com. No backend, no accounts, no telemetry.
`;

const notesFile = "release/RELEASE_NOTES.md";
writeFileSync(notesFile, notes);

// Does this release already exist? If so update assets + notes; else create.
let exists = false;
try {
  shOut(`gh release view ${tag}`);
  exists = true;
} catch {
  exists = false;
}

if (exists) {
  console.log(`\n▶ Release ${tag} exists — updating assets + notes…\n`);
  sh(`gh release upload ${tag} "${armDmg}" "${x64Dmg}" --clobber`);
  sh(`gh release edit ${tag} --notes-file ${notesFile} --title "Claudometer ${version}"`);
} else {
  console.log(`\n▶ Creating release ${tag}…\n`);
  sh(
    `gh release create ${tag} "${armDmg}" "${x64Dmg}" --title "Claudometer ${version}" --notes-file ${notesFile}`,
  );
}

console.log(`\n✓ Done: ${shOut(`gh release view ${tag} --json url --jq .url`)}\n`);
