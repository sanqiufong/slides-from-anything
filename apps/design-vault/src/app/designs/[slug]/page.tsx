import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Globe2, ShieldCheck } from "lucide-react";

import { DesignWorkbench } from "@/components/DesignWorkbench";
import { ThemeToggle } from "@/components/ThemeToggle";
import { executionReferencePrompt } from "@/lib/execution-protocol";
import {
  antiPatternsPath,
  designSpecPath,
  getDesign,
  openSlideThemePath,
  productDocPath,
  qualityGatesPath,
  readJson,
  readText,
  routerSkillPath,
  styleCardPath,
} from "@/lib/storage";
import { synthesizeLegacyProfile } from "@/lib/synthesis";
import type { DesignSystemCapability, DesignSystemPackageManifest, IngestMode } from "@/lib/types";

function modeLabel(mode: IngestMode) {
  if (mode === "canva-template") return "Canva 模板";
  if (mode === "canva-editor") return "Canva 编辑器";
  if (mode === "design-system-project") return "项目导入";
  if (mode === "clone-website") return "Clone 接力";
  return "直接网址";
}

export default async function DesignDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const design = await getDesign(slug);
  if (!design) notFound();
  const profile = design.profile ?? synthesizeLegacyProfile(design);

  const productPath = design.productPath ?? productDocPath(slug);
  const executionDesignPath = design.designSpecPath ?? designSpecPath(slug);
  const cardPath = design.styleCardPath ?? styleCardPath(slug);
  const antiPath = design.antiPatternsPath ?? antiPatternsPath(slug);
  const gatesPath = design.qualityGatesPath ?? qualityGatesPath(slug);
  const routerPath = design.routerSkillPath ?? routerSkillPath();

  const [designMd, themeMd, productMd, executionDesignMd, manifestFromFile, capabilitiesFromFile] = await Promise.all([
    readText(design.designPath),
    readText(openSlideThemePath(slug)),
    readText(productPath).catch(() => ""),
    readText(executionDesignPath).catch(() => ""),
    design.manifestPath ? readJson<DesignSystemPackageManifest>(design.manifestPath) : Promise.resolve(null),
    design.capabilitiesPath ? readJson<DesignSystemCapability[]>(design.capabilitiesPath) : Promise.resolve(null),
  ]);
  const packageManifest = design.packageManifest ?? manifestFromFile;
  const capabilities = design.capabilities ?? capabilitiesFromFile ?? [];
  const evidencePath = design.evidencePath ?? `${design.designPath}（旧条目无独立 evidence.json）`;
  const createSlideReference = `请把 ${design.openSlideThemePath} 作为这个 deck 的权威风格参考。如果需要更完整的上下文，再继续读取 ${design.designPath} 与 ${evidencePath}。严格遵循其中的配色角色、字体角色、版式特征、组件特征、动效倾向和反模式约束。`;
  const agentSkillReference =
    packageManifest?.skill.referencePrompt ??
    (design.skillPath ? `请使用 Design Vault 生成的本地 skill：先读取 ${design.skillPath}，再按 manifest 与 capabilities 选择组件、布局或工作流。` : undefined);
  const executionReference = executionReferencePrompt({
    ...design,
    profile,
    packageManifest: packageManifest ?? undefined,
    capabilities,
    productPath,
    designSpecPath: executionDesignPath,
    styleCardPath: cardPath,
    antiPatternsPath: antiPath,
    qualityGatesPath: gatesPath,
    routerSkillPath: routerPath,
  });

  return (
    <div className="app-shell min-h-screen">
      <main className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <header className="border-b border-line pb-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <Link className="mb-4 inline-flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-muted panel-shadow transition hover:border-accent/40 hover:text-accent" href="/">
                <ArrowLeft size={14} aria-hidden="true" />
                返回资料库
              </Link>

              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                  <Globe2 size={13} aria-hidden="true" />
                  {design.sourceHost}
                </span>
                <span className="rounded-md border border-accent/25 bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-strong">
                  {modeLabel(design.sourceMode)}
                </span>
                <span className="rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted">{profile.archetype}</span>
                <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted">
                  <ShieldCheck size={13} aria-hidden="true" />
                  可信度 {profile.confidence}
                </span>
                {profile.quality ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted">
                    质量 {profile.quality.score}/100
                  </span>
                ) : null}
              </div>

              <h1 className="font-serif mt-4 max-w-4xl text-[34px] font-semibold leading-[1.1] tracking-[-0.012em] text-foreground lg:text-[42px]">{design.title}</h1>
              <p className="mt-3 max-w-5xl text-[14px] leading-[1.65] text-muted md:text-[15px]">{design.summary}</p>
            </div>

            <div className="flex flex-shrink-0 flex-col gap-2 lg:items-end">
              <div className="flex items-center gap-2 lg:justify-end">
                <ThemeToggle />
              </div>
              <a className="max-w-full truncate text-xs text-muted underline-offset-4 transition hover:text-accent hover:underline lg:max-w-[360px]" href={design.sourceUrl} rel="noreferrer" target="_blank">
                {design.sourceUrl}
              </a>
              <a className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_0_rgba(180,90,59,0.18),var(--shadow-xs)] transition hover:bg-accent-strong" href={design.sourceUrl} rel="noreferrer" target="_blank">
                访问原网站
                <ExternalLink size={15} aria-hidden="true" />
              </a>
            </div>
          </div>
        </header>

        <DesignWorkbench
          assets={design.assets}
          colors={design.tokens.colors}
          createSlideReference={createSlideReference}
          agentSkillReference={agentSkillReference}
          antiPatternsPath={antiPath}
          designSpecMd={executionDesignMd}
          designSpecPath={executionDesignPath}
          designMd={designMd}
          designPath={design.designPath}
          evidencePath={evidencePath}
          executionReference={executionReference}
          profile={profile}
          productMd={productMd}
          productPath={productPath}
          packageManifest={packageManifest}
          capabilities={capabilities}
          qualityGatesPath={gatesPath}
          requestedSourceUrl={design.requestedSourceUrl}
          routerSkillPath={routerPath}
          slug={slug}
          styleCardPath={cardPath}
          sourceHost={design.sourceHost}
          sourceChain={design.sourceChain}
          sourceMode={design.sourceMode}
          sourceUrl={design.sourceUrl}
          summary={design.summary}
          tags={design.tags}
          themeMd={themeMd}
          themePath={design.openSlideThemePath}
          title={design.title}
          typography={{
            primary: design.tokens.typography.families.primary,
            display: design.tokens.typography.families.display,
            mono: design.tokens.typography.families.mono,
            scale: design.tokens.typography.scale,
          }}
        />
      </main>
    </div>
  );
}
