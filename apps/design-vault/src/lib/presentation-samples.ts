import type { PresentationStyleGuide } from "./types";

export const REQUIRED_PRESENTATION_SAMPLE_LABELS = [
  "title",
  "data",
  "image",
  "text-single",
  "text-multi",
] as const;

export function requiredPresentationSampleArchetypes(): PresentationStyleGuide["slideArchetypes"] {
  return [
    {
      name: "Title layout sample",
      use: "生成标题页样张，用来源中最可识别的层级、视觉锚点、留白密度和元信息关系证明抽象没有漂移。",
      construction: [
        "source-recognisable focal hierarchy",
        "dominant visual or source frame relationship",
        "title and subtitle roles from observed copy",
        "metadata or chrome only when present in source",
      ],
    },
    {
      name: "Data display sample",
      use: "生成数据展示样张，只使用来源证据、文件统计、能力计数或用户内容中的真实数字，不编造指标。",
      construction: [
        "real evidence counts or documented numbers",
        "source-derived emphasis order",
        "chart/table/metric treatment that follows source rhythm",
        "clear fact vs inference boundary",
      ],
    },
    {
      name: "Image display sample",
      use: "生成图片展示样张，用本地化来源素材验证图片裁切、比例、遮罩、边框、题注和图文关系。",
      construction: [
        "localized source image or source-like image slot",
        "observed crop and containment behavior",
        "caption/label placement if source supports it",
        "single image or gallery relation from source evidence",
      ],
    },
    {
      name: "Single-module text sample",
      use: "生成单模块文本样张，验证一个核心观点在该风格中的标题、正文、辅助信息和留白节奏。",
      construction: [
        "one dominant idea",
        "observed heading/body hierarchy",
        "source-like paragraph density",
        "supporting note or rule with restrained chrome",
      ],
    },
    {
      name: "Multi-module text sample",
      use: "生成多模块/流程样张，验证多个信息块、进度节点或 Agent 接力如何用图形模块重复、对齐、分组和保持来源中的节奏。",
      construction: [
        "two or more repeated modules or workflow nodes",
        "shared alignment and spacing logic",
        "diagram-first expression with connectors, status chips, or CSS icon primitives when content is process-like",
        "module labels only if source uses labels",
        "consistent hierarchy without paragraph-heavy default cards unless observed",
      ],
    },
  ];
}

/**
 * Merge required preview-sample archetypes with caller-supplied ones.
 *
 * W9.5: caller-supplied archetypes (e.g. upstream-documented layouts
 * from references/layouts*.md) go FIRST so the closed-option-set
 * renderer prompt sees them as the primary palette. Required samples
 * (Title / Data / Image / Single / Multi) follow as compatibility
 * fillers only when those slot names are missing — they're a
 * downstream-renderer expectation, not the AI's preferred choice.
 */
export function withRequiredPresentationSampleArchetypes(
  archetypes: PresentationStyleGuide["slideArchetypes"],
): PresentationStyleGuide["slideArchetypes"] {
  const required = requiredPresentationSampleArchetypes();
  const seen = new Set<string>();
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // Caller archetypes first, required appended only to fill missing
  // required-label slots (deduped by normalized name).
  const merged = [...archetypes, ...required].filter((item) => {
    const key = normalize(item.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged;
}
