import type { DesignMeta, DesignSystemPackageType, IngestMode } from "./types";

const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 28;

type TaggableDesign = Pick<DesignMeta, "sourceMode"> &
  Partial<Pick<DesignMeta, "tags" | "packageManifest" | "capabilities" | "profile">>;

export function normalizeTag(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const tag = input.replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
  return tag ? tag : null;
}

export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of input) {
    const tag = normalizeTag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

export function packageTypeTag(packageType?: DesignSystemPackageType) {
  if (packageType === "component-system") return "组件系统";
  if (packageType === "presentation-system") return "演示系统";
  if (packageType === "agent-skill-package") return "Skill 包";
  if (packageType === "visual-style-system") return "视觉系统";
  return "网站风格";
}

export function modeTag(mode: IngestMode) {
  if (mode === "canva-template") return "Canva 模板";
  if (mode === "canva-editor") return "Canva 编辑器";
  if (mode === "design-system-project") return "项目导入";
  if (mode === "clone-website") return "Clone 接力";
  return "URL 导入";
}

export function systemDesignTags(design: TaggableDesign): string[] {
  const packageType = design.packageManifest?.packageType;
  const tags = [
    packageTypeTag(packageType),
    modeTag(design.sourceMode),
    design.profile?.archetype,
    ...(design.packageManifest?.secondaryTypes ?? []).map(packageTypeTag),
    ...(design.capabilities ?? []).slice(0, 5).map((capability) => capability.id),
  ];
  return normalizeTags(tags);
}

export function effectiveDesignTags(design: TaggableDesign): string[] {
  return normalizeTags([...(design.tags ?? []), ...systemDesignTags(design)]);
}

/**
 * Tag values that duplicate the source-mode and package-type facets.
 * Filtered out when building the dedicated "tag" facet in the library UI so the
 * facet rows do not overlap.
 */
export function dimensionTagValues(): Set<string> {
  return new Set<string>([
    modeTag("url"),
    modeTag("clone-website"),
    modeTag("canva-template"),
    modeTag("canva-editor"),
    modeTag("design-system-project"),
    packageTypeTag("component-system"),
    packageTypeTag("presentation-system"),
    packageTypeTag("agent-skill-package"),
    packageTypeTag("visual-style-system"),
    packageTypeTag(undefined),
  ]);
}

/**
 * Tags suitable for the "标签" facet row: excludes redundant source-mode and
 * package-type values that have their own dimension.
 */
export function semanticDesignTags(design: TaggableDesign): string[] {
  const excluded = dimensionTagValues();
  return effectiveDesignTags(design).filter((tag) => !excluded.has(tag));
}
