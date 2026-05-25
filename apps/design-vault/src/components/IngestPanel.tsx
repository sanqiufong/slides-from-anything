"use client";

import { ArrowRight, CheckCircle2, Loader2, Package, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { IngestMode, IngestionJob } from "@/lib/types";

type ModeDetail = {
  /** Concrete source kinds this mode handles. */
  fits: string[];
  /** What the importer pulls out. */
  extracts: string[];
  /** Mismatched sources + redirection hint to the right tab. */
  skips: string[];
  /** Example inputs to copy from. */
  examples: string[];
};

const MODE_OPTIONS: Array<{
  value: IngestMode;
  short: string;
  hint: string;
  detail: ModeDetail;
}> = [
  {
    value: "url",
    short: "网址",
    hint: "抓取公开页面并生成可复用设计记录。",
    detail: {
      fits: [
        "营销页、产品页、设计师作品集",
        "Canva 公开模板与预览页",
        "单页或少量页面的设计指纹采样",
      ],
      extracts: [
        "色板、字体、间距 token",
        "Hero / CTA / 图片样张",
        "组件签名与 archetype 自动分类",
        "presentation 转化的 slide archetypes",
      ],
      skips: [
        "需要登录或弹窗墙的页面 → 用 Clone",
        "整个 GitHub repo 或 npm 包 → 用 项目",
      ],
      examples: [
        "https://www.linear.app",
        "https://www.canva.com/templates/EAFw5n8u_jU-...",
      ],
    },
  },
  {
    value: "clone-website",
    short: "Clone",
    hint: "整站克隆，保留导航与多页面关系。",
    detail: {
      fits: [
        "整站克隆并保留 sitemap",
        "对照原站做二级设计指纹（跨页一致性）",
        "需要 footer / nav / 多落地页交叉证据的来源",
      ],
      extracts: [
        "比单页 URL 更全的结构信号",
        "跨页面一致的字体 / 间距 / 组件",
        "导航与 footer 链接图谱",
      ],
      skips: [
        "只想看一个营销页 → 用 网址",
        "源码或 token 文件 → 用 项目",
      ],
      examples: [
        "https://stripe.com",
        "https://www.framer.com",
      ],
    },
  },
  {
    value: "design-system-project",
    short: "项目",
    hint: "导入 GitHub repo、npm 包或 zip，生成 agent skill。",
    detail: {
      fits: [
        "公开 GitHub 仓库（开源组件库 / 模板项目）",
        "npm 包名（已发布的 design system）",
        "上传的 .zip 设计系统包",
      ],
      extracts: [
        "Design tokens（CSS variable、JSON token 文件）",
        "组件源码（React / Vue / Svelte）",
        "README / DESIGN.md / 主题配置",
        "自动注册为可调用的 agent skill",
      ],
      skips: [
        "公网页面 URL → 用 网址",
        "整站 sitemap → 用 Clone",
      ],
      examples: [
        "https://github.com/tabler/tabler",
        "https://github.com/shadcn-ui/ui",
        "npm:@radix-ui/themes",
      ],
    },
  },
];

const INGESTION_QUEUE_EVENT = "design-vault:ingestion-job";

function parseSources(value: string) {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

function emitQueueJob(job: IngestionJob) {
  window.dispatchEvent(new CustomEvent<IngestionJob>(INGESTION_QUEUE_EVENT, { detail: job }));
}

export function IngestPanel({ initialUrl = "", initialMode = "url" }: { initialUrl?: string; initialMode?: IngestMode }) {
  const [url, setUrl] = useState(initialUrl);
  const [mode, setMode] = useState<IngestMode>(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeMode = MODE_OPTIONS.find((opt) => opt.value === mode) ?? MODE_OPTIONS[0];

  const sourcePlaceholder = useMemo(
    () =>
      mode === "design-system-project"
        ? "https://github.com/tabler/tabler\nhttps://github.com/shadcn-ui/ui"
        : "https://www.example.com\nhttps://www.canva.com/templates/...\nhttps://www.canva.com/design/.../edit",
    [mode],
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const sources = parseSources(url);
    if (!sources.length) {
      setError("请至少提供一个来源地址。");
      return;
    }

    setSubmitting(true);
    try {
      const results = await Promise.allSettled(
        sources.map(async (source) => {
          const response = await fetch("/api/ingestions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: source, mode }),
          });
          if (!response.ok) {
            const data = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(`${source}：${data?.error || "启动导入任务失败。"}`);
          }
          const job = (await response.json()) as IngestionJob & { modeRedirected?: boolean; modeRedirectReason?: string };
          emitQueueJob(job);
          return job;
        }),
      );
      const created = results.filter((result): result is PromiseFulfilledResult<IngestionJob> => result.status === "fulfilled").map((result) => result.value);
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (created.length) {
        const redirected = created.filter((j) => (j as { modeRedirected?: boolean }).modeRedirected);
        const baseMsg = `已加入 ${created.length} 个导入任务到右下角队列，可以继续添加新的来源。`;
        const redirectMsg = redirected.length
          ? ` 其中 ${redirected.length} 个来源是 GitHub / npm / 包仓库，已自动切到 项目 模式（更贴近这类来源的抽象方式）。`
          : "";
        setNotice(baseMsg + redirectMsg);
        setUrl("");
      }
      if (failed.length) {
        setError(failed.map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason))).join("\n"));
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="px-5 py-4" aria-label="导入设计系统">
      {/* Underlined tab strip — single line, fills width. */}
      <div className="flex items-center gap-4 border-b border-line" role="tablist" aria-label="导入模式">
        {MODE_OPTIONS.map((option) => {
          const active = option.value === mode;
          return (
            <button
              key={option.value}
              aria-selected={active}
              role="tab"
              type="button"
              onClick={() => setMode(option.value)}
              className={`relative -mb-px pb-2 text-[12.5px] font-semibold transition ${
                active
                  ? "text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {option.short}
              {active ? (
                <span
                  className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-accent"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Mode hint sits under the tabs, like a description for the active tab. */}
      <p className="mt-3 text-[12px] leading-[1.6] text-muted">{activeMode.hint}</p>

      <form className="mt-3 flex flex-col gap-3" onSubmit={onSubmit}>
        <textarea
          aria-label="来源地址"
          className="min-h-[92px] w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-[12.5px] leading-[1.6] text-foreground transition placeholder:text-[color:var(--faint)]/75 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft disabled:cursor-not-allowed disabled:bg-surface-muted"
          disabled={submitting}
          name="url"
          placeholder={sourcePlaceholder}
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />

        <div className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--faint)]">
          <span>每行一个 URL · Enter 换行</span>
          <button
            className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white shadow-[var(--shadow-xs)] transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting}
            type="submit"
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" size={13} aria-hidden="true" />
                加入队列
              </>
            ) : (
              <>
                开始导入
                <ArrowRight size={13} aria-hidden="true" />
              </>
            )}
          </button>
        </div>
      </form>

      {notice ? (
        <div className="mt-3 rounded-md border border-[color:var(--success)]/25 bg-[color:var(--success-soft)] px-2.5 py-1.5 text-[11.5px] leading-5 text-[color:var(--success)]" role="status">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="dv-wrap-anywhere mt-3 whitespace-pre-line rounded-md border border-[color:var(--danger)]/25 bg-[color:var(--danger-soft)] px-2.5 py-1.5 text-[11.5px] leading-5 text-[color:var(--danger)]" role="alert">
          {error}
        </div>
      ) : null}

      {/* Mode-aware explainer — fills the drawer's vertical space with substance. */}
      <ModeGuide detail={activeMode.detail} modeLabel={activeMode.short} />
    </section>
  );
}

function ModeGuide({ detail, modeLabel }: { detail: ModeDetail; modeLabel: string }) {
  return (
    <div className="mt-6 grid gap-4 border-t border-line pt-5 text-[12.5px] leading-[1.65]">
      <GuideBlock
        tone="ok"
        icon={<CheckCircle2 size={13} aria-hidden="true" />}
        label="适合场景"
        items={detail.fits}
      />

      <GuideBlock
        tone="info"
        icon={<Package size={13} aria-hidden="true" />}
        label="能抓到"
        items={detail.extracts}
      />

      <GuideBlock
        tone="warn"
        icon={<XCircle size={13} aria-hidden="true" />}
        label="不适合"
        items={detail.skips}
      />

      <div>
        <div className="dv-eyebrow mb-1.5">{modeLabel} 模式示例</div>
        <ul className="grid gap-1">
          {detail.examples.map((example) => (
            <li
              key={example}
              className="dv-wrap-anywhere rounded-md border border-line bg-surface-muted/60 px-2.5 py-1.5 font-mono text-[11px] leading-5 text-muted"
            >
              {example}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function GuideBlock({
  tone,
  icon,
  label,
  items,
}: {
  tone: "ok" | "info" | "warn";
  icon: React.ReactNode;
  label: string;
  items: string[];
}) {
  const toneClass: Record<typeof tone, string> = {
    ok: "text-[color:var(--success)]",
    info: "text-accent",
    warn: "text-[color:var(--warning)]",
  };
  const dotClass: Record<typeof tone, string> = {
    ok: "bg-[color:var(--success)]/45",
    info: "bg-accent/55",
    warn: "bg-[color:var(--warning)]/55",
  };
  return (
    <div>
      <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] ${toneClass[tone]}`}>
        {icon}
        {label}
      </div>
      <ul className="mt-1.5 grid gap-1 pl-0.5 text-foreground/85">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span
              className={`mt-[7px] inline-block h-1 w-1 flex-none rounded-full ${dotClass[tone]}`}
              aria-hidden="true"
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
