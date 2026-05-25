"use client";

import { AlertTriangle, ChevronDown, Cloud, Cpu, Repeat, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ModelSettingsDialog } from "./ModelSettingsDialog";
import type { ModelRuntimeScan } from "./modelSettingsTypes";

type SummaryKind = "subprocess" | "http-preset" | "byok" | "warn";

type Summary = {
  kind: SummaryKind;
  tag: string;
  main: string;
  sub: string;
  icon: LucideIcon;
};

function compactHost(value: string) {
  if (!value) return "未设置";
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function ModelStatusControl() {
  const [scan, setScan] = useState<ModelRuntimeScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/model-config", { cache: "no-store" });
      if (!response.ok) throw new Error("读取模型配置失败。");
      const next = (await response.json()) as ModelRuntimeScan;
      setScan(next);
    } catch {
      // swallow; the dialog surfaces detailed errors when the user opens it.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const config = scan?.config;
  const installedAgents = scan?.agents.filter((a) => a.available) ?? [];

  // Status pill: visually different per execution mode so the user can tell
  // at a glance whether requests go through a local subprocess, an HTTP
  // preset, or a manually configured BYOK provider.
  const summary: Summary = (() => {
    if (!config) {
      return { kind: "warn", tag: "Model", main: loading ? "加载中…" : "未配置", sub: "", icon: AlertTriangle };
    }

    // Real subprocess execution — spawns the local CLI binary.
    if (config.mode === "local-cli" && config.localCli) {
      const agent = installedAgents.find((a) => a.id === config.localCli?.agentId);
      const cliModel = config.localCli.model;
      return {
        kind: "subprocess",
        tag: "Local CLI",
        main: agent?.name ?? config.localCli.agentId,
        sub: cliModel && cliModel !== "default" ? cliModel : "默认模型",
        icon: Cpu,
      };
    }

    // Legacy HTTP-preset that happens to point at a detected CLI's endpoint.
    const httpMatchedAgent = installedAgents.find((a) => {
      const candidate = scan?.endpointCandidates.find((c) => c.id === `cli-${a.id}`);
      if (!candidate) return false;
      try {
        return new URL(candidate.baseUrl).host === new URL(config.baseUrl || "").host;
      } catch {
        return candidate.baseUrl === config.baseUrl;
      }
    });
    if (httpMatchedAgent) {
      return {
        kind: "http-preset",
        tag: "HTTP",
        main: httpMatchedAgent.name,
        sub: httpMatchedAgent.version ?? "",
        icon: Repeat,
      };
    }

    if (config.configured) {
      return {
        kind: "byok",
        tag: "BYOK",
        main: config.model || "未选择模型",
        sub: compactHost(config.baseUrl),
        icon: Cloud,
      };
    }
    return { kind: "warn", tag: "Model", main: "未配置", sub: "", icon: AlertTriangle };
  })();

  // Each kind gets a distinct outer style; subprocess is the "primary" affordance.
  const kindClass: Record<SummaryKind, string> = {
    subprocess: "border-accent bg-accent-soft text-accent-strong hover:bg-accent-soft/80",
    "http-preset": "border-line bg-surface text-muted hover:border-accent/40 hover:text-foreground",
    byok: "border-line bg-surface text-muted hover:border-accent/40 hover:text-foreground",
    warn: "border-[color:var(--warning)]/40 bg-[color:var(--warning-soft)] text-[color:var(--warning)] hover:border-[color:var(--warning)]",
  };
  const iconClass: Record<SummaryKind, string> = {
    subprocess: "text-accent",
    "http-preset": "text-muted",
    byok: "text-muted",
    warn: "text-[color:var(--warning)]",
  };
  const Icon = summary.icon;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`group inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition ${kindClass[summary.kind]}`}
        title={
          summary.kind === "subprocess"
            ? "本机 CLI 子进程模式（真 Local CLI，免 API key）"
            : summary.kind === "http-preset"
            ? "HTTP 预设模式（按 CLI 品牌选 HTTP 端点）"
            : summary.kind === "byok"
            ? "BYOK 模式（自填 API base URL + key）"
            : "未配置模型"
        }
      >
        <Icon size={12} className={`flex-none ${iconClass[summary.kind]}`} aria-hidden="true" />
        <span className="truncate font-semibold">{summary.tag}</span>
        <span className="opacity-50">·</span>
        <span className="truncate">{summary.main}</span>
        {summary.sub ? (
          <>
            <span className="opacity-50">·</span>
            <span className="truncate font-mono text-[10.5px] opacity-80">{summary.sub}</span>
          </>
        ) : null}
        <Settings size={11} className="ml-1 flex-none opacity-50 group-hover:opacity-80" aria-hidden="true" />
        <ChevronDown size={10} className="flex-none opacity-50" aria-hidden="true" />
      </button>

      <ModelSettingsDialog
        open={open}
        loading={loading}
        scan={scan}
        onClose={() => setOpen(false)}
        onRefresh={refresh}
      />
    </>
  );
}
