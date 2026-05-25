"use client";

import {
  BarChart3,
  Bot,
  Boxes,
  ClipboardList,
  Component,
  Gauge,
  CheckCircle2,
  CircleX,
  ExternalLink,
  Film,
  FileText,
  ImageIcon,
  Images,
  Layers,
  Monitor,
  Palette,
  Plus,
  Presentation,
  Save,
  Tag,
  TriangleAlert,
  Type,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { CopyButtons } from "@/components/CopyButtons";
import { ScaledPreviewFrame } from "@/components/ScaledPreviewFrame";
import { normalizeTag, normalizeTags, systemDesignTags } from "@/lib/tags";
import type { AssetRecord, ColorTokenSet, DesignSystemCapability, DesignSystemPackageManifest, DesignSystemProfile, IngestMode, SourceChainEntry } from "@/lib/types";

type Props = {
  slug: string;
  title: string;
  summary: string;
  sourceUrl: string;
  sourceHost: string;
  sourceMode: IngestMode;
  requestedSourceUrl?: string;
  sourceChain?: SourceChainEntry[];
  designMd: string;
  productMd: string;
  designSpecMd: string;
  themeMd: string;
  evidencePath: string;
  designPath: string;
  productPath: string;
  designSpecPath: string;
  styleCardPath: string;
  antiPatternsPath: string;
  qualityGatesPath: string;
  routerSkillPath: string;
  themePath: string;
  createSlideReference: string;
  agentSkillReference?: string;
  executionReference: string;
  profile: DesignSystemProfile;
  packageManifest?: DesignSystemPackageManifest | null;
  capabilities?: DesignSystemCapability[];
  tags?: string[];
  colors: ColorTokenSet;
  typography: {
    primary: string;
    display: string;
    mono: string;
    scale: string[];
  };
  assets: AssetRecord[];
};

type TabKey = "preview" | "analysis" | "skill" | "docs" | "assets";
type SemanticPaletteItem = {
  key: string;
  label: string;
  value: string;
  note: string;
};

const TAB_META: Array<{ key: TabKey; label: string; hint: string; icon: LucideIcon }> = [
  { key: "preview", label: "预览", hint: "网页与 PPT 舞台", icon: Monitor },
  { key: "analysis", label: "分析", hint: "判断与证据", icon: BarChart3 },
  { key: "skill", label: "Agent Skill", hint: "能力索引与安装", icon: Bot },
  { key: "docs", label: "文档", hint: "design.md 与 theme", icon: FileText },
  { key: "assets", label: "素材", hint: "品牌与图标", icon: Images },
];

const PPT_TEMPLATE_PREVIEWS = [
  { key: "title", label: "封面", hint: "source visual + title hierarchy" },
  { key: "data", label: "数据页", hint: "metrics + source evidence" },
  { key: "image", label: "图片页", hint: "hero image + thumbnails" },
  { key: "single", label: "单模块文本", hint: "one idea / one module" },
  { key: "multi", label: "多模块文本", hint: "component recipe grid" },
];

const SOURCE_ROLE_LABEL: Record<SourceChainEntry["role"], string> = {
  requested: "请求入口",
  showcase: "展示页",
  primary: "真实源站",
};

const SYNTHESIS_STATUS_LABEL: Record<NonNullable<DesignSystemProfile["synthesis"]["status"]>, string> = {
  "model-success": "已使用大模型",
  "model-skipped": "未配置模型",
  "model-failed": "模型失败后保底",
  "heuristic-only": "启发式保底",
};

function buildSemanticPalette(profile: DesignSystemProfile): SemanticPaletteItem[] {
  return [
    {
      key: "background",
      label: "背景 / 舞台",
      value: profile.colorRoles.background,
      note: "页面主底色或主要 surface",
    },
    {
      key: "text",
      label: "主文字",
      value: profile.colorRoles.text,
      note: "正文与标题的主阅读色",
    },
    {
      key: "primary",
      label: "主行动 / 强对比",
      value: profile.colorRoles.brandPrimary,
      note: "CTA、品牌高优先级元素",
    },
    {
      key: "muted",
      label: "弱化 / 细线",
      value: profile.colorRoles.brandSecondary,
      note: "分隔线、弱文字、辅助信息",
    },
  ];
}

function isVideoAsset(asset: AssetRecord) {
  return asset.kind === "video" || /\.(mp4|webm)$/i.test(asset.path);
}

function AssetThumbnail({ alt, kind, src }: { alt: string; kind: AssetRecord["kind"]; src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-xs text-muted">
        <ImageIcon size={22} aria-hidden="true" />
        <span>无法直接预览</span>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <video
        aria-label={alt}
        className="max-h-full max-w-full object-contain"
        loop
        muted
        playsInline
        preload="metadata"
        src={src}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <Image
      alt={alt}
      className="max-h-full max-w-full object-contain"
      height={140}
      src={src}
      unoptimized
      width={140}
      onError={() => setFailed(true)}
    />
  );
}

function assetPublicUrl(slug: string, asset: AssetRecord) {
  return `/api/designs/${slug}/asset/${asset.path.replace(/^assets\//, "")}`;
}

function previewMediaAssets(assets: AssetRecord[]) {
  return assets.filter((asset) => asset.kind === "image" || asset.kind === "svg" || isVideoAsset(asset));
}

function DemoMedia({ asset, hero, slug, title }: { asset: AssetRecord; hero?: boolean; slug: string; title: string }) {
  const src = assetPublicUrl(slug, asset);
  if (isVideoAsset(asset)) {
    return (
      <video
        aria-label={`${title} ${asset.name}`}
        className={`h-full w-full bg-black ${hero ? "object-contain" : "object-cover transition group-hover:scale-[1.02]"}`}
        autoPlay
        controls={hero}
        loop
        muted
        playsInline
        preload="metadata"
        src={src}
      />
    );
  }

  return <Image alt={`${title} ${asset.name}`} className={`${hero ? "object-contain" : "object-cover"} transition group-hover:scale-[1.02]`} fill sizes={hero ? "(min-width: 1280px) 54vw, 100vw" : "190px"} src={src} unoptimized />;
}

function ProjectDemoGallery({ assets, slug, sourceUrl, title }: { assets: AssetRecord[]; slug: string; sourceUrl: string; title: string }) {
  const previewAssets = previewMediaAssets(assets).slice(0, 6);
  const [heroAsset, ...secondaryAssets] = previewAssets;
  if (!heroAsset) return null;

  return (
    <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 dv-eyebrow">
            <ImageIcon size={14} aria-hidden="true" />
            上游 Demo
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground">README / 文档截图</h3>
          <p className="mt-1 text-sm leading-6 text-muted">优先使用项目介绍页里的真实演示图，作为风格判断和后续引用的视觉证据。</p>
        </div>
        <a className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent/40 hover:text-accent" href={sourceUrl} rel="noreferrer" target="_blank">
          源项目
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_190px]">
        <div className="group relative aspect-[16/9] overflow-hidden rounded-lg border border-line bg-surface-muted">
          <DemoMedia asset={heroAsset} hero slug={slug} title={title} />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent p-3 text-xs font-semibold text-white">{heroAsset.name}</div>
          {isVideoAsset(heroAsset) ? (
            <div className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white backdrop-blur">
              <Film size={12} aria-hidden="true" />
              experience video
            </div>
          ) : null}
        </div>

        {secondaryAssets.length ? (
          <div className="grid grid-cols-3 gap-2 xl:grid-cols-1">
            {secondaryAssets.slice(0, 3).map((asset) => (
              <a key={asset.path} className="group relative aspect-[16/10] overflow-hidden rounded-lg border border-line bg-surface-muted" href={asset.sourceUrl ?? assetPublicUrl(slug, asset)} rel="noreferrer" target="_blank" title={asset.name}>
                <DemoMedia asset={asset} slug={slug} title={title} />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function getProfileHeading(profile: DesignSystemProfile, fallback: string) {
  const evidenceLine = profile.evidenceSummary.find((item) => item.includes("标题样本"));
  return evidenceLine?.split("：")[1]?.split(" / ")[0]?.trim() || fallback;
}

function SourceAudit({
  sourceUrl,
  sourceHost,
  requestedSourceUrl,
  sourceChain,
}: {
  sourceUrl: string;
  sourceHost: string;
  requestedSourceUrl?: string;
  sourceChain?: SourceChainEntry[];
}) {
  const chain =
    sourceChain?.length
      ? sourceChain
      : [
          {
            role: "primary" as const,
            url: sourceUrl,
            host: sourceHost,
            note: "Direct source used for design extraction.",
          },
        ];
  const hasResolution = Boolean(requestedSourceUrl && requestedSourceUrl !== sourceUrl) || chain.length > 1;

  if (!hasResolution) {
    return null;
  }

  return (
    <article className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start">
        <div>
          <div className="flex items-center gap-2 dv-eyebrow">
            <Layers size={14} aria-hidden="true" />
            来源链路
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground">已解析到真实源站</h3>
          <p className="mt-1 text-sm leading-6 text-muted">展示页只保留为上下文，设计证据以最终源站为准。</p>
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-surface-muted">
          {chain.map((entry, index) => {
            const isPrimary = entry.role === "primary";
            return (
              <div key={`${entry.role}-${entry.url}`} className={`grid gap-2 px-3 py-3 sm:grid-cols-[112px_minmax(0,1fr)] ${index ? "border-t border-line" : ""}`}>
                <div>
                  <span className={`inline-flex rounded-md px-2 py-1 text-[11px] font-semibold ${isPrimary ? "bg-accent-soft text-accent-strong" : "bg-surface text-muted"}`}>
                    {SOURCE_ROLE_LABEL[entry.role]}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="truncate text-sm font-semibold text-foreground">{entry.host}</span>
                    <a className="inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-accent transition hover:text-accent-strong" href={entry.url} rel="noreferrer" target="_blank">
                      打开
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted">{entry.url}</div>
                  <div className="mt-2 text-xs leading-5 text-muted">{entry.note}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

function SynthesisAudit({ profile }: { profile: DesignSystemProfile }) {
  const synthesis = profile.synthesis;
  const status = synthesis.status ?? (synthesis.mode === "model" ? "model-success" : "heuristic-only");
  const success = status === "model-success";
  const stats = synthesis.evidenceStats;
  const evidenceCount = stats ? stats.headings + stats.buttons + stats.links + stats.colors + stats.fonts + stats.sections + stats.behaviorSignals + stats.responsiveSignals : null;

  return (
    <details className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <summary className="flex cursor-pointer list-none flex-col gap-3 [&::-webkit-details-marker]:hidden sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 dv-eyebrow">
            <BarChart3 size={14} aria-hidden="true" />
            AI 理解层
          </div>
          <h3 className="mt-1 truncate text-base font-semibold text-foreground">
            {SYNTHESIS_STATUS_LABEL[status]} · {synthesis.model ?? "未配置模型"}
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-md px-2 py-1 font-semibold ${success ? "bg-accent text-white" : "bg-surface-muted text-muted"}`}>{SYNTHESIS_STATUS_LABEL[status]}</span>
          <span className="rounded-md border border-line bg-surface-muted px-2 py-1 font-semibold text-muted">{typeof evidenceCount === "number" ? `${evidenceCount} 条证据` : "证据未记录"}</span>
          <span className="rounded-md border border-line bg-surface-muted px-2 py-1 font-semibold text-muted">展开</span>
        </div>
      </summary>

      <div className={`mt-4 rounded-lg border p-4 ${success ? "border-accent/25 bg-accent-soft/50" : "border-line bg-surface-muted"}`}>
        <div className="grid gap-2 text-xs sm:grid-cols-4">
          <SummaryMetric label="模型" value={synthesis.model ?? "未配置"} />
          <SummaryMetric label="耗时" value={typeof synthesis.durationMs === "number" ? `${Math.round(synthesis.durationMs / 1000)}s` : "未记录"} />
          <SummaryMetric label="证据" value={typeof evidenceCount === "number" ? `${evidenceCount} 条` : "未记录"} />
          <SummaryMetric label="版本" value={synthesis.promptVersion ?? "未记录"} />
        </div>
        <div className="mt-3 grid gap-3 text-xs leading-5 text-muted">
          <div>
            <span className="font-semibold text-foreground">说明：</span>
            {synthesis.reason ?? "未记录"}
          </div>
          {stats ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["标题", stats.headings],
                ["按钮", stats.buttons],
                ["链接", stats.links],
                ["颜色", stats.colors],
                ["字体", stats.fonts],
                ["区块", stats.sections],
                ["行为", stats.behaviorSignals],
                ["响应式", stats.responsiveSignals],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-line bg-surface px-2 py-2">
                  <div className="font-semibold text-foreground">{value}</div>
                  <div className="mt-0.5 text-muted">{label}</div>
                </div>
              ))}
            </div>
          ) : (
            <p>旧记录未保存输入统计，重新导入后会补全。</p>
          )}
        </div>
      </div>
    </details>
  );
}

function QualityAudit({ profile }: { profile: DesignSystemProfile }) {
  const quality = profile.quality;

  if (!quality) {
    return (
      <details className="rounded-lg border border-line bg-surface p-4 shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <div>
            <div className="flex items-center gap-2 dv-eyebrow">
              <Gauge size={14} aria-hidden="true" />
              9/10 质量门
            </div>
            <h3 className="mt-1 text-base font-semibold text-foreground">未生成质量报告</h3>
          </div>
          <span className="rounded-md border border-line bg-surface-muted px-2 py-1 text-xs font-semibold text-muted">展开</span>
        </summary>
        <p className="mt-3 text-sm leading-6 text-muted">重新导入或运行文档再生成后，会补全机器可审查的生产质量门。</p>
      </details>
    );
  }

  const gradeLabel: Record<typeof quality.grade, string> = {
    "production-9plus": "9/10+ 可生产复用",
    "needs-review": "需要复审",
    blocked: "阻塞",
  };
  const scoreTone =
    quality.grade === "production-9plus"
      ? "border-[color:var(--success)]/25 bg-[color:var(--success-soft)] text-[color:var(--success)]"
      : quality.grade === "needs-review"
        ? "border-[color:var(--warning)]/25 bg-[color:var(--warning-soft)] text-[color:var(--warning)]"
        : "border-[color:var(--danger)]/25 bg-[color:var(--danger-soft)] text-[color:var(--danger)]";
  const statusIcon = {
    pass: CheckCircle2,
    warn: TriangleAlert,
    fail: CircleX,
  };
  const statusTone = {
    pass: "border-[color:var(--success)]/25 bg-[color:var(--success-soft)] text-[color:var(--success)]",
    warn: "border-[color:var(--warning)]/25 bg-[color:var(--warning-soft)] text-[color:var(--warning)]",
    fail: "border-[color:var(--danger)]/25 bg-[color:var(--danger-soft)] text-[color:var(--danger)]",
  };
  const passed = quality.gates.filter((gate) => gate.status === "pass").length;
  const warned = quality.gates.filter((gate) => gate.status === "warn").length;
  const failed = quality.gates.filter((gate) => gate.status === "fail").length;
  const weakestGate = [...quality.gates].sort((a, b) => a.score / a.maxScore - b.score / b.maxScore)[0];

  return (
    <details className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <summary className="flex cursor-pointer list-none flex-col gap-3 [&::-webkit-details-marker]:hidden sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 dv-eyebrow">
            <Gauge size={14} aria-hidden="true" />
            9/10 质量门
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground">
            {gradeLabel[quality.grade]} · {quality.score}/100
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-md border px-2 py-1 font-semibold ${scoreTone}`}>门槛 {quality.threshold}/100</span>
          <span className="rounded-md border border-line bg-surface-muted px-2 py-1 font-semibold text-muted">通过 {passed}/{quality.gates.length}</span>
          <span className="rounded-md border border-line bg-surface-muted px-2 py-1 font-semibold text-muted">展开</span>
        </div>
      </summary>

      <div className="mt-4 grid gap-4">
        <div className={`rounded-lg border p-4 ${scoreTone}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] opacity-80">Production score</div>
              <div className="mt-1 text-4xl font-semibold tabular-nums">{quality.score}/100</div>
            </div>
            <div className="rounded-md bg-white/70 px-3 py-2 text-xs font-semibold">门槛 {quality.threshold}/100</div>
          </div>
          <p className="mt-3 text-sm leading-6">{quality.summary}</p>
          <div className="mt-4 grid gap-2 text-xs sm:grid-cols-4">
            <SummaryMetric label="通过" value={`${passed}/${quality.gates.length}`} />
            <SummaryMetric label="警告" value={`${warned}`} />
            <SummaryMetric label="阻塞" value={`${failed}`} />
            <SummaryMetric label="最低项" value={weakestGate ? `${weakestGate.label} ${weakestGate.score}/${weakestGate.maxScore}` : "无"} />
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          {quality.gates.map((gate) => {
            const Icon = statusIcon[gate.status];
            return (
              <div key={gate.id} className={`rounded-lg border p-3 ${statusTone[gate.status]}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Icon size={15} aria-hidden="true" />
                      <div className="truncate text-sm font-semibold">{gate.label}</div>
                    </div>
                    <div className="mt-1 text-xs leading-5 opacity-80">{gate.recommendation}</div>
                  </div>
                  <div className="flex-none rounded-md bg-white/70 px-2 py-1 text-xs font-semibold tabular-nums">
                    {gate.score}/{gate.maxScore}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line/70 bg-white/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function isDarkEventPreview({
  title,
  summary,
  sourceHost,
  profile,
  typography,
}: {
  title: string;
  summary: string;
  sourceHost: string;
  profile: DesignSystemProfile;
  typography: Props["typography"];
}) {
  const corpus = [
    title,
    summary,
    sourceHost,
    profile.systemName,
    profile.archetype,
    profile.visualThesis,
    profile.evidenceSummary.join(" "),
    typography.primary,
    typography.display,
    typography.mono,
  ]
    .join(" ")
    .toLowerCase();
  return sourceHost.includes("vercel.com") && (corpus.includes("ship") || corpus.includes("agent") || corpus.includes("mono"));
}

function isImmersivePreview({ summary, sourceHost, profile }: { summary: string; sourceHost: string; profile: DesignSystemProfile }) {
  const corpus = [summary, sourceHost, profile.archetype, profile.visualThesis, profile.previewStrategy?.renderer, profile.evidenceSummary.join(" ")]
    .join(" ")
    .toLowerCase();
  return /immersive|webgl|webgpu|threejs|three\.js|audio reactive|dither|fluid|bloom|canvas|enable audio|click to enter/.test(corpus);
}

function isConsumerWalletPreview({ summary, sourceHost, profile }: { summary: string; sourceHost: string; profile: DesignSystemProfile }) {
  const corpus = [summary, sourceHost, profile.archetype, profile.visualThesis, profile.previewStrategy?.renderer, profile.evidenceSummary.join(" ")]
    .join(" ")
    .toLowerCase();
  return /consumer crypto wallet|money app|phantom|crypto|wallet|trading tools|prediction|perps|self-custodial|download phantom|spend, send/.test(corpus);
}

function isTypeSpecimenPreview({ summary, sourceHost, profile }: { summary: string; sourceHost: string; profile: DesignSystemProfile }) {
  const corpus = [summary, sourceHost, profile.archetype, profile.visualThesis, profile.previewStrategy?.renderer, profile.evidenceSummary.join(" ")]
    .join(" ")
    .toLowerCase();
  return /type-specimen|type foundry|variable font|font specimen|type tester|gt mechanik|mono.*semi.*poly|inktraps|oversized dots/.test(corpus);
}

function PptSlidePreview({
  slug,
  title,
  summary,
  sourceHost,
  sourceMode,
  profile,
  colors,
  typography,
}: {
  slug: string;
  title: string;
  summary: string;
  sourceHost: string;
  sourceMode: IngestMode;
  profile: DesignSystemProfile;
  colors: ColorTokenSet;
  typography: Props["typography"];
}) {
  if (slug.length > 0) {
    return (
      <div className="mt-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {PPT_TEMPLATE_PREVIEWS.map((template) => (
          <div key={template.key} className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
              <div>
                <div className="font-semibold text-foreground">{template.label}</div>
                <div className="mt-0.5 text-[11px] text-muted">{template.hint}</div>
              </div>
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{template.key}</span>
            </div>
            <ScaledPreviewFrame
              ariaLabel={`${title} PPT ${template.label}样张`}
              canvasHeight={630}
              canvasWidth={1120}
              className="rounded-md border border-line shadow-inner"
              src={`/api/designs/${slug}/preview?kind=ppt&slide=${template.key}`}
              title={`${title} PPT ${template.label}样张`}
            />
          </div>
        ))}
      </div>
    );
  }

  const sourceLabel =
    sourceMode === "canva-template"
      ? "Canva 模板"
      : sourceMode === "canva-editor"
        ? "Canva 编辑器"
        : sourceMode === "design-system-project"
          ? "项目导入"
          : sourceMode === "clone-website"
            ? "Clone 接力"
            : "URL 导入";
  const consumerWallet = isConsumerWalletPreview({ summary, sourceHost, profile });
  const typeSpecimen = isTypeSpecimenPreview({ summary, sourceHost, profile });
  const immersive = isImmersivePreview({ summary, sourceHost, profile });
  const darkEvent = isDarkEventPreview({ title, summary, sourceHost, profile, typography });
  const heroHeading = getProfileHeading(profile, title);
  const semanticColors = {
    surface: profile.colorRoles.background || colors.surface,
    text: profile.colorRoles.text || colors.text,
    primary: profile.colorRoles.brandPrimary || colors.primary,
    secondary: profile.colorRoles.brandSecondary || colors.secondary,
  };

  if (consumerWallet) {
    return (
      <div className="mt-4 grid gap-3">
        <div className="overflow-hidden rounded-lg border border-[#e2dffe] bg-[#fffdf8] p-2 shadow-inner">
          <div className="aspect-video overflow-hidden rounded-[22px] bg-[#fffdf8] text-[#3c315b] shadow-sm" style={{ fontFamily: typography.primary }}>
            <div className="relative h-full w-full overflow-hidden p-5">
              <div className="flex items-center justify-between">
                <div className="text-[18px] font-black tracking-[-0.08em]">phantom</div>
                <div className="rounded-full bg-[#ab9ff2] px-4 py-1.5 text-[9px] font-bold">Download</div>
              </div>
              <div className="absolute bottom-5 left-5 right-5 top-16 overflow-hidden rounded-[24px] bg-[#111]">
                <div className="absolute inset-y-0 left-0 w-[22%] bg-[#884417]" aria-hidden="true" />
                <div className="absolute bottom-0 left-[8%] top-0 w-px bg-orange-400/50" aria-hidden="true" />
                <div className="absolute bottom-8 right-[8%] top-0 w-px bg-emerald-300/35" aria-hidden="true" />
                <div className="relative z-10 grid h-full place-items-center px-8 text-center">
                  <div>
                    <div className="mb-2 text-[8px] font-bold text-[#f4f0ff]">{heroHeading}</div>
                    <h4 className="text-[29px] font-black leading-[1.02] tracking-[-0.075em] text-white">
                      {summary}
                    </h4>
                    <div className="mx-auto mt-4 inline-flex rounded-full bg-[#e7e1ff] px-4 py-2 text-[9px] font-bold text-[#3c315b]">Download Phantom</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">抽象依据</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">薰衣草品牌场 + 黑色产品舞台 + ghost wordmark。</div>
          </div>
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">PPT 迁移</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">围绕下载、交易、支付、安全模块组织。</div>
          </div>
        </div>
      </div>
    );
  }

  if (typeSpecimen) {
    return (
      <div className="mt-4 grid gap-3">
        <div className="overflow-hidden rounded-lg border border-[#0b6c00] bg-[#cce3da] p-2 shadow-inner">
          <div
            className="aspect-video overflow-hidden border border-[#0b6c00] bg-[#f9f9f7] text-[#0b6c00] shadow-sm"
            style={{
              fontFamily: typography.primary,
              backgroundImage: "linear-gradient(#cce3da 1px, transparent 1px), linear-gradient(90deg, #cce3da 1px, transparent 1px)",
              backgroundSize: "34px 34px",
            }}
          >
            <div className="flex h-full flex-col justify-between p-5">
              <div className="flex items-center justify-between text-[9px] font-black">
                <span>{sourceHost}</span>
                <span className="rounded-full border border-[#0b6c00] bg-[#e8f80d] px-3 py-1">Type Tester</span>
              </div>
              <div>
                <h4 className="text-[54px] font-black uppercase leading-[0.72]" style={{ fontFamily: typography.display }}>
                  GT
                  <br />
                  Mechanik
                </h4>
                <div className="mt-4 flex gap-2 text-[8px] font-black">
                  <span className="rounded-full border border-[#0b6c00] bg-[#f9f9f7] px-2 py-1">Mono</span>
                  <span className="rounded-full border border-[#0b6c00] bg-[#ff4cb2] px-2 py-1 text-black">Semi</span>
                  <span className="rounded-full border border-[#0b6c00] bg-[#6995ec] px-2 py-1 text-black">Poly</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">抽象依据</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">变量字体试样、薄荷网格、墨绿色文字和轴控件。</div>
          </div>
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">PPT 迁移</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">围绕 Mono / Semi / Poly、Type Tester、字形试样组织。</div>
          </div>
        </div>
      </div>
    );
  }

  if (immersive) {
    return (
      <div className="mt-4 grid gap-3">
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-black p-2 shadow-inner">
          <div className="aspect-video overflow-hidden border border-zinc-800 bg-black text-white shadow-sm" style={{ fontFamily: typography.primary }}>
            <div className="relative h-full w-full overflow-hidden">
              <div
                className="absolute inset-0 opacity-45"
                style={{
                  background:
                    "repeating-linear-gradient(90deg, rgba(255,255,255,.18) 0 1px, transparent 1px 7px), repeating-linear-gradient(0deg, rgba(255,255,255,.12) 0 1px, transparent 1px 9px)",
                  mixBlendMode: "screen",
                }}
                aria-hidden="true"
              />
              <div className="absolute left-4 right-4 top-3 grid grid-cols-3 text-[7px] font-bold uppercase tracking-[-0.05em] text-white">
                <span>Robert Borghesi / Lab</span>
                <span className="text-center">ASTRO DITHER</span>
                <span className="text-right">{sourceHost}</span>
              </div>
              <div className="absolute left-6 top-1/2 -translate-y-1/2 bg-black/60 px-2.5 py-2 text-[9px] font-bold uppercase tracking-[-0.08em]">
                [:: click to enter + enable audio ::]
              </div>
              <h4 className="absolute bottom-7 right-5 text-right text-[44px] font-black uppercase leading-[0.76] tracking-[-0.12em]" style={{ fontFamily: typography.display }}>
                ASTRO
                <br />
                DITHER
              </h4>
              <div className="absolute bottom-3 left-4 right-4 grid grid-cols-3 text-[7px] font-bold uppercase tracking-[-0.05em] text-white">
                <span>00:00:00</span>
                <span className="text-center">hold for speed</span>
                <span className="text-right">1:00x</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">抽象依据</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">全屏 canvas、黑底 HUD、音频入口。</div>
          </div>
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">PPT 迁移</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">保留 dither / bloom / fluid 的实验感。</div>
          </div>
        </div>
      </div>
    );
  }

  if (darkEvent) {
    return (
      <div className="mt-4 grid gap-3">
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-black p-2 shadow-inner">
          <div className="aspect-video overflow-hidden border border-zinc-800 bg-black text-white shadow-sm" style={{ fontFamily: typography.primary }}>
            <div className="relative h-full w-full overflow-hidden">
              <div className="absolute left-4 right-4 top-3 flex justify-between text-[7px] tracking-[0.12em] text-zinc-300">
                <span>Speakers / Schedule / FAQ</span>
                <span>Ship</span>
                <span>Ticket</span>
              </div>
              <div className="absolute left-1/2 top-[18%] grid -translate-x-1/2 gap-1.5">
                {[1, 3, 5].map((count) => (
                  <div key={count} className="flex justify-center gap-2">
                    {Array.from({ length: count }).map((_, index) => (
                      <span key={`${count}-${index}`} className="grid h-2.5 w-3 place-items-center border border-zinc-500 text-[4px] leading-none text-zinc-200">
                        AI
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <h4
                className="absolute bottom-5 left-5 max-w-[58%] text-[27px] font-medium leading-[0.9] tracking-[-0.075em] text-white"
                style={{ fontFamily: typography.display }}
              >
                {heroHeading}
              </h4>
              <div className="absolute bottom-5 right-5 bg-surface px-3 py-2 text-[8px] font-semibold text-black">Get your ticket -&gt;</div>
            </div>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">抽象依据</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">黑底舞台、mono 导航、极细线框。</div>
          </div>
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">PPT 迁移</div>
            <div className="mt-2 text-sm font-semibold leading-5 text-foreground">保留事件页的信息密度和冷峻节奏。</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-3">
      <div className="overflow-hidden rounded-lg border border-line bg-surface-muted p-2 shadow-inner">
        <div className="aspect-video overflow-hidden rounded-md border border-line bg-surface shadow-sm">
          <div className="relative h-full w-full overflow-hidden" style={{ background: semanticColors.surface, color: semanticColors.text, fontFamily: typography.primary }}>
            <div
              className="absolute inset-y-0 right-0 w-[36%]"
              style={{ background: `linear-gradient(135deg, ${semanticColors.primary}, ${semanticColors.secondary})` }}
              aria-hidden="true"
            />
            <div className="absolute right-[31%] top-[12%] h-10 w-24 rounded-full opacity-15 blur-2xl" style={{ background: semanticColors.primary }} aria-hidden="true" />
            <div className="relative z-10 flex h-full w-[70%] flex-col justify-center p-5 sm:p-6">
              <div className="text-[9px] font-semibold uppercase tracking-[0.2em]" style={{ color: semanticColors.primary }}>
                PPT 衍生预览
              </div>
              <h4 className="mt-2 line-clamp-2 text-2xl font-semibold leading-[1.08] tracking-[-0.035em] sm:text-[28px]" style={{ fontFamily: typography.display }}>
                {title}
              </h4>
              <p className="mt-2 line-clamp-2 text-[11px] leading-4 opacity-70 sm:text-xs sm:leading-5">{summary}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={{ background: `${semanticColors.primary}1f`, color: semanticColors.primary }}>
                  {sourceHost}
                </span>
                <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={{ background: `${semanticColors.primary}1f`, color: semanticColors.primary }}>
                  {sourceLabel}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface-muted p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">章节页</div>
          <div className="mt-2 text-sm font-semibold leading-5 text-foreground">标题强对比，正文保持窄行宽。</div>
        </div>
        <div className="rounded-lg border border-line bg-surface-muted p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">色彩节奏</div>
          <div className="mt-2 flex gap-2">
            {[semanticColors.primary, semanticColors.secondary, semanticColors.surface].map((color) => (
              <span key={color} className="h-6 flex-1 rounded-md border border-line" style={{ background: color }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function packageTypeLabel(value: DesignSystemPackageManifest["packageType"]) {
  if (value === "component-system") return "组件系统";
  if (value === "presentation-system") return "演示系统";
  if (value === "agent-skill-package") return "Agent Skill 包";
  return "视觉系统";
}

function capabilityCategoryLabel(value: DesignSystemCapability["category"]) {
  if (value === "component") return "组件";
  if (value === "layout") return "布局";
  if (value === "pattern") return "模式";
  if (value === "token") return "Token";
  if (value === "asset") return "素材";
  if (value === "workflow") return "工作流";
  return "适配";
}

function AgentSkillPanel({
  agentSkillReference,
  capabilities,
  executionReference,
  manifest,
  routerSkillPath,
}: {
  agentSkillReference?: string;
  capabilities: DesignSystemCapability[];
  executionReference: string;
  manifest?: DesignSystemPackageManifest | null;
  routerSkillPath: string;
}) {
  if (!manifest) {
    const copyItems = [
      { label: "复制 Router 引用语", value: executionReference },
      { label: "复制 Router Skill 路径", value: routerSkillPath },
    ];
    return (
      <article className="rounded-lg border border-line bg-surface p-5 shadow-sm">
        <div className="flex items-center gap-2 dv-eyebrow">
          <Bot size={14} aria-hidden="true" />
          Design Vault Router Skill
        </div>
        <h3 className="mt-2 text-base font-semibold text-foreground">这条记录可通过 Router Skill 调用</h3>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">网站导入记录不一定有独立 wrapper skill，但仍会生成 PRODUCT、DESIGN、STYLE_CARD、反模式和质量门。外部 agent 应先读取 Router Skill，再读取这些执行协议文件。</p>
        <div className="mt-4">
          <CopyButtons items={copyItems} />
        </div>
      </article>
    );
  }

  const copyItems = [
    { label: "复制 Router 引用语", value: executionReference },
    { label: "复制引用语", value: agentSkillReference ?? manifest.skill.referencePrompt },
    { label: "复制安装命令", value: manifest.skill.installCommand },
    { label: "复制 SKILL.md 路径", value: manifest.skill.entrypoint },
    { label: "复制 Router Skill 路径", value: routerSkillPath },
    { label: "复制通用入口语", value: `请先读取 ${manifest.skill.entrypoint}，把它作为本次设计系统规则入口，再按 manifest 和 capabilities 选择组件、布局或工作流。` },
  ];

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <div className="flex items-center gap-2 dv-eyebrow">
              <Bot size={14} aria-hidden="true" />
              Agent Skill
            </div>
            <h3 className="font-serif mt-2 text-[19px] font-semibold leading-tight text-foreground">{manifest.name}</h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{manifest.summary}</p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-accent px-2.5 py-1 font-semibold text-white">{packageTypeLabel(manifest.packageType)}</span>
              {manifest.secondaryTypes.map((item) => (
                <span key={item} className="rounded-md bg-accent-soft px-2.5 py-1 font-semibold text-accent-strong">
                  {packageTypeLabel(item)}
                </span>
              ))}
              <span className="rounded-md border border-line bg-surface-muted px-2.5 py-1 font-semibold text-muted">可信度 {manifest.confidence}</span>
              <span className="rounded-md border border-line bg-surface-muted px-2.5 py-1 font-semibold text-muted">License {manifest.source.license}</span>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">快捷复制</div>
            <div className="mt-3">
              <CopyButtons items={copyItems} />
            </div>
          </div>
        </div>
      </article>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
          <div className="flex items-center gap-2 dv-eyebrow">
            <Component size={14} aria-hidden="true" />
            能力索引
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {capabilities.map((capability) => (
              <div key={capability.id} className="rounded-lg border border-line bg-surface-muted p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{capabilityCategoryLabel(capability.category)}</span>
                  <code className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent-strong">{capability.id}</code>
                </div>
                <div className="mt-3 text-sm font-semibold text-foreground">{capability.label}</div>
                <p className="mt-2 text-sm leading-6 text-muted">{capability.description}</p>
                <p className="mt-2 text-xs leading-5 text-muted">
                  <span className="font-semibold text-foreground">调用：</span>
                  {capability.usage}
                </p>
                {capability.sourcePaths.length ? <div className="mt-3 truncate text-[11px] text-muted">{capability.sourcePaths.slice(0, 2).join(" / ")}</div> : null}
              </div>
            ))}
          </div>
        </article>

        <aside className="grid gap-4 xl:sticky xl:top-7 xl:self-start">
          <article className="rounded-lg border border-line bg-surface p-4 shadow-sm">
            <div className="dv-eyebrow">引用方式</div>
            <div className="mt-3 grid gap-3 text-sm leading-6 text-muted">
              <div className="rounded-lg border border-line bg-surface-muted p-3">
                <div className="text-xs font-semibold text-foreground">一次性引用</div>
                <p className="mt-1">把“复制引用语”粘进其他 agent。适合临时任务，要求 agent 能读取本机路径。</p>
              </div>
              <div className="rounded-lg border border-line bg-surface-muted p-3">
                <div className="text-xs font-semibold text-foreground">安装到 Codex</div>
                <p className="mt-1">执行安装命令后，可用 skill 名称触发：{manifest.skill.name}。</p>
              </div>
              <div className="rounded-lg border border-line bg-surface-muted p-3">
                <div className="text-xs font-semibold text-foreground">通用文件引用</div>
                <p className="mt-1">不支持 skill 的应用先读取 Router Skill，再读取 PRODUCT、DESIGN、STYLE_CARD、反模式和质量门。</p>
              </div>
            </div>
          </article>

          <article className="rounded-lg border border-line bg-surface p-4 shadow-sm">
            <div className="dv-eyebrow">适用 / 不适用</div>
            <div className="mt-3 grid gap-3">
              <div className="rounded-lg border border-line bg-surface-muted p-3">
                <div className="text-xs font-semibold text-foreground">适合</div>
                <ul className="mt-2 grid gap-1 text-sm leading-6 text-muted">
                  {manifest.bestFor.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-line bg-surface-muted p-3">
                <div className="text-xs font-semibold text-foreground">不适合</div>
                <ul className="mt-2 grid gap-1 text-sm leading-6 text-muted">
                  {manifest.notFor.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </article>

          <article className="rounded-lg border border-line bg-surface p-4 shadow-sm">
            <div className="dv-eyebrow">本地安装</div>
            <p className="mt-2 text-sm leading-6 text-muted">Design Vault 只生成本地 skill 包，不会自动写入全局 agent 目录。</p>
            <pre className="mt-3 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100">{manifest.skill.installCommand}</pre>
            <div className="mt-3 grid gap-1 text-xs leading-5 text-muted">
              <div>
                <span className="font-semibold text-foreground">入口：</span>
                {manifest.skill.entrypoint}
              </div>
              <div>
                <span className="font-semibold text-foreground">Vendor：</span>
                {manifest.local.vendorDir}
              </div>
            </div>
          </article>

          {manifest.riskNotes.length ? (
            <article className="rounded-lg border border-[color:var(--warning)]/25 bg-[color:var(--warning-soft)] p-4 text-sm leading-6 text-[color:var(--warning)] shadow-[var(--shadow-xs)]">
              <div className="font-semibold">风险提示</div>
              <ul className="mt-2 grid gap-1">
                {manifest.riskNotes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function TagManager({
  capabilities,
  packageManifest,
  profile,
  slug,
  sourceMode,
  tags,
}: {
  capabilities: DesignSystemCapability[];
  packageManifest?: DesignSystemPackageManifest | null;
  profile: DesignSystemProfile;
  slug: string;
  sourceMode: IngestMode;
  tags?: string[];
}) {
  const router = useRouter();
  const [customTags, setCustomTags] = useState(() => normalizeTags(tags ?? []));
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const systemTags = useMemo(() => {
    const customKeys = new Set(customTags.map((tag) => tag.toLowerCase()));
    return systemDesignTags({
      sourceMode,
      packageManifest: packageManifest ?? undefined,
      capabilities,
      profile,
    }).filter((tag) => !customKeys.has(tag.toLowerCase()));
  }, [capabilities, customTags, packageManifest, profile, sourceMode]);

  function addDraftTag() {
    const tag = normalizeTag(draft);
    if (!tag) return;
    setCustomTags((current) => normalizeTags([...current, tag]));
    setDraft("");
    setStatus("idle");
    setError(null);
  }

  async function saveTags(nextTags = customTags) {
    setStatus("saving");
    setError(null);
    try {
      const response = await fetch(`/api/designs/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: nextTags }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "保存标签失败。");
      }
      const updated = (await response.json()) as { tags?: string[] };
      setCustomTags(normalizeTags(updated.tags ?? nextTags));
      setStatus("saved");
      router.refresh();
    } catch (saveError) {
      setStatus("error");
      setError(saveError instanceof Error ? saveError.message : "保存标签失败。");
    }
  }

  return (
    <div className="mt-4 rounded-md border border-line bg-surface-muted/60 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 dv-eyebrow">
            <Tag size={12} aria-hidden="true" />
            标签管理
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {customTags.length ? (
              customTags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/30 bg-accent-soft px-2 text-[11.5px] font-medium text-accent-strong"
                >
                  {tag}
                  <button
                    aria-label={`移除标签 ${tag}`}
                    className="rounded-sm p-0.5 text-accent-strong/60 transition hover:bg-accent/15 hover:text-accent-strong"
                    type="button"
                    onClick={() => {
                      setCustomTags((current) => current.filter((item) => item !== tag));
                      setStatus("idle");
                    }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))
            ) : (
              <span className="inline-flex h-7 items-center rounded-md border border-dashed border-line bg-surface px-2 text-[11.5px] text-[color:var(--faint)]">
                暂无自定义标签
              </span>
            )}
            {systemTags.slice(0, 8).map((tag) => (
              <span
                key={tag}
                className="inline-flex h-7 items-center rounded-md border border-line bg-surface px-2 text-[11.5px] text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            addDraftTag();
          }}
        >
          <label className="sr-only" htmlFor="design-tag-input">
            新增标签
          </label>
          <input
            id="design-tag-input"
            className="h-8 w-[180px] rounded-md border border-line bg-surface px-2.5 text-[12.5px] text-foreground transition placeholder:text-[color:var(--faint)]/70 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft"
            placeholder="自定义标签…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-[12px] font-semibold text-muted transition hover:border-accent/40 hover:text-foreground"
            type="submit"
          >
            <Plus size={12} aria-hidden="true" />
            添加
          </button>
          <button
            className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-[12px] font-semibold text-white shadow-[var(--shadow-xs)] transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            disabled={status === "saving"}
            type="button"
            onClick={() => saveTags()}
          >
            <Save size={12} aria-hidden="true" />
            {status === "saving" ? "保存中" : status === "saved" ? "已保存" : "保存"}
          </button>
        </form>
      </div>
      {status === "error" && error ? (
        <div className="mt-2 text-[11px] font-medium text-[color:var(--danger)]">{error}</div>
      ) : null}
    </div>
  );
}

export function DesignWorkbench({
  slug,
  title,
  summary,
  sourceUrl,
  sourceHost,
  sourceMode,
  requestedSourceUrl,
  sourceChain,
  designMd,
  productMd,
  designSpecMd,
  themeMd,
  evidencePath,
  designPath,
  productPath,
  designSpecPath,
  styleCardPath,
  antiPatternsPath,
  qualityGatesPath,
  routerSkillPath,
  themePath,
  createSlideReference,
  agentSkillReference,
  executionReference,
  profile,
  packageManifest,
  capabilities = [],
  tags = [],
  colors,
  typography,
  assets,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>("preview");
  const semanticPalette = useMemo(() => buildSemanticPalette(profile), [profile]);

  const groupedActions = useMemo(
    () => {
      const groups = [
        {
          title: "执行协议",
          icon: Bot,
          items: [
            { label: "复制 Router 引用语", value: executionReference },
            { label: "复制 PRODUCT.md 路径", value: productPath },
            { label: "复制 DESIGN.md 路径", value: designSpecPath },
            { label: "复制 STYLE_CARD.html 路径", value: styleCardPath },
            { label: "复制反模式路径", value: antiPatternsPath },
            { label: "复制质量门路径", value: qualityGatesPath },
            { label: "复制 Router Skill 路径", value: routerSkillPath },
          ],
        },
        {
          title: "文档",
          icon: FileText,
          items: [
            { label: "复制 design.md", value: designMd },
            { label: "复制设计文件路径", value: designPath },
          ],
        },
        {
          title: "证据",
          icon: ClipboardList,
          items: [{ label: "复制证据文件路径", value: evidencePath }],
        },
        {
          title: "create-slide",
          icon: Presentation,
          items: [
            { label: "复制 theme 路径", value: themePath },
            { label: "复制引用语", value: createSlideReference },
          ],
        },
      ];
      if (packageManifest) {
        groups.push({
          title: "Agent Skill",
          icon: Bot,
          items: [
            { label: "复制 SKILL.md 路径", value: packageManifest.skill.entrypoint },
            { label: "复制引用语", value: agentSkillReference ?? packageManifest.skill.referencePrompt },
          ],
        });
      }
      return groups;
    },
    [
      agentSkillReference,
      antiPatternsPath,
      createSlideReference,
      designMd,
      designPath,
      designSpecPath,
      evidencePath,
      executionReference,
      packageManifest,
      productPath,
      qualityGatesPath,
      routerSkillPath,
      styleCardPath,
      themePath,
    ],
  );

  return (
    <section className="grid gap-4">
      <article className="panel-shadow rounded-lg border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          {/* Title block — eyebrow + title only; description deleted as noise. */}
          <div>
            <div className="flex items-center gap-2 dv-eyebrow">
              <Layers size={13} aria-hidden="true" />
              工作台
            </div>
            <h2 className="font-serif mt-1 text-[22px] font-semibold leading-none tracking-[-0.01em] text-foreground">
              设计系统<span className="italic text-accent">详情工作台</span>
            </h2>
          </div>

          {/* Tab strip — calm accent-soft active, icon-in-accent for continuity. */}
          <div className="grid gap-1.5 sm:grid-cols-2 xl:min-w-[760px] xl:grid-cols-5" role="tablist" aria-label="工作台视图">
            {TAB_META.map((tab) => {
              const active = tab.key === activeTab;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  aria-pressed={active}
                  className={`grid min-h-12 grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-md border px-3 py-2 text-left transition ${
                    active
                      ? "border-accent/60 bg-accent-soft text-accent-strong"
                      : "border-line bg-surface text-foreground hover:border-accent/30 hover:bg-surface-muted"
                  }`}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                >
                  <Icon
                    size={15}
                    className={active ? "text-accent" : "text-[color:var(--soft)]"}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-semibold leading-tight">{tab.label}</span>
                    <span
                      className={`mt-0.5 block truncate text-[10.5px] leading-tight ${
                        active ? "text-accent-strong/75" : "text-muted"
                      }`}
                    >
                      {tab.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <TagManager capabilities={capabilities} packageManifest={packageManifest} profile={profile} slug={slug} sourceMode={sourceMode} tags={tags} />
      </article>

      {activeTab === "preview" ? (
        <div className="grid gap-4">
          <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2 dv-eyebrow">
                  <Presentation size={14} aria-hidden="true" />
                  辅助预览
                </div>
                <h3 className="mt-1 text-base font-semibold text-foreground">PPT 衍生预览</h3>
              </div>
              <a
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent/40 hover:text-accent"
                href={`/api/designs/${slug}/preview?kind=ppt`}
                rel="noreferrer"
                target="_blank"
              >
                HTML
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            </div>
            <PptSlidePreview slug={slug} title={title} summary={summary} sourceHost={sourceHost} sourceMode={sourceMode} profile={profile} colors={colors} typography={typography} />
          </article>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.32fr)]">
            <div className="grid gap-4">
              <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 dv-eyebrow">
                      <Monitor size={14} aria-hidden="true" />
                      主预览
                    </div>
                    <h3 className="mt-1 text-base font-semibold text-foreground">网页衍生预览</h3>
                  </div>
                  <div className="text-xs text-muted">当前条目的主舞台</div>
                </div>
                <ScaledPreviewFrame
                  className="mt-4 rounded-lg border border-line shadow-inner"
                  src={`/api/designs/${slug}/preview?kind=card&surface=web`}
                  title="网页风格样张"
                />
              </article>
              <ProjectDemoGallery assets={assets} slug={slug} sourceUrl={sourceUrl} title={title} />
            </div>

            <aside className="grid gap-4 xl:sticky xl:top-7 xl:self-start">
              <article className="rounded-lg border border-line bg-surface p-4 shadow-sm">
                <div className="dv-eyebrow">Open-slide 指引</div>
                <div className="mt-3 grid gap-3 text-sm leading-6 text-muted">
                  <div>
                    <span className="font-semibold text-foreground">方向：</span>
                    {profile.openSlideGuidance.direction}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">封面策略：</span>
                    {profile.openSlideGuidance.coverApproach}
                  </div>
                </div>
              </article>
            </aside>
          </div>
        </div>
      ) : null}

      {activeTab === "analysis" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid gap-4">
            <SourceAudit sourceChain={sourceChain} sourceHost={sourceHost} sourceUrl={sourceUrl} requestedSourceUrl={requestedSourceUrl} />
            <SynthesisAudit profile={profile} />
            <QualityAudit profile={profile} />

            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <BarChart3 size={14} aria-hidden="true" />
                系统判断
              </div>
              <h3 className="mt-1 text-base font-semibold text-foreground">设计系统画像</h3>
              <div className="mt-4 grid gap-3 rounded-lg border border-line bg-surface-muted p-4 text-sm leading-7 text-muted">
                <div>
                  <span className="font-semibold text-foreground">视觉论点：</span>
                  {profile.visualThesis}
                </div>
                <div>
                  <span className="font-semibold text-foreground">系统类型：</span>
                  {profile.archetype}
                </div>
                <div>
                  <span className="font-semibold text-foreground">可信度：</span>
                  {profile.confidence}
                </div>
              </div>
            </article>

            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <Component size={14} aria-hidden="true" />
                组件与交互
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {profile.componentSignatures.map((item, index) => (
                  <div key={`${item.name}-${item.role}-${index}`} className="rounded-lg border border-line bg-surface-muted p-4">
                    <div className="text-sm font-semibold text-foreground">{item.name}</div>
                    <div className="mt-2 text-sm leading-6 text-muted">{item.role}</div>
                    <ul className="mt-3 space-y-1 text-sm leading-6 text-muted">
                      {item.traits.map((trait, traitIndex) => (
                        <li key={`${item.name}-${trait}-${traitIndex}`} className="flex gap-2">
                          <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-accent" aria-hidden="true" />
                          <span>{trait}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <ClipboardList size={14} aria-hidden="true" />
                证据摘要
              </div>
              <ul className="mt-3 grid gap-2 text-sm leading-7 text-muted">
                {profile.evidenceSummary.map((item) => (
                  <li key={item} className="rounded-lg border border-line bg-surface-muted px-3 py-2">
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          </div>

          <aside className="grid gap-4 xl:sticky xl:top-7 xl:self-start">
            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <Palette size={14} aria-hidden="true" />
                语义配色
              </div>
              <p className="mt-2 text-sm leading-6 text-muted">来自 AI 画像的角色判断；源码 token 只作为证据，不直接等同于设计系统。</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {semanticPalette.map((item) => (
                  <div key={item.key} className="rounded-lg border border-line bg-surface-muted p-3">
                    <div className="h-12 rounded-md border border-line shadow-inner" style={{ background: item.value }} />
                    <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{item.key}</div>
                    <div className="mt-1 truncate text-xs font-medium text-foreground">{item.value}</div>
                    <div className="mt-2 text-xs leading-5 text-muted">
                      <span className="font-medium text-foreground">{item.label}</span>
                      <span className="block">{item.note}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-lg border border-line bg-surface-muted p-3 text-xs leading-5 text-muted">
                {profile.colorRoles.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
              <details className="mt-3 rounded-lg border border-line bg-surface p-3">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-muted">原始抽取 token</summary>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {Object.entries(colors).map(([key, color]) => (
                    <div key={key} className="rounded-md border border-line bg-surface-muted p-2">
                      <div className="h-7 rounded border border-line" style={{ background: color }} />
                      <div className="mt-1 truncate text-[10px] uppercase tracking-[0.12em] text-muted">{key}</div>
                      <div className="truncate text-[11px] font-medium text-foreground">{color}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-muted">这些是源码 / CSS 候选值，用来回溯证据；是否成为设计系统角色由上方语义配色决定。</p>
              </details>
            </article>

            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <Type size={14} aria-hidden="true" />
                字体
              </div>
              <div className="mt-3 grid gap-2 rounded-lg border border-line bg-surface-muted p-4 text-sm leading-7 text-muted">
                <div>
                  <span className="font-semibold text-foreground">主字体：</span>
                  {typography.primary}
                </div>
                <div>
                  <span className="font-semibold text-foreground">展示字体：</span>
                  {typography.display}
                </div>
                <div>
                  <span className="font-semibold text-foreground">等宽字体：</span>
                  {typography.mono}
                </div>
                <div>
                  <span className="font-semibold text-foreground">字号节奏：</span>
                  {typography.scale.join(" / ")}
                </div>
              </div>
            </article>
          </aside>
        </div>
      ) : null}

      {activeTab === "skill" ? (
        <AgentSkillPanel
          agentSkillReference={agentSkillReference}
          capabilities={capabilities}
          executionReference={executionReference}
          manifest={packageManifest}
          routerSkillPath={routerSkillPath}
        />
      ) : null}

      {activeTab === "docs" ? (
        <section className="grid gap-4">
          <details className="rounded-lg border border-line bg-surface p-4 shadow-sm">
            <summary className="flex cursor-pointer list-none flex-col gap-3 [&::-webkit-details-marker]:hidden sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="dv-eyebrow">快捷动作</div>
                <h3 className="mt-1 text-base font-semibold text-foreground">复制下游流程所需内容</h3>
              </div>
              <span className="rounded-md border border-line bg-surface-muted px-2 py-1 text-xs font-semibold text-muted">展开</span>
            </summary>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {groupedActions.map((group) => {
                const Icon = group.icon;
                return (
                  <div key={group.title} className="rounded-lg border border-line bg-surface-muted p-3">
                    <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                      <Icon size={15} aria-hidden="true" />
                      {group.title}
                    </div>
                    <CopyButtons items={group.items} />
                  </div>
                );
              })}
            </div>
          </details>

          <div className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <Bot size={14} aria-hidden="true" />
                PRODUCT.md
              </div>
              <h3 className="mt-1 text-base font-semibold text-foreground">产品与适配边界</h3>
              <pre className="mt-4 max-h-[520px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100 sm:p-5 sm:text-sm">{productMd || "旧记录尚未生成 PRODUCT.md，重新导入后会补全。"}</pre>
            </article>
            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <ClipboardList size={14} aria-hidden="true" />
                DESIGN.md
              </div>
              <h3 className="mt-1 text-base font-semibold text-foreground">Agent 可执行设计协议</h3>
              <pre className="mt-4 max-h-[520px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100 sm:p-5 sm:text-sm">{designSpecMd || "旧记录尚未生成 DESIGN.md，重新导入后会补全。"}</pre>
            </article>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <FileText size={14} aria-hidden="true" />
                design.md
              </div>
              <h3 className="mt-1 text-base font-semibold text-foreground">设计系统文档</h3>
              <pre className="mt-4 max-h-[720px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100 sm:p-5 sm:text-sm">{designMd}</pre>
            </article>
            <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
              <div className="flex items-center gap-2 dv-eyebrow">
                <Presentation size={14} aria-hidden="true" />
                open-slide theme
              </div>
              <h3 className="mt-1 text-base font-semibold text-foreground">演示稿主题导出</h3>
              <pre className="mt-4 max-h-[720px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100 sm:p-5 sm:text-sm">{themeMd}</pre>
            </article>
          </div>
        </section>
      ) : null}

      {activeTab === "assets" ? (
        <section className="grid gap-4">
          <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2 dv-eyebrow">
                  <Boxes size={14} aria-hidden="true" />
                  素材包
                </div>
                <h3 className="mt-1 text-base font-semibold text-foreground">品牌与图标素材</h3>
              </div>
              <div className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-muted">
                共 <span className="tabular-nums font-semibold text-foreground">{assets.length}</span> 项
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {assets.map((asset) => {
                return (
                  <a
                    key={asset.path}
                    className="rounded-lg border border-line bg-surface-muted p-3 transition hover:border-accent/40 hover:bg-surface hover:shadow-sm"
                    href={assetPublicUrl(slug, asset)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <div className="flex h-28 items-center justify-center rounded-lg border border-line bg-surface p-3">
                      <AssetThumbnail alt={asset.name} kind={asset.kind} src={assetPublicUrl(slug, asset)} />
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <ImageIcon size={14} className="text-muted" aria-hidden="true" />
                      <div className="truncate text-sm font-semibold text-foreground">{asset.name}</div>
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted">{asset.kind}</div>
                  </a>
                );
              })}
            </div>
          </article>
        </section>
      ) : null}
    </section>
  );
}
