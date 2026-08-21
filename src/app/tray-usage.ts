"use client";

/**
 * The macOS menu-bar readout, shared by both provider panels.
 *
 * Both percentages are drawn side by side and labelled, because a single number
 * next to Claude's ✳ was actively misleading: the glyph said "Claude" while the
 * number could be ChatGPT's. macOS can't color tray *text*, so the whole readout
 * is rendered to a canvas and handed over as the tray image — that's the only
 * way each provider's number gets its own tint.
 *
 * Module-level state is fine: both panels live in the same client bundle.
 */

export type TrayPayload = {
  iconDataURL?: string;
  /** Logical width in points for the 18pt-tall tray image. */
  iconWidth?: number;
  /** Text fallback, used only when the canvas is unavailable. */
  title: string;
  tooltip: string;
};

declare global {
  interface Window {
    // Present only inside the Electron menu-bar shell (see electron/preload.js).
    electronAPI?: {
      setUsage: (payload: TrayPayload) => void;
      /** Absent in a plain browser — that's the signal to fall back to paste. */
      claudeSignIn?: () => Promise<SignInResult>;
      claudeSessionStatus?: () => Promise<{ signedIn: boolean }>;
    };
  }
}

/**
 * Result of signing in to claude.ai inside the app. No cookie comes back — the
 * session stays in the shell's jar and every call goes through its Chromium
 * bridge, so there's nothing for the renderer to hold.
 */
export type SignInResult =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "timeout" | "in-progress" };

export type UsageSource = "claude" | "openai";

/** Short label per provider. Kept to one character so both fit the menu bar. */
const LABELS: Record<UsageSource, string> = { claude: "C", openai: "G" };
const ORDER: UsageSource[] = ["claude", "openai"];
const NAMES: Record<UsageSource, string> = { claude: "Claude", openai: "ChatGPT" };

const reported: Partial<Record<UsageSource, number>> = {};

/** Last readout pushed to the shell, so unchanged reports don't repaint. */
let lastSent: string | null = null;

// Danger tint, matching the in-app status colors.
function dangerColor(pct: number): string {
  if (pct >= 85) return "#e8654f"; // red
  if (pct >= 60) return "#f0b03a"; // amber
  return "#43c478"; // green
}

const SCALE = 2; // the tray image is the @2x rep of an 18pt-tall icon
const HEIGHT_PT = 18;
const FONT = `600 ${11 * SCALE}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`;
const GAP = 7 * SCALE; // space between the two providers
const PAD = 2 * SCALE;

type Segment = { text: string; color: string };

/**
 * Render the labelled segments to a PNG data URL. Width is measured from the
 * text, so the menu-bar item is only as wide as it needs to be.
 */
function drawReadout(segments: Segment[]): { dataURL?: string; width: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { dataURL: undefined, width: 0 };

  ctx.font = FONT;
  const widths = segments.map((s) => ctx.measureText(s.text).width);
  const total =
    PAD * 2 + widths.reduce((a, b) => a + b, 0) + GAP * Math.max(0, segments.length - 1);

  canvas.width = Math.ceil(total);
  canvas.height = HEIGHT_PT * SCALE;

  // Resizing the canvas resets the context, so re-apply the text state.
  ctx.font = FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  let x = PAD;
  segments.forEach((s, i) => {
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, x, canvas.height / 2 + 1);
    x += widths[i] + GAP;
  });

  return { dataURL: canvas.toDataURL("image/png"), width: Math.ceil(canvas.width / SCALE) };
}

type Listener = (reported: Partial<Record<UsageSource, number>>) => void;
const listeners = new Set<Listener>();

/**
 * Watch the reported percentages. The tab bar uses this to badge both providers
 * at once, so switching tabs isn't needed just to see where you stand.
 */
export function subscribeUsage(fn: Listener): () => void {
  listeners.add(fn);
  fn({ ...reported });
  return () => listeners.delete(fn);
}

/** Providers that have reported, in a stable order. */
function knownSources(): UsageSource[] {
  return ORDER.filter((s) => typeof reported[s] === "number");
}

/** Record one provider's headline % and repaint the menu bar with both. */
export function reportUsage(source: UsageSource, pct: number) {
  reported[source] = pct;
  for (const fn of listeners) fn({ ...reported });
  if (!window.electronAPI) return;

  const sources = knownSources();
  if (sources.length === 0) return;

  // The shell rounds for display, so compare on rounded values — otherwise
  // 41.4 → 41.6 counts as a change and repaints for nothing.
  const segments: Segment[] = sources.map((s) => {
    const rounded = Math.round(reported[s] as number);
    return { text: `${LABELS[s]} ${rounded}%`, color: dangerColor(rounded) };
  });

  const key = segments.map((s) => `${s.text}:${s.color}`).join("|");
  if (key === lastSent) return;
  lastSent = key;

  const { dataURL, width } = drawReadout(segments);
  window.electronAPI.setUsage({
    iconDataURL: dataURL,
    iconWidth: width,
    title: segments.map((s) => s.text).join("  "),
    tooltip: sources
      .map((s) => `${NAMES[s]} ${Math.round(reported[s] as number)}%`)
      .join(" · "),
  });
}
