"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "design-vault:theme";

const OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: "light", label: "亮色", icon: Sun },
  { value: "dark", label: "暗色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

function readStored(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    /* ignore */
  }
  return "system";
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("design-vault:theme-change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("design-vault:theme-change", callback);
  };
}

function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
}

export function ThemeToggle() {
  // Server snapshot is always "system" so SSR markup matches the bootstrap script's
  // initial state. Client snapshot reads localStorage and re-subscribes to changes.
  const mode = useSyncExternalStore<ThemeMode>(
    subscribe,
    readStored,
    () => "system",
  );

  function update(next: ThemeMode) {
    applyTheme(next);
    try {
      if (next === "system") {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("design-vault:theme-change"));
  }

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 panel-shadow"
      role="radiogroup"
      aria-label="主题模式"
    >
      {OPTIONS.map((option) => {
        const active = mode === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            aria-checked={active}
            aria-label={option.label}
            className={`flex h-7 w-7 items-center justify-center rounded transition ${
              active
                ? "bg-accent text-white shadow-[var(--shadow-xs)]"
                : "text-muted hover:bg-surface-muted hover:text-foreground"
            }`}
            role="radio"
            title={option.label}
            type="button"
            onClick={() => update(option.value)}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
