"use client";

import { ArrowRight, Check, ChevronDown, Filter, Heart, LayoutGrid, List, Loader2, Package, Plus, Search, Send, Trash2, Upload, UserCircle2, Users, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { ScaledPreviewFrame } from "@/components/ScaledPreviewFrame";
import type { MySubmission, RegistryEntry } from "@/lib/community-client";
import { effectiveDesignTags, normalizeTag, normalizeTags, semanticDesignTags, systemDesignTags } from "@/lib/tags";
import type { DesignMeta, DesignSystemPackageType } from "@/lib/types";

type PublishResult = {
  slug: string;
  title: string;
  bundlePath: string;
  bytes: number;
  version: number;
};

type ToastKind = "success" | "error" | "info";
type ToastEntry = { id: string; kind: ToastKind; text: string };

function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => window.clearTimeout(t));
      map.clear();
    };
  }, []);

  function dismiss(id: string) {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }

  function push(kind: ToastKind, text: string) {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current, { id, kind, text }]);
    const ttl = kind === "error" ? 8000 : 4500;
    const timer = window.setTimeout(() => dismiss(id), ttl);
    timers.current.set(id, timer);
  }

  return { toasts, push, dismiss };
}

function ToastStack({ toasts, onDismiss }: { toasts: ToastEntry[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="dv-toast-stack pointer-events-none fixed left-1/2 top-4 z-[100] flex w-full max-w-xl -translate-x-1/2 flex-col gap-2 px-4"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          className={`dv-toast pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-2 text-xs font-medium shadow-[var(--shadow-md)] backdrop-blur ${
            toast.kind === "success"
              ? "border-[color:var(--success)]/30 bg-[color:var(--success-soft)] text-[color:var(--success)]"
              : toast.kind === "error"
                ? "border-[color:var(--danger)]/30 bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
                : "border-line bg-surface text-foreground"
          }`}
        >
          <span className="flex-1">{toast.text}</span>
          <button
            aria-label="关闭"
            className="-mr-1 rounded p-0.5 opacity-60 transition hover:opacity-100"
            type="button"
            onClick={() => onDismiss(toast.id)}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function submissionBadgeStyle(status: MySubmission["status"]): { color: string; label: string; title?: string } {
  switch (status) {
    case "pending":
      return { color: "warning", label: "审核中" };
    case "approved":
      return { color: "success", label: "已通过" };
    case "rejected":
      return { color: "danger", label: "被拒" };
    case "superseded":
      return { color: "muted", label: "已被新版替代" };
    case "retracted":
      return { color: "muted", label: "已撤回" };
    default:
      return { color: "muted", label: status };
  }
}

function fmtTimestampCst(iso: string): string {
  // Show in CST (UTC+8) using only Date getters — no Intl/locale lookups, so
  // Node.js SSR (whatever its host locale) and the browser produce identical
  // strings and React doesn't flag a hydration mismatch.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${shifted.getUTCFullYear()}/${pad(shifted.getUTCMonth() + 1)}/${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

function SubmissionStatusBadge({ submission }: { submission: MySubmission }) {
  const style = submissionBadgeStyle(submission.status);
  const tooltip =
    submission.status === "rejected" && submission.reviewNotes
      ? `被拒原因：${submission.reviewNotes}`
      : submission.status === "approved" && submission.reviewedAt
        ? `${fmtTimestampCst(submission.reviewedAt)} 通过`
        : `提交于 ${fmtTimestampCst(submission.submittedAt)}`;
  const cls =
    style.color === "success"
      ? "border-[color:var(--success)]/30 bg-[color:var(--success-soft)] text-[color:var(--success)]"
      : style.color === "warning"
        ? "border-[color:var(--warning)]/30 bg-[color:var(--warning-soft)] text-[color:var(--warning)]"
        : style.color === "danger"
          ? "border-[color:var(--danger)]/30 bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
          : "border-line bg-surface-muted text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
      title={tooltip}
    >
      <Send size={9} aria-hidden="true" />
      {style.label}
    </span>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

type ViewMode = "grid" | "compact";
type SourceFilter = "all" | "project" | "canva" | "clone-website" | "url";
type CategoryFilter = "all" | DesignSystemPackageType | "default";
type SortMode = "recent" | "quality" | "title";

const SOURCE_OPTIONS: Array<{ key: SourceFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "project", label: "项目" },
  { key: "url", label: "URL" },
  { key: "clone-website", label: "Clone" },
  { key: "canva", label: "Canva" },
];

const CATEGORY_OPTIONS: Array<{ key: CategoryFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "default", label: "网站风格" },
  { key: "presentation-system", label: "演示系统" },
  { key: "visual-style-system", label: "视觉系统" },
  { key: "component-system", label: "组件系统" },
  { key: "agent-skill-package", label: "Skill 包" },
];

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: "recent", label: "最近更新" },
  { key: "quality", label: "质量分" },
  { key: "title", label: "标题" },
];

const VIEW_OPTIONS: Array<{ key: ViewMode; label: string; icon: LucideIcon }> = [
  { key: "grid", label: "卡片视图", icon: LayoutGrid },
  { key: "compact", label: "紧凑视图", icon: List },
];

function matchesSource(design: DesignMeta, source: SourceFilter) {
  if (source === "all") return true;
  if (source === "project") return design.sourceMode === "design-system-project";
  if (source === "canva") return design.sourceMode === "canva-template" || design.sourceMode === "canva-editor";
  if (source === "clone-website") return design.sourceMode === "clone-website";
  return design.sourceMode === "url";
}

// `default` means "no packageType set" → the implicit 网站风格 bucket that URL imports fall into.
function matchesCategory(design: DesignMeta, category: CategoryFilter) {
  if (category === "all") return true;
  const packageType = design.packageManifest?.packageType;
  if (category === "default") return !packageType;
  return packageType === category;
}

function formatMode(mode: DesignMeta["sourceMode"]) {
  if (mode === "canva-template") return "Canva";
  if (mode === "canva-editor") return "Canva";
  if (mode === "design-system-project") return "Project";
  return mode === "clone-website" ? "Clone" : "URL";
}

function formatPackageType(design: DesignMeta) {
  const packageType = design.packageManifest?.packageType;
  if (packageType === "component-system") return "组件系统";
  if (packageType === "presentation-system") return "演示系统";
  if (packageType === "agent-skill-package") return "Skill 包";
  if (packageType === "visual-style-system") return "视觉系统";
  return "网站风格";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function qualityLabel(design: DesignMeta) {
  const quality = design.profile?.quality;
  if (!quality) return "未评分";
  return `${quality.score}/100`;
}

function qualityClass(design: DesignMeta) {
  const grade = design.profile?.quality?.grade;
  if (grade === "production-9plus") return "bg-[color:var(--success-soft)] text-[color:var(--success)]";
  if (grade === "needs-review") return "bg-[color:var(--warning-soft)] text-[color:var(--warning)]";
  if (grade === "blocked") return "bg-[color:var(--danger-soft)] text-[color:var(--danger)]";
  return "bg-surface-muted text-muted";
}

function getLibraryPalette(design: DesignMeta) {
  const roles = design.profile?.colorRoles;
  if (roles) {
    return [
      { key: "bg", color: roles.background },
      { key: "text", color: roles.text },
      { key: "cta", color: roles.brandPrimary },
      { key: "muted", color: roles.brandSecondary },
    ];
  }

  return [
    { key: "primary", color: design.tokens.colors.primary },
    { key: "secondary", color: design.tokens.colors.secondary },
    { key: "surface", color: design.tokens.colors.surface },
    { key: "text", color: design.tokens.colors.text },
  ];
}

function previewKind(design: DesignMeta) {
  const corpus = [
    design.profile?.previewStrategy?.renderer,
    design.profile?.archetype,
    design.profile?.visualThesis,
    design.title,
    design.sourceHost,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/type-specimen|type foundry|variable font|font specimen|gt mechanik/.test(corpus)) return "type-specimen";
  if (/consumer-wallet|consumer crypto wallet|money app|phantom/.test(corpus)) return "consumer-wallet";
  if (/dark-event|developer conference|ship|vercel/.test(corpus)) return "dark-event";
  if (/immersive|webgl|webgpu|dither|audio reactive|canvas/.test(corpus)) return "immersive";
  return "product";
}

function designAssetUrl(design: DesignMeta) {
  const asset = design.assets.find((item) => item.kind === "image" || item.kind === "svg");
  if (!asset) return "";
  return `/api/designs/${design.slug}/asset/${asset.path.replace(/^assets\//, "")}`;
}

function ProjectMiniPreview({
  compact = false,
  design,
  background,
  text,
  accent,
  muted,
  display,
  body,
  height,
}: {
  compact?: boolean;
  design: DesignMeta;
  background: string;
  text: string;
  accent: string;
  muted: string;
  display: string;
  body: string;
  height: number;
}) {
  const packageType = design.packageManifest?.packageType;
  const capabilities = (design.capabilities ?? []).slice(0, compact ? 2 : 4);
  const label = formatPackageType(design);
  const previewImage = designAssetUrl(design);

  if (previewImage) {
    return (
      <div className="relative overflow-hidden rounded-lg border border-line bg-surface-muted" style={{ height }}>
        <Image alt={`${design.title} demo preview`} className="object-cover" fill sizes={compact ? "180px" : "(min-width: 1536px) 30vw, 50vw"} src={previewImage} unoptimized />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent p-3 text-white">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/75">{label}</div>
              <div className={`${compact ? "text-sm" : "text-lg"} truncate font-semibold leading-tight`} style={{ fontFamily: display }}>
                Demo preview
              </div>
            </div>
            {!compact && capabilities[0] ? <span className="rounded-md bg-white/18 px-2 py-1 text-[10px] font-semibold backdrop-blur">{capabilities[0].id}</span> : null}
          </div>
        </div>
      </div>
    );
  }

  if (packageType === "presentation-system") {
    return (
      <div className="overflow-hidden rounded-lg border border-line p-3" style={{ background, color: text, fontFamily: body, height }}>
        <div className="flex h-full items-center gap-3">
          <div className="relative h-full min-h-0 w-24 flex-none">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="absolute rounded-md border border-line bg-white shadow-sm"
                style={{
                  inset: `${index * 8}px ${18 - index * 7}px ${18 - index * 7}px ${index * 8}px`,
                  background: index === 0 ? accent : index === 1 ? muted : "#ffffff",
                }}
              />
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: accent }}>
              {label}
            </div>
            <div className={`${compact ? "text-base" : "text-xl"} truncate font-semibold leading-tight`} style={{ fontFamily: display }}>
              Deck template
            </div>
            {!compact ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {capabilities.map((capability) => (
                  <span key={capability.id} className="rounded-md border border-line bg-white px-2 py-1 text-[10px] font-semibold text-muted">
                    {capability.id}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (packageType === "agent-skill-package") {
    return (
      <div className="overflow-hidden rounded-lg border border-line p-3" style={{ background, color: text, fontFamily: body, height }}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: accent }}>
              Wrapper skill
            </div>
            <div className={`${compact ? "text-base" : "text-xl"} truncate font-semibold`} style={{ fontFamily: display }}>
              Agent routing
            </div>
          </div>
          <span className="rounded-md px-2 py-1 text-[10px] font-semibold text-white" style={{ background: accent }}>
            SKILL.md
          </span>
        </div>
        <div className={`${compact ? "mt-2" : "mt-4"} grid grid-cols-3 gap-2`}>
          {["rules", "refs", "assets"].map((item) => (
            <div key={item} className="rounded-md border border-line bg-white px-2 py-2 text-center text-[10px] font-semibold text-muted">
              {item}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (packageType === "visual-style-system") {
    return (
      <div className="overflow-hidden rounded-lg border border-line p-3" style={{ background, color: text, fontFamily: body, height }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: accent }}>
              {label}
            </div>
            <div className={`${compact ? "text-base" : "text-xl"} truncate font-semibold`} style={{ fontFamily: display }}>
              Visual language
            </div>
          </div>
          <span className="h-8 w-8 rounded-md border border-line" style={{ background: accent }} />
        </div>
        {!compact ? (
          <div className="mt-4 grid grid-cols-4 gap-2">
            {[accent, muted, design.tokens.colors.surface, design.tokens.colors.text].map((color) => (
              <span key={color} className="h-8 rounded-md border border-line" style={{ background: color }} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line p-3" style={{ background, color: text, fontFamily: body, height }}>
      <div className="flex h-full gap-3">
        <div className="flex w-9 flex-none flex-col gap-1 rounded-md p-1" style={{ background: muted }}>
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className="h-2 rounded-sm bg-white/80" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: accent }}>
              {label}
            </div>
            <span className="h-5 w-12 rounded-md" style={{ background: accent }} />
          </div>
          <div className={`${compact ? "mt-2" : "mt-3"} grid grid-cols-3 gap-2`}>
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-7 rounded-md border border-line bg-white" />
            ))}
          </div>
          {!compact ? (
            <div className="mt-3 grid gap-1.5">
              {[0, 1, 2].map((index) => (
                <div key={index} className="grid grid-cols-[1fr_52px] gap-2">
                  <span className="h-2 rounded-full" style={{ background: index === 0 ? text : muted }} />
                  <span className="h-2 rounded-full" style={{ background: index === 2 ? accent : muted }} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StyleMiniPreview({ compact = false, design }: { compact?: boolean; design: DesignMeta }) {
  if (design.slug.length > 0) {
    const hasPptCover = Boolean(design.previews.ppt);
    const frame = hasPptCover
      ? {
          ariaLabel: `${design.title} PPT 首页`,
          canvasWidth: 1120,
          canvasHeight: 630,
          src: `/api/designs/${design.slug}/preview?kind=ppt&slide=title`,
          title: `${design.title} PPT 首页`,
        }
      : {
          ariaLabel: `${design.title} 风格样张`,
          canvasWidth: 800,
          canvasHeight: 500,
          src: `/api/designs/${design.slug}/preview?kind=card&surface=library`,
          title: `${design.title} 风格样张`,
        };
    return (
      <ScaledPreviewFrame
        ariaLabel={frame.ariaLabel}
        canvasWidth={frame.canvasWidth}
        canvasHeight={frame.canvasHeight}
        className="w-full rounded-lg border border-line shadow-inner"
        src={frame.src}
        tabIndex={-1}
        title={frame.title}
      />
    );
  }

  const roles = design.profile?.colorRoles;
  const palette = getLibraryPalette(design);
  const background = roles?.background ?? design.tokens.colors.surface;
  const text = roles?.text ?? design.tokens.colors.text;
  const accent = roles?.brandPrimary ?? design.tokens.colors.primary;
  const muted = roles?.brandSecondary ?? design.tokens.colors.secondary;
  const display = design.profile?.typographyRoles.display ?? design.tokens.typography.families.display;
  const body = design.profile?.typographyRoles.body ?? design.tokens.typography.families.primary;
  const kind = previewKind(design);
  const height = compact ? 72 : 132;
  const title = design.title.replace(/ — .*/, "").replace(/:.*/, "");

  if (design.sourceMode === "design-system-project" && design.packageManifest) {
    return <ProjectMiniPreview compact={compact} design={design} background={background} text={text} accent={accent} muted={muted} display={display} body={body} height={height} />;
  }

  if (kind === "type-specimen") {
    return (
      <div
        className="overflow-hidden rounded-lg border border-line"
        style={{
          background,
          color: text,
          fontFamily: body,
          height,
        }}
      >
        <div
          className="flex h-full flex-col justify-between p-3"
          style={{
            backgroundImage: `linear-gradient(${muted} 1px, transparent 1px), linear-gradient(90deg, ${muted} 1px, transparent 1px)`,
            backgroundSize: compact ? "24px 24px" : "32px 32px",
          }}
        >
          <div className="flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-[0.12em]">
            <span className="truncate">{design.sourceHost}</span>
            <span className="rounded-full border px-2 py-0.5" style={{ background: "#e8f80d", borderColor: text }}>
              Tester
            </span>
          </div>
          <div className="min-w-0">
            <div className={`${compact ? "text-3xl" : "text-6xl"} font-black uppercase leading-[0.78]`} style={{ fontFamily: display }}>
              GT
            </div>
            {!compact ? (
              <div className="mt-2 flex gap-1.5 text-[10px] font-black">
                <span className="rounded-full border px-2 py-0.5" style={{ borderColor: text }}>
                  Mono
                </span>
                <span className="rounded-full border px-2 py-0.5 text-black" style={{ background: "#ff4cb2", borderColor: text }}>
                  Semi
                </span>
                <span className="rounded-full border px-2 py-0.5 text-black" style={{ background: "#6995ec", borderColor: text }}>
                  Poly
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (kind === "consumer-wallet") {
    return (
      <div className="overflow-hidden rounded-lg border border-line p-3" style={{ background, color: text, fontFamily: body, height }}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-black">phantom</div>
          <div className="rounded-full px-3 py-1 text-[10px] font-bold" style={{ background: accent }}>
            Download
          </div>
        </div>
        <div className="mt-3 grid h-[72px] place-items-center overflow-hidden rounded-xl bg-[#111] px-4 text-center text-white">
          <div>
            <div className="text-[9px] font-bold opacity-80">money app</div>
            <div className={`${compact ? "text-base" : "text-2xl"} font-black leading-none`} style={{ fontFamily: display }}>
              Trade, spend, save
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (kind === "dark-event") {
    return (
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black p-3 text-white" style={{ fontFamily: body, height }}>
        <div className="flex justify-between text-[9px] uppercase text-zinc-300">
          <span>Ship</span>
          <span>Ticket</span>
        </div>
        <div className="mt-4 grid place-items-center">
          <div className="grid gap-1">
            {[1, 3, 5].map((count) => (
              <div key={count} className="flex justify-center gap-1.5">
                {Array.from({ length: count }).map((_, index) => (
                  <span key={index} className="h-2 w-2 border border-zinc-500" />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className={`${compact ? "mt-2 text-xl" : "mt-4 text-3xl"} font-medium leading-none`} style={{ fontFamily: display }}>
          Ship what&apos;s next
        </div>
      </div>
    );
  }

  if (kind === "immersive") {
    return (
      <div className="relative overflow-hidden rounded-lg border border-zinc-800 bg-black p-3 text-white" style={{ fontFamily: body, height }}>
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: "repeating-linear-gradient(90deg, rgba(255,255,255,.16) 0 1px, transparent 1px 6px), repeating-linear-gradient(0deg, rgba(255,255,255,.1) 0 1px, transparent 1px 8px)",
          }}
          aria-hidden="true"
        />
        <div className="relative flex justify-between text-[9px] font-bold uppercase">
          <span>LAB</span>
          <span>ASTRO</span>
        </div>
        <div className="relative mt-7 inline-block bg-black/70 px-2 py-1 text-[10px] font-black uppercase">click to enter</div>
        <div className={`${compact ? "text-2xl" : "text-4xl"} relative mt-2 text-right font-black uppercase leading-none`} style={{ fontFamily: display }}>
          Dither
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line p-3" style={{ background, color: text, fontFamily: body, height }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: accent }}>
            Style sample
          </div>
          <div className={`${compact ? "text-lg" : "text-2xl"} truncate font-semibold leading-none`} style={{ fontFamily: display }}>
            {title}
          </div>
        </div>
        <span className="h-7 w-12 rounded-md" style={{ background: accent }} />
      </div>
      {!compact ? (
        <div className="mt-4 grid grid-cols-3 gap-2">
          {palette.slice(1).map(({ color, key }) => (
            <span key={key} className="h-9 rounded-md border border-line" style={{ background: color }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type FacetOption = {
  key: string;
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
};

function activeFiltersCount(active: Array<{ key: string }>): number {
  return active.filter((item) => !item.key.startsWith("query")).length;
}

function SortControl({ value, onChange }: { value: SortMode; onChange: (m: SortMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeLabel = SORT_OPTIONS.find((option) => option.key === value)?.label ?? "排序";

  return (
    <div ref={ref} className="relative flex-none">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-[12px] font-semibold text-foreground transition hover:border-accent/40"
      >
        <span className="dv-eyebrow opacity-70">排序</span>
        <span className="ml-0.5">{activeLabel}</span>
        <ChevronDown size={12} className="opacity-60" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[140px] rounded-md border border-line bg-surface p-1 shadow-[var(--shadow-md)]"
        >
          {SORT_OPTIONS.map((option) => {
            const active = option.key === value;
            return (
              <button
                key={option.key}
                role="option"
                aria-selected={active}
                type="button"
                onClick={() => {
                  onChange(option.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-[12px] transition ${
                  active ? "bg-accent-soft font-semibold text-accent-strong" : "text-foreground hover:bg-surface-muted"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type TagOption = { tag: string; count: number };

function FilterControl({
  open,
  onOpenChange,
  activeCount,
  sourceOptions,
  categoryOptions,
  tagOptions,
  selectedTag,
  onSelectTag,
  tagsExpanded,
  onToggleTagsExpanded,
  visibleTags,
  hiddenTagCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount: number;
  sourceOptions: FacetOption[];
  categoryOptions: FacetOption[];
  tagOptions: TagOption[];
  selectedTag: string | null;
  onSelectTag: (t: string | null) => void;
  tagsExpanded: boolean;
  onToggleTagsExpanded: (v: boolean) => void;
  visibleTags: TagOption[];
  hiddenTagCount: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative flex-none">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-semibold transition ${
          activeCount > 0
            ? "border-accent/60 bg-accent-soft text-accent-strong"
            : "border-line bg-surface text-foreground hover:border-accent/40"
        }`}
      >
        <Filter size={12} aria-hidden="true" />
        筛选
        {activeCount > 0 ? (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
            {activeCount}
          </span>
        ) : null}
        <ChevronDown size={12} className="opacity-60" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="筛选条件"
          className="absolute right-0 top-[calc(100%+4px)] z-30 grid w-[460px] max-w-[calc(100vw-32px)] gap-3 rounded-md border border-line bg-surface p-3 shadow-[var(--shadow-md)]"
        >
          <FacetRow label="来源" options={sourceOptions} />
          <FacetRow label="分类" options={categoryOptions} />
          {tagOptions.length ? (
            <div className="flex items-baseline gap-3 text-xs">
              <span className="dv-eyebrow w-10 flex-none text-right">标签</span>
              <div className="flex flex-1 flex-wrap items-center gap-x-1 gap-y-1">
                <button
                  aria-pressed={!selectedTag}
                  className={`inline-flex items-center rounded-md px-2 py-1 text-[12px] transition ${
                    !selectedTag
                      ? "bg-foreground/8 font-semibold text-foreground"
                      : "text-muted hover:bg-surface-muted hover:text-foreground"
                  }`}
                  type="button"
                  onClick={() => onSelectTag(null)}
                >
                  全部
                </button>
                {visibleTags.map(({ tag, count }) => {
                  const active = selectedTag === tag;
                  return (
                    <button
                      key={tag}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition ${
                        active
                          ? "bg-accent text-white shadow-[var(--shadow-xs)] font-semibold"
                          : "text-muted hover:bg-surface-muted hover:text-foreground"
                      }`}
                      type="button"
                      onClick={() => onSelectTag(active ? null : tag)}
                    >
                      <span className="max-w-[180px] truncate">{tag}</span>
                      <span
                        className={
                          active
                            ? "tabular-nums text-white/75"
                            : "tabular-nums text-[10.5px] opacity-60"
                        }
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
                {hiddenTagCount > 0 ? (
                  <button
                    className="inline-flex items-center rounded-md px-2 py-1 text-[11.5px] text-[color:var(--faint)] transition hover:text-foreground"
                    type="button"
                    onClick={() => onToggleTagsExpanded(true)}
                  >
                    +{hiddenTagCount} 更多
                  </button>
                ) : tagsExpanded && tagOptions.length > 8 ? (
                  <button
                    className="inline-flex items-center rounded-md px-2 py-1 text-[11.5px] text-[color:var(--faint)] transition hover:text-foreground"
                    type="button"
                    onClick={() => onToggleTagsExpanded(false)}
                  >
                    收起
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FacetRow({ label, options }: { label: string; options: FacetOption[] }) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="dv-eyebrow w-10 flex-none text-right">{label}</span>
      <div className="flex flex-1 flex-wrap items-center gap-x-1 gap-y-1">
        {options.map((option) => {
          const empty = option.count === 0 && !option.active;
          const isAllAndActive = option.active && option.key === "all";
          return (
            <button
              key={option.key}
              aria-pressed={option.active}
              disabled={empty && option.key !== "all"}
              type="button"
              onClick={option.onSelect}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition ${
                option.active
                  ? isAllAndActive
                    ? "bg-foreground/8 font-semibold text-foreground"
                    : "bg-accent text-white shadow-[var(--shadow-xs)] font-semibold"
                  : empty
                  ? "cursor-not-allowed text-[color:var(--faint)]"
                  : "text-muted hover:bg-surface-muted hover:text-foreground"
              }`}
            >
              <span>{option.label}</span>
              <span
                className={
                  option.active && !isAllAndActive
                    ? "tabular-nums text-white/75"
                    : "tabular-nums text-[10.5px] opacity-60"
                }
              >
                {option.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LibraryTags({ compact = false, design }: { compact?: boolean; design: DesignMeta }) {
  const [userTags, setUserTags] = useState<string[]>(() => normalizeTags(design.tags ?? []));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const systemOnly = useMemo(() => {
    const userKeys = new Set(userTags.map((tag) => tag.toLowerCase()));
    return systemDesignTags({
      sourceMode: design.sourceMode,
      packageManifest: design.packageManifest ?? undefined,
      capabilities: design.capabilities ?? [],
      profile: design.profile,
    }).filter((tag) => !userKeys.has(tag.toLowerCase()));
  }, [design, userTags]);

  const visibleSystem = systemOnly.slice(0, compact ? 2 : 4);
  const visibleUser = userTags.slice(0, compact ? 4 : 8);

  async function persist(nextTags: string[]) {
    setStatus("saving");
    setError(null);
    try {
      const response = await fetch(`/api/designs/${design.slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: nextTags }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "保存标签失败。");
      }
      const updated = (await response.json()) as { tags?: string[] };
      const normalized = normalizeTags(updated.tags ?? nextTags);
      setUserTags(normalized);
      setStatus("idle");
    } catch (saveError) {
      setStatus("error");
      setError(saveError instanceof Error ? saveError.message : "保存标签失败。");
    }
  }

  function addTagFromDraft() {
    const tag = normalizeTag(draft);
    if (!tag) return;
    if (userTags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setDraft("");
      return;
    }
    const next = normalizeTags([...userTags, tag]);
    setUserTags(next);
    setDraft("");
    void persist(next);
  }

  function removeTag(tag: string) {
    const next = userTags.filter((item) => item !== tag);
    setUserTags(next);
    void persist(next);
  }

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${compact ? "mt-2" : "mt-3"}`}>
      {visibleSystem.map((tag) => (
        <span key={`sys-${tag}`} className="rounded-md border border-line bg-surface-muted px-2 py-1 text-[10px] font-semibold text-muted">
          {tag}
        </span>
      ))}
      {visibleUser.map((tag) => (
        <span
          key={`user-${tag}`}
          className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent-soft px-2 py-1 text-[10px] font-semibold text-accent-strong"
        >
          {tag}
          <button
            aria-label={`移除标签 ${tag}`}
            className="rounded p-0.5 text-accent-strong/70 transition hover:bg-accent/15 hover:text-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            disabled={status === "saving"}
            type="button"
            onClick={() => removeTag(tag)}
          >
            <X size={10} aria-hidden="true" />
          </button>
        </span>
      ))}
      {editing ? (
        <form
          className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-surface px-1.5 py-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            addTagFromDraft();
          }}
        >
          <input
            ref={inputRef}
            className="h-6 w-24 bg-transparent text-[10px] font-semibold text-foreground outline-none placeholder:text-[color:var(--faint)]"
            maxLength={28}
            placeholder="新标签"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (!draft.trim()) setEditing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft("");
                setEditing(false);
              }
            }}
          />
          <button
            aria-label="确认新增标签"
            className="rounded p-0.5 text-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
            disabled={status === "saving" || !draft.trim()}
            type="submit"
          >
            {status === "saving" ? <Loader2 className="animate-spin" size={11} aria-hidden="true" /> : <Check size={11} aria-hidden="true" />}
          </button>
        </form>
      ) : (
        <button
          aria-label="新增自定义标签"
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-line bg-surface px-2 py-1 text-[10px] font-semibold text-muted transition hover:border-accent/40 hover:text-accent"
          type="button"
          onClick={() => setEditing(true)}
        >
          <Plus size={11} aria-hidden="true" />
          标签
        </button>
      )}
      {error ? (
        <span className="basis-full text-[10px] font-medium text-[color:var(--danger)]" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function HomeLibrary({
  designs,
  initialFavorites = [],
  communityLogin = null,
  mySubmissions = [],
  remoteEntries = [],
  communityBaseUrl = null,
}: {
  designs: DesignMeta[];
  initialFavorites?: string[];
  communityLogin?: string | null;
  mySubmissions?: MySubmission[];
  remoteEntries?: RegistryEntry[];
  communityBaseUrl?: string | null;
}) {
  const router = useRouter();
  const [deletedSlugs, setDeletedSlugs] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  // Phase 2 — community & favorites layer.
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(initialFavorites));
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showCommunityOnly, setShowCommunityOnly] = useState(false);
  const [publishingSlug, setPublishingSlug] = useState<string | null>(null);
  const [submittingSlug, setSubmittingSlug] = useState<string | null>(null);
  const [installingRemoteSlug, setInstallingRemoteSlug] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  const libraryDesigns = useMemo(() => designs.filter((design) => !deletedSlugs.has(design.slug)), [deletedSlugs, designs]);

  // Build slug → latest submission map. A local design might match either by
  // its own slug or, for community-installed designs, by its upstream slug.
  const submissionsBySlug = useMemo(() => {
    const map = new Map<string, MySubmission>();
    for (const submission of mySubmissions) {
      const existing = map.get(submission.slug);
      if (!existing || new Date(submission.submittedAt).getTime() > new Date(existing.submittedAt).getTime()) {
        map.set(submission.slug, submission);
      }
    }
    return map;
  }, [mySubmissions]);

  function getSubmissionFor(design: DesignMeta): MySubmission | undefined {
    const upstream = design.community?.upstreamSlug ?? design.slug.replace(/^community-/, "");
    return submissionsBySlug.get(design.slug) ?? submissionsBySlug.get(upstream);
  }

  // Registry entries that are NOT yet present locally. Local check uses
  // upstreamSlug (if the design came from community) or strips the
  // `community-` prefix on the slug as a fallback.
  const installedUpstream = useMemo(() => {
    const set = new Set<string>();
    for (const design of libraryDesigns) {
      const u = design.community?.upstreamSlug ?? (design.slug.startsWith("community-") ? design.slug.slice("community-".length) : null);
      if (u) set.add(u);
    }
    return set;
  }, [libraryDesigns]);

  const remoteOnly = useMemo(
    () => remoteEntries.filter((entry) => !installedUpstream.has(entry.slug)),
    [remoteEntries, installedUpstream],
  );

  // When the page comes back to the foreground (user just approved something
  // in /admin in another tab, or unhid the window), force a fresh SSR fetch
  // so the marketplace catches new approvals without manual reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let lastRefresh = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefresh < 8000) return; // throttle
      lastRefresh = Date.now();
      router.refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  // Marketplace shows in: default unfiltered view OR when user explicitly
  // pivots to 社区 filter. Hidden when filtered to favorites / a specific
  // source-mode / category / tag — those views are about narrowing local.
  const showMarketplace =
    Boolean(communityBaseUrl) &&
    !showFavoritesOnly &&
    (showCommunityOnly || (sourceFilter === "all" && categoryFilter === "all" && !selectedTag));

  const filteredRemote = useMemo(() => {
    if (!showCommunityOnly && sourceFilter !== "all") return [];
    if (!showCommunityOnly && categoryFilter !== "all") return [];
    if (!showCommunityOnly && selectedTag) return [];
    const lower = query.trim().toLowerCase();
    return remoteOnly.filter((entry) => {
      if (showFavoritesOnly) return false;
      if (!lower) return true;
      return [entry.title, entry.summary, entry.slug, entry.publisher.login, ...(entry.tags ?? [])]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(lower));
    });
  }, [remoteOnly, showCommunityOnly, sourceFilter, categoryFilter, selectedTag, query, showFavoritesOnly]);

  // Counts per facet computed against the **other** active filters, so each chip's
  // count tells you what you'd see if you clicked it.
  const sourceCounts = useMemo(() => {
    const counts: Record<SourceFilter, number> = { all: 0, project: 0, canva: 0, "clone-website": 0, url: 0 };
    for (const design of libraryDesigns) {
      if (!matchesCategory(design, categoryFilter)) continue;
      if (selectedTag && !effectiveDesignTags(design).includes(selectedTag)) continue;
      counts.all += 1;
      for (const option of SOURCE_OPTIONS) {
        if (option.key !== "all" && matchesSource(design, option.key)) counts[option.key] += 1;
      }
    }
    return counts;
  }, [libraryDesigns, categoryFilter, selectedTag]);

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: 0,
      default: 0,
      "presentation-system": 0,
      "visual-style-system": 0,
      "component-system": 0,
      "agent-skill-package": 0,
    };
    for (const design of libraryDesigns) {
      if (!matchesSource(design, sourceFilter)) continue;
      if (selectedTag && !effectiveDesignTags(design).includes(selectedTag)) continue;
      counts.all += 1;
      const packageType = design.packageManifest?.packageType;
      if (!packageType) counts.default += 1;
      else counts[packageType] += 1;
    }
    return counts;
  }, [libraryDesigns, sourceFilter, selectedTag]);

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase();
    const matched = libraryDesigns.filter((design) => {
      if (showFavoritesOnly && !favorites.has(design.slug)) return false;
      if (showCommunityOnly && design.origin !== "community") return false;
      if (!matchesSource(design, sourceFilter)) return false;
      if (!matchesCategory(design, categoryFilter)) return false;
      const tags = effectiveDesignTags(design);
      if (selectedTag && !tags.includes(selectedTag)) return false;
      if (!lower) return true;
      return [design.title, design.sourceHost, design.summary, design.profile?.archetype, design.packageManifest?.packageType, ...tags, ...(design.capabilities ?? []).map((item) => item.id)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(lower));
    });

    return matched.slice().sort((a, b) => {
      if (sortMode === "title") return a.title.localeCompare(b.title, "zh-CN");
      if (sortMode === "quality") return (b.profile?.quality?.score ?? 0) - (a.profile?.quality?.score ?? 0);
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [libraryDesigns, sourceFilter, categoryFilter, selectedTag, query, sortMode, favorites, showFavoritesOnly, showCommunityOnly]);

  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const design of libraryDesigns) {
      if (!matchesSource(design, sourceFilter)) continue;
      if (!matchesCategory(design, categoryFilter)) continue;
      for (const tag of semanticDesignTags(design)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
  }, [libraryDesigns, sourceFilter, categoryFilter]);

  const activeFilters: Array<{ key: string; label: string; clear: () => void }> = [];
  if (showFavoritesOnly) {
    activeFilters.push({ key: "kind-favorites", label: "我的收藏", clear: () => setShowFavoritesOnly(false) });
  }
  if (showCommunityOnly) {
    activeFilters.push({ key: "kind-community", label: "社区", clear: () => setShowCommunityOnly(false) });
  }
  if (sourceFilter !== "all") {
    const label = SOURCE_OPTIONS.find((option) => option.key === sourceFilter)?.label ?? sourceFilter;
    activeFilters.push({ key: `source-${sourceFilter}`, label: `来源 · ${label}`, clear: () => setSourceFilter("all") });
  }
  if (categoryFilter !== "all") {
    const label = CATEGORY_OPTIONS.find((option) => option.key === categoryFilter)?.label ?? categoryFilter;
    activeFilters.push({ key: `category-${categoryFilter}`, label: `分类 · ${label}`, clear: () => setCategoryFilter("all") });
  }
  if (selectedTag) {
    activeFilters.push({ key: `tag-${selectedTag}`, label: `标签 · ${selectedTag}`, clear: () => setSelectedTag(null) });
  }
  if (query.trim()) {
    activeFilters.push({ key: "query", label: `关键词 · ${query.trim()}`, clear: () => setQuery("") });
  }

  function clearAllFilters() {
    setSourceFilter("all");
    setCategoryFilter("all");
    setSelectedTag(null);
    setQuery("");
    setShowFavoritesOnly(false);
    setShowCommunityOnly(false);
  }

  async function handleDelete(design: DesignMeta) {
    const confirmed = window.confirm(`删除「${design.title}」？\n\n这会从本地资料库移除该模板及其生成文件，操作不可撤销。`);
    if (!confirmed) return;

    setDeletingSlug(design.slug);

    try {
      const response = await fetch(`/api/designs/${design.slug}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "删除失败，请稍后重试。");
      }

      setDeletedSlugs((current) => {
        const next = new Set(current);
        next.add(design.slug);
        return next;
      });
      setFavorites((current) => {
        if (!current.has(design.slug)) return current;
        const next = new Set(current);
        next.delete(design.slug);
        return next;
      });
      pushToast("success", `已删除「${design.title}」。`);
      router.refresh();
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setDeletingSlug(null);
    }
  }

  async function toggleFavorite(design: DesignMeta) {
    const slug = design.slug;
    const willFavorite = !favorites.has(slug);
    setFavoriteBusy(slug);
    setFavorites((current) => {
      const next = new Set(current);
      if (willFavorite) next.add(slug);
      else next.delete(slug);
      return next;
    });
    try {
      const response = await fetch(`/api/favorites/${slug}`, { method: willFavorite ? "PUT" : "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "更新收藏失败。");
      }
    } catch (error) {
      setFavorites((current) => {
        const next = new Set(current);
        if (willFavorite) next.delete(slug);
        else next.add(slug);
        return next;
      });
      pushToast("error", error instanceof Error ? error.message : "更新收藏失败。");
    } finally {
      setFavoriteBusy(null);
    }
  }

  async function handleSubmitToCommunity(design: DesignMeta) {
    if (!communityLogin) return;
    const confirmed = window.confirm(
      `把「${design.title}」提交到社区？\n\n` +
        `· 它会被打包上传到当前配置的社区服务\n` +
        `· 进入管理员审核队列\n` +
        `· 通过后，其他用户可在他们的 /community 看到并一键安装`,
    );
    if (!confirmed) return;
    setSubmittingSlug(design.slug);
    try {
      const response = await fetch("/api/community/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: design.slug }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: true; slug?: string; title?: string; status?: string; submissionId?: string; bytes?: number; error?: string }
        | null;
      if (!response.ok || !payload?.submissionId) {
        throw new Error(payload?.error || "提交失败。");
      }
      pushToast("success", `已提交「${payload.title ?? design.title}」（${formatBytes(payload.bytes ?? 0)}）——等待审核员通过。`);
      router.refresh();
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "提交失败。");
    } finally {
      setSubmittingSlug(null);
    }
  }

  async function handlePublish(design: DesignMeta) {
    setPublishingSlug(design.slug);
    try {
      const response = await fetch(`/api/designs/${design.slug}/publish`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        | (PublishResult & { error?: string })
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("bundlePath" in payload)) {
        const error = payload && "error" in payload && payload.error ? payload.error : "导出社区包失败。";
        throw new Error(error);
      }
      pushToast(
        "success",
        `已导出「${payload.title ?? design.title}」v${payload.version}（${formatBytes(payload.bytes)}）→ ${payload.bundlePath}`,
      );
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "导出社区包失败。");
    } finally {
      setPublishingSlug(null);
    }
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("bundle", file);
      const response = await fetch("/api/community/install", { method: "POST", body: formData });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: true; slug?: string; title?: string; error?: string }
        | null;
      if (!response.ok || !payload || !payload.slug) {
        throw new Error(payload?.error || "导入社区包失败。");
      }
      pushToast("success", `已导入「${payload.title ?? payload.slug}」到本地资料库。`);
      router.refresh();
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "导入社区包失败。");
    } finally {
      setImporting(false);
    }
  }

  function onImportInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void handleImportFile(file);
  }

  async function startCommunityLogin() {
    setLoginBusy(true);
    try {
      const response = await fetch("/api/community/login/begin", { method: "POST" });
      const data = (await response.json().catch(() => null)) as { authUrl?: string; error?: string } | null;
      if (!response.ok || !data?.authUrl) {
        throw new Error(data?.error || "无法启动 OAuth。");
      }
      window.open(data.authUrl, "design-vault-login", "width=720,height=820");
      // Poll local server until token saved or we give up after 5 min.
      const startedAt = Date.now();
      const interval = window.setInterval(async () => {
        try {
          const status = (await fetch("/api/community/server", { cache: "no-store" }).then((r) => r.json())) as {
            loggedIn?: boolean;
            login?: string | null;
          };
          if (status.loggedIn) {
            window.clearInterval(interval);
            setLoginBusy(false);
            pushToast("success", `已登录 @${status.login ?? "GitHub"}。`);
            router.refresh();
          } else if (Date.now() - startedAt > 5 * 60 * 1000) {
            window.clearInterval(interval);
            setLoginBusy(false);
            pushToast("error", "登录超时（5 分钟）。窗口里点了 Authorize 吗？");
          }
        } catch {
          // ignore poll failures
        }
      }, 2000);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "登录失败。");
      setLoginBusy(false);
    }
  }

  async function logoutCommunity() {
    if (!window.confirm(`登出社区身份 @${communityLogin}？\n\n本地已安装的社区设计不会被影响，但你需要再次登录才能发布到社区。`)) return;
    setLoginBusy(true);
    try {
      const response = await fetch("/api/community/logout", { method: "POST" });
      if (!response.ok) throw new Error("登出失败。");
      pushToast("success", "已登出社区。");
      router.refresh();
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "登出失败。");
    } finally {
      setLoginBusy(false);
    }
  }

  async function installFromRegistry(slug: string) {
    setInstallingRemoteSlug(slug);
    try {
      const response = await fetch("/api/community/install-remote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: true; slug?: string; title?: string; error?: string }
        | null;
      if (!response.ok || !payload?.slug) throw new Error(payload?.error || "安装失败。");
      pushToast("success", `已安装「${payload.title ?? slug}」到本地。`);
      router.refresh();
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "安装失败。");
    } finally {
      setInstallingRemoteSlug(null);
    }
  }

  const visibleTagCount = tagsExpanded ? tagOptions.length : 8;
  const visibleTags = tagOptions.slice(0, visibleTagCount);
  const hiddenTagCount = Math.max(0, tagOptions.length - visibleTagCount);

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    <section className="grid gap-3">
      {/* ──────── Top toolbar: title + count · search · sort · filter · view ──────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-serif flex-none text-[20px] font-semibold leading-none tracking-[-0.01em] text-foreground">
          设计<span className="italic text-accent">资料库</span>
        </h2>
        <span className="flex-none text-[12.5px] text-muted">
          <span className="tabular-nums font-semibold text-foreground">{filtered.length}</span>
          {filtered.length !== libraryDesigns.length ? <span className="opacity-60"> / {libraryDesigns.length}</span> : null}
          <span className="ml-1">条</span>
        </span>

        {/* The search field grows to absorb the row's spare width. */}
        <label className="relative ml-auto min-w-[200px] max-w-[420px] flex-1">
          <span className="sr-only">搜索设计系统</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" size={14} aria-hidden="true" />
          <input
            className="h-8 w-full rounded-md border border-line bg-surface pl-8 pr-7 text-[12.5px] text-foreground transition placeholder:text-[color:var(--faint)] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft"
            placeholder="搜索标题 / 域名 / 标签"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              aria-label="清除搜索词"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted hover:bg-surface-muted hover:text-foreground"
              type="button"
              onClick={() => setQuery("")}
            >
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </label>

        {/* Sort dropdown. */}
        <SortControl value={sortMode} onChange={setSortMode} />

        {/* Filter dropdown — opens a popover containing all three facet groups. */}
        <FilterControl
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          activeCount={activeFiltersCount(activeFilters)}
          sourceOptions={SOURCE_OPTIONS.map((option) => ({
            key: option.key,
            label: option.label,
            count: sourceCounts[option.key],
            active: sourceFilter === option.key,
            onSelect: () => setSourceFilter(option.key),
          }))}
          categoryOptions={CATEGORY_OPTIONS.map((option) => ({
            key: option.key,
            label: option.label,
            count: categoryCounts[option.key],
            active: categoryFilter === option.key,
            onSelect: () => setCategoryFilter(option.key),
          }))}
          tagOptions={tagOptions}
          selectedTag={selectedTag}
          onSelectTag={setSelectedTag}
          tagsExpanded={tagsExpanded}
          onToggleTagsExpanded={setTagsExpanded}
          visibleTags={visibleTags}
          hiddenTagCount={hiddenTagCount}
        />

        {/* Phase 2: quick toggles + community import. */}
        <button
          aria-label={showFavoritesOnly ? "显示全部" : "只看我收藏的"}
          aria-pressed={showFavoritesOnly}
          className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition ${
            showFavoritesOnly ? "border-[color:var(--danger)]/40 bg-[color:var(--danger-soft)] text-[color:var(--danger)]" : "border-line bg-surface text-muted hover:border-accent/40 hover:text-foreground"
          }`}
          title="只看我收藏的"
          type="button"
          onClick={() => setShowFavoritesOnly((v) => !v)}
        >
          <Heart size={12} aria-hidden="true" fill={showFavoritesOnly ? "currentColor" : "none"} />
          收藏
        </button>
        <button
          aria-label={showCommunityOnly ? "显示全部" : "只看社区拉取的"}
          aria-pressed={showCommunityOnly}
          className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition ${
            showCommunityOnly ? "border-[color:var(--success)]/40 bg-[color:var(--success-soft)] text-[color:var(--success)]" : "border-line bg-surface text-muted hover:border-accent/40 hover:text-foreground"
          }`}
          title="只看社区拉取的"
          type="button"
          onClick={() => setShowCommunityOnly((v) => !v)}
        >
          <Users size={12} aria-hidden="true" />
          社区
        </button>
        <input
          ref={importInputRef}
          accept=".tgz,.tar.gz,application/gzip,application/x-gzip,application/x-tar,application/octet-stream"
          className="hidden"
          type="file"
          onChange={onImportInputChange}
        />
        <button
          aria-label="导入社区包"
          className="flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] font-semibold text-muted transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          disabled={importing}
          title="导入社区包 .tgz"
          type="button"
          onClick={() => importInputRef.current?.click()}
        >
          {importing ? <Loader2 className="animate-spin" size={12} aria-hidden="true" /> : <Upload size={12} aria-hidden="true" />}
          导入包
        </button>
        {communityLogin ? (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[color:var(--success)]/30 bg-[color:var(--success-soft)] px-2 text-[11px] font-semibold text-[color:var(--success)] transition hover:border-[color:var(--danger)]/50 hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loginBusy}
            title={`已登录 @${communityLogin}，点击登出`}
            onClick={logoutCommunity}
          >
            {loginBusy ? <Loader2 className="animate-spin" size={12} aria-hidden="true" /> : <UserCircle2 size={12} aria-hidden="true" />}
            @{communityLogin}
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-line bg-surface px-2 text-[11px] font-semibold text-muted transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loginBusy || !communityBaseUrl}
            title={communityBaseUrl ? "登录 GitHub 后即可发布到社区" : "请先在 server 地址那栏保存 baseUrl"}
            onClick={startCommunityLogin}
          >
            {loginBusy ? <Loader2 className="animate-spin" size={12} aria-hidden="true" /> : <UserCircle2 size={12} aria-hidden="true" />}
            {loginBusy ? "等待 GitHub" : "登录社区"}
          </button>
        )}

        {/* View mode toggle. */}
        <div className="flex flex-none gap-0.5 rounded-md border border-line bg-surface-muted p-0.5">
          {VIEW_OPTIONS.map((item) => {
            const active = viewMode === item.key;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                aria-label={item.label}
                aria-pressed={active}
                className={`flex h-7 w-7 items-center justify-center rounded transition ${
                  active
                    ? "bg-foreground text-[color:var(--background)] shadow-[var(--shadow-xs)]"
                    : "text-muted hover:bg-surface hover:text-foreground"
                }`}
                title={item.label}
                type="button"
                onClick={() => setViewMode(item.key)}
              >
                <Icon size={13} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Active filter chips — only when any are set. */}
      {activeFilters.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {activeFilters.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-strong">
              {item.label}
              <button
                aria-label={`清除 ${item.label}`}
                className="rounded-sm text-accent-strong/70 hover:text-accent-strong"
                type="button"
                onClick={item.clear}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
          <button
            className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-muted underline-offset-2 hover:text-foreground hover:underline"
            type="button"
            onClick={clearAllFilters}
          >
            清除全部
          </button>
        </div>
      ) : null}

      {filtered.length === 0 && filteredRemote.length === 0 && !(communityBaseUrl && showCommunityOnly) ? (
        <div className="rounded-md border border-dashed border-line bg-surface px-6 py-14 text-center text-sm leading-7 text-muted">
          <Search className="mx-auto mb-3 text-[color:var(--faint)]" size={28} aria-hidden="true" />
          没有匹配当前筛选条件的条目。换一个关键词，或切回“全部”查看完整资料库。
        </div>
      ) : filtered.length === 0 ? null : viewMode === "grid" ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((design) => (
            <article
              key={design.slug}
              className="group flex min-h-[308px] min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface p-4 panel-shadow transition hover:-translate-y-0.5 hover:border-accent/35 hover:shadow-[var(--shadow-md)]"
            >
              <div className="grid gap-2">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="dv-eyebrow min-w-0 flex-1 truncate">{design.sourceHost}</div>
                  <div className="flex flex-none items-center gap-1">
                    <button
                      aria-label={favorites.has(design.slug) ? `取消收藏 ${design.title}` : `收藏 ${design.title}`}
                      aria-pressed={favorites.has(design.slug)}
                      className={`flex h-7 w-7 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        favorites.has(design.slug)
                          ? "bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
                          : "text-muted hover:bg-surface-muted hover:text-[color:var(--danger)]"
                      }`}
                      disabled={favoriteBusy === design.slug}
                      title={favorites.has(design.slug) ? "取消收藏" : "收藏"}
                      type="button"
                      onClick={() => toggleFavorite(design)}
                    >
                      <Heart size={14} aria-hidden="true" fill={favorites.has(design.slug) ? "currentColor" : "none"} />
                    </button>
                    {communityLogin && design.origin !== "community" ? (
                      <button
                        aria-label={`发布 ${design.title} 到社区`}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={submittingSlug === design.slug}
                        title="发布到社区（需审核）"
                        type="button"
                        onClick={() => handleSubmitToCommunity(design)}
                      >
                        {submittingSlug === design.slug ? <Loader2 className="animate-spin" size={14} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                      </button>
                    ) : null}
                    <button
                      aria-label={`导出 ${design.title} 本地包`}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-surface-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={publishingSlug === design.slug}
                      title="导出本地 .tgz 包（手动分发）"
                      type="button"
                      onClick={() => handlePublish(design)}
                    >
                      {publishingSlug === design.slug ? <Loader2 className="animate-spin" size={14} aria-hidden="true" /> : <Package size={14} aria-hidden="true" />}
                    </button>
                    <button
                      aria-label={`删除 ${design.title}`}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={deletingSlug === design.slug}
                      title="删除模板"
                      type="button"
                      onClick={() => handleDelete(design)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`whitespace-nowrap rounded-md border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${qualityClass(design)}`}>{qualityLabel(design)}</span>
                  <span className="whitespace-nowrap rounded-md border border-accent/25 bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-strong">{formatPackageType(design)}</span>
                  <span className="whitespace-nowrap rounded-md border border-line bg-surface-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{formatMode(design.sourceMode)}</span>
                  {design.origin === "community" ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-[color:var(--success)]/30 bg-[color:var(--success-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--success)]">
                      <Users size={10} aria-hidden="true" />
                      社区
                    </span>
                  ) : null}
                  {design.community?.publisher ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-surface-muted px-2 py-0.5 text-[10px] font-semibold text-muted" title={`由 GitHub 用户 @${design.community.publisher} 发布`}>
                      <UserCircle2 size={10} aria-hidden="true" />
                      来自 @{design.community.publisher}
                    </span>
                  ) : null}
                  {(() => {
                    const submission = getSubmissionFor(design);
                    return submission ? <SubmissionStatusBadge submission={submission} /> : null;
                  })()}
                </div>
                <h3 className="font-serif dv-two-line-title h-12 text-[19px] font-semibold leading-[1.18] text-foreground">{design.title}</h3>
              </div>

              <div className="mt-4" aria-label="风格样张">
                <StyleMiniPreview design={design} />
              </div>

              <div className="mt-3 grid grid-cols-4 gap-2" aria-label="语义色板">
                {getLibraryPalette(design).map(({ key, color }) => (
                  <div key={key} className="grid gap-1">
                    <div className="h-5 rounded border border-line" style={{ background: color }} />
                    <div className="truncate text-[9px] uppercase tracking-[0.12em] text-[color:var(--faint)]">{key}</div>
                  </div>
                ))}
              </div>

              <p className="mt-4 line-clamp-3 text-sm leading-6 text-muted">{design.summary}</p>
              <LibraryTags design={design} />

              <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-3 text-xs text-muted">
                <span className="min-w-0 truncate">
                  <span className="tabular-nums font-semibold text-foreground">{design.assets.length}</span> 项素材 · {formatDate(design.updatedAt)}
                </span>
                <Link className="inline-flex min-h-8 flex-none items-center gap-1 whitespace-nowrap rounded-md px-2 font-semibold text-accent transition hover:bg-accent-soft" href={`/designs/${design.slug}`}>
                  工作台
                  <ArrowRight size={14} className="transition group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((design) => (
            <article
              key={design.slug}
              className="grid gap-3 rounded-lg border border-line bg-surface px-4 py-4 panel-shadow transition hover:border-accent/35 hover:shadow-[var(--shadow-md)] md:grid-cols-[minmax(0,1fr)_180px_minmax(220px,260px)] md:items-center"
            >
              <div className="min-w-0">
                <div className="dv-eyebrow">{design.sourceHost}</div>
                <div className="font-serif dv-two-line-title mt-1 h-10 text-[17px] font-semibold leading-tight text-foreground">{design.title}</div>
                <div className="mt-1 line-clamp-1 text-sm text-muted">{design.summary}</div>
                <LibraryTags compact design={design} />
              </div>
              <StyleMiniPreview compact design={design} />
              <div className="grid gap-2 text-xs text-muted md:justify-items-end">
                <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
                  <span className="rounded-md border border-accent/25 bg-accent-soft px-2 py-0.5 font-semibold text-accent-strong">{formatPackageType(design)}</span>
                  <span className="rounded-md border border-line bg-surface-muted px-2 py-0.5 font-semibold uppercase tracking-[0.12em] text-muted">{formatMode(design.sourceMode)}</span>
                  {design.origin === "community" ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-[color:var(--success)]/30 bg-[color:var(--success-soft)] px-2 py-0.5 font-semibold text-[color:var(--success)]">
                      <Users size={10} aria-hidden="true" />
                      社区
                    </span>
                  ) : null}
                  {design.community?.publisher ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-muted px-2 py-0.5 font-semibold text-muted" title={`由 GitHub 用户 @${design.community.publisher} 发布`}>
                      <UserCircle2 size={10} aria-hidden="true" />
                      来自 @{design.community.publisher}
                    </span>
                  ) : null}
                  {(() => {
                    const submission = getSubmissionFor(design);
                    return submission ? <SubmissionStatusBadge submission={submission} /> : null;
                  })()}
                </div>
                <div className="flex items-center gap-2 md:justify-end">
                  <span className="whitespace-nowrap">
                    <span className="tabular-nums font-semibold text-foreground">{design.assets.length}</span> 项素材
                  </span>
                  <Link className="inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-md px-2 font-semibold text-accent transition hover:bg-accent-soft" href={`/designs/${design.slug}`}>
                    工作台
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                  <button
                    aria-label={favorites.has(design.slug) ? `取消收藏 ${design.title}` : `收藏 ${design.title}`}
                    aria-pressed={favorites.has(design.slug)}
                    className={`flex h-8 w-8 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      favorites.has(design.slug)
                        ? "bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
                        : "text-muted hover:bg-surface-muted hover:text-[color:var(--danger)]"
                    }`}
                    disabled={favoriteBusy === design.slug}
                    title={favorites.has(design.slug) ? "取消收藏" : "收藏"}
                    type="button"
                    onClick={() => toggleFavorite(design)}
                  >
                    <Heart size={15} aria-hidden="true" fill={favorites.has(design.slug) ? "currentColor" : "none"} />
                  </button>
                  {communityLogin && design.origin !== "community" ? (
                    <button
                      aria-label={`发布 ${design.title} 到社区`}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={submittingSlug === design.slug}
                      title="发布到社区（需审核）"
                      type="button"
                      onClick={() => handleSubmitToCommunity(design)}
                    >
                      {submittingSlug === design.slug ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
                    </button>
                  ) : null}
                  <button
                    aria-label={`导出 ${design.title} 本地包`}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-surface-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={publishingSlug === design.slug}
                    title="导出本地 .tgz 包（手动分发）"
                    type="button"
                    onClick={() => handlePublish(design)}
                  >
                    {publishingSlug === design.slug ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Package size={15} aria-hidden="true" />}
                  </button>
                  <button
                    aria-label={`删除 ${design.title}`}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={deletingSlug === design.slug}
                    title="删除模板"
                    type="button"
                    onClick={() => handleDelete(design)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {showMarketplace ? (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-serif text-[16px] font-semibold text-foreground">
              社区<span className="italic text-accent">商场</span>
              <span className="ml-2 text-xs font-normal text-muted">
                {filteredRemote.length > 0
                  ? `${filteredRemote.length} 条可装`
                  : remoteEntries.length > 0
                    ? `${remoteEntries.length} 条全装好了`
                    : "暂无已审核内容"}
                {communityBaseUrl ? ` · 来自 ${new URL(communityBaseUrl).host}` : ""}
              </span>
            </h3>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] font-semibold text-muted transition hover:border-accent/40 hover:text-accent"
              title="拉一次最新的商场目录"
              onClick={() => router.refresh()}
            >
              <ArrowRight size={11} aria-hidden="true" style={{ transform: "rotate(45deg)" }} />
              刷新商场
            </button>
          </div>
          {filteredRemote.length === 0 ? (
            <div className="rounded-md border border-dashed border-line bg-surface-muted/40 px-6 py-10 text-center text-sm leading-7 text-muted">
              {remoteEntries.length === 0 ? (
                <>
                  社区目前没有已审核通过的设计。
                  {communityLogin ? <> 你可以在自己的卡片上点 🚀 投个第一条。</> : <> 登录后可以投稿。</>}
                </>
              ) : (
                <>已审核的 {remoteEntries.length} 条设计都已在你本地，去除筛选或换关键词搜搜看其他人的发布吧。</>
              )}
            </div>
          ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredRemote.map((entry) => (
              <article
                key={`remote-${entry.slug}`}
                className="group flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-dashed border-line bg-surface-muted/40 p-4 transition hover:border-accent/35"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="dv-eyebrow min-w-0 flex-1 truncate">{entry.manifest.sourceHost || entry.slug}</div>
                  <span className="inline-flex flex-none items-center gap-1 rounded-md border border-[color:var(--success)]/30 bg-[color:var(--success-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--success)]">
                    <Users size={10} aria-hidden="true" />
                    可装
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {typeof entry.qualityScore === "number" ? (
                    <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-muted">质量 {entry.qualityScore}/100</span>
                  ) : null}
                  {entry.archetype ? (
                    <span className="rounded-md border border-accent/25 bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-strong">{entry.archetype}</span>
                  ) : null}
                  <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-muted">
                    <UserCircle2 size={10} aria-hidden="true" />
                    @{entry.publisher.login}
                  </span>
                </div>
                <h4 className="font-serif dv-two-line-title h-12 text-[17px] font-semibold leading-[1.18] text-foreground">{entry.title}</h4>
                <ScaledPreviewFrame
                  ariaLabel={`${entry.title} 社区预览`}
                  className="w-full rounded-lg border border-line shadow-inner"
                  src={`/api/community/registry/${entry.slug}/preview?kind=card`}
                  tabIndex={-1}
                  title={`${entry.title} 社区预览`}
                />
                <p className="line-clamp-3 text-sm leading-6 text-muted">{entry.summary}</p>
                <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    <span>{formatBytes(entry.bundleBytes)}</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-0.5" title={`${entry.downloads} 次下载`}>
                      <ArrowRight size={11} aria-hidden="true" style={{ transform: "rotate(90deg)" }} />
                      <span className="tabular-nums font-semibold text-foreground">{entry.downloads}</span>
                    </span>
                  </span>
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-semibold text-white transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={installingRemoteSlug === entry.slug}
                    type="button"
                    onClick={() => installFromRegistry(entry.slug)}
                  >
                    {installingRemoteSlug === entry.slug ? (
                      <>
                        <Loader2 className="animate-spin" size={13} aria-hidden="true" />
                        安装中
                      </>
                    ) : (
                      <>
                        <Send size={13} aria-hidden="true" style={{ transform: "rotate(180deg)" }} />
                        安装到本地
                      </>
                    )}
                  </button>
                </div>
              </article>
            ))}
          </div>
          )}
        </div>
      ) : null}
    </section>
    </>
  );
}
