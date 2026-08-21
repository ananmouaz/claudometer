"use client";

import { useEffect, useState } from "react";
import { ChatGptPanel } from "./chatgpt-panel";
import { UsagePanel } from "./usage-panel";
import { subscribeUsage, type UsageSource } from "./tray-usage";

const APP_NAME = "Claudometer";

const TABS: { id: UsageSource; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "openai", label: "ChatGPT" },
];

export function Shell() {
  const [active, setActive] = useState<UsageSource>("claude");
  const [pcts, setPcts] = useState<Partial<Record<UsageSource, number>>>({});

  useEffect(() => subscribeUsage(setPcts), []);

  return (
    <div className="w-full max-w-xl rounded-2xl border border-edge bg-panel shadow-2xl shadow-black/40">
      <div className="flex flex-col gap-5 p-7 pb-0">
        {/* App brand bar — shared by both tabs. */}
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" className="h-7 w-7 rounded-[7px]" />
          <span className="text-base font-semibold tracking-tight text-ink">
            {APP_NAME}
          </span>
        </div>

        <div className="flex gap-1 border-b border-edge" role="tablist">
          {TABS.map((tab) => (
            <Tab
              key={tab.id}
              label={tab.label}
              pct={pcts[tab.id]}
              selected={active === tab.id}
              onSelect={() => setActive(tab.id)}
            />
          ))}
        </div>
      </div>

      {/*
        Both panels stay mounted and only visibility changes. Unmounting the
        inactive one would kill its 60s refresh, and the menu-bar glyph shows the
        worse of the two — it has to keep hearing from both.
      */}
      <div hidden={active !== "claude"}>
        <UsagePanel />
      </div>
      <div hidden={active !== "openai"}>
        <ChatGptPanel />
      </div>
    </div>
  );
}

/** Tab with a live percentage badge, tinted the same way the tray glyph is. */
function Tab({
  label,
  pct,
  selected,
  onSelect,
}: {
  label: string;
  pct: number | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const color =
    pct === undefined
      ? "var(--faint)"
      : pct >= 85
        ? "var(--bad)"
        : pct >= 60
          ? "var(--warn)"
          : "var(--ok)";
  return (
    <button
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`-mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition ${
        selected
          ? "border-fill text-ink"
          : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {label}
      {pct !== undefined && (
        <span className="text-xs tabular-nums" style={{ color }}>
          {Math.round(pct)}%
        </span>
      )}
    </button>
  );
}
