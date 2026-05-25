"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { IngestPanel } from "./IngestPanel";
import type { IngestMode } from "@/lib/types";

/**
 * Trigger button + right-side drawer that hosts the IngestPanel.
 * Replaces the permanent sidebar — import is a low-frequency action that
 * shouldn't occupy 300px of screen real estate forever.
 */
export function IngestDrawer({
  initialUrl,
  initialMode,
  defaultOpen,
}: {
  initialUrl?: string;
  initialMode?: IngestMode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_0_rgba(180,90,59,0.22),var(--shadow-xs)] transition hover:bg-accent-strong hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_0_rgba(180,90,59,0.3),var(--shadow-sm)] focus-visible:ring-[3px] focus-visible:ring-accent-soft"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Plus size={15} strokeWidth={2.5} className="transition group-hover:rotate-90" aria-hidden="true" />
        新增导入
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-40 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="导入设计系统"
        >
          {/* Scrim — click to close. */}
          <button
            type="button"
            aria-label="关闭抽屉"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/35 backdrop-blur-[2px] transition"
          />

          {/* Panel slides in from the right. */}
          <div className="relative z-10 flex h-full w-full max-w-[440px] flex-col overflow-hidden border-l border-line bg-surface shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <div className="min-w-0">
                <div className="dv-eyebrow text-accent">IMPORT</div>
                <h2 className="font-serif mt-0.5 text-[17px] font-semibold leading-none tracking-[-0.01em] text-foreground">
                  导入<span className="italic text-accent">设计系统</span>
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-surface-muted hover:text-foreground"
                aria-label="关闭"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <IngestPanel initialUrl={initialUrl} initialMode={initialMode} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
