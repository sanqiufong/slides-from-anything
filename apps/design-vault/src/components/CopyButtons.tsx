"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyButtons({ items }: { items: Array<{ label: string; value: string }> }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(item: { label: string; value: string }) {
    await navigator.clipboard.writeText(item.value);
    setCopied(item.label);
    window.setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <button
          key={item.label}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-semibold text-foreground transition hover:border-accent/40 hover:text-accent focus:outline-none focus:ring-4 focus:ring-accent/10"
          type="button"
          onClick={() => copy(item)}
        >
          {copied === item.label ? <Check size={14} className="text-success" aria-hidden="true" /> : <Copy size={14} className="text-muted" aria-hidden="true" />}
          {copied === item.label ? "已复制" : item.label}
        </button>
      ))}
    </div>
  );
}
