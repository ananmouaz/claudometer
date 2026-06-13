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

const notes = `Claudometer ${version} — your Claude usage limits in the macOS menu bar, shown exactly the way claude.ai shows them, with live service status.

### Download
- **Apple Silicon** (M-series Macs): \`Claudometer-${version}-arm64.dmg\`
- **Intel** Macs: \`Claudometer-${version}-x64.dmg\`

### Install
1. Download the DMG for your Mac, open it, and drag **Claudometer** to **Applications**.
2. It lives in your menu bar (no dock icon). Click the icon and follow the one-time setup to paste your claude.ai cookie — the app guides you with live ✓/✗ checks.

### First launch (unsigned build)
This build isn't code-signed, so macOS Gatekeeper warns on first open. Either:
- **Right-click the app → Open → Open**, or
- run \`xattr -cr "/Applications/Claudometer.app"\` once.

### Notes
- Not sure which Mac you have? Apple menu → About This Mac. "Apple M…" = Apple Silicon; "Intel" = Intel.
- Your session cookie stays on your machine and is sent only to claude.ai. No backend, no telemetry.
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
