import { readdir } from "node:fs/promises";

import { generateStyleCardPreview } from "../src/lib/card-preview";
import { buildDesignMd, buildOpenSlideTheme } from "../src/lib/design-md";
import { withExecutionProtocolPaths, writeExecutionProtocol, writeRouterSkill } from "../src/lib/execution-protocol";
import { buildRoleEvidence, buildStateInventory } from "../src/lib/ingestion";
import { renderPptPreview, renderWebPreview } from "../src/lib/preview";
import { evaluateDesignQuality } from "../src/lib/quality";
import {
  DESIGNS_ROOT,
  designDocPath,
  designMetaPath,
  evidencePath,
  openSlideThemePath,
  previewPath,
  profilePath,
  readJson,
  writeJson,
  writeText,
} from "../src/lib/storage";
import { synthesizeLegacyProfile } from "../src/lib/synthesis";
import type { DesignEvidence, DesignMeta, DesignSystemProfile } from "../src/lib/types";

function legacyEvidence(meta: DesignMeta): DesignEvidence {
  return {
    title: meta.title,
    sourceUrl: meta.sourceUrl,
    sourceHost: meta.sourceHost,
    sourceMode: meta.sourceMode,
    requestedSourceUrl: meta.requestedSourceUrl,
    sourceChain: meta.sourceChain,
    description: meta.summary,
    headings: [meta.title],
    buttonLabels: [],
    linkLabels: [],
    colorCandidates: Object.values(meta.tokens.colors).map((value) => ({ value, count: 1 })),
    fontCandidates: Object.values(meta.tokens.typography.families),
    domSignals: {
      headingCount: 1,
      sectionCount: 0,
      buttonCount: 0,
      linkCount: 0,
      imageCount: meta.assets.filter((asset) => asset.kind === "image").length,
      formCount: 0,
      navCount: 0,
      cardLikeCount: 0,
    },
    interactionSignals: {
      hasHoverStyles: false,
      hasAnimations: false,
      hasTransitions: false,
      hasStickyElements: false,
      hasScrollSnap: false,
      hasForms: false,
    },
    assetSummary: {
      total: meta.assets.length,
      icons: meta.assets.filter((asset) => asset.kind === "icon").length,
      images: meta.assets.filter((asset) => asset.kind === "image").length,
      logos: meta.assets.filter((asset) => asset.kind === "logo").length,
      svgs: meta.assets.filter((asset) => asset.kind === "svg").length,
      videos: meta.assets.filter((asset) => asset.kind === "video").length,
    },
    notes: [
      "Legacy evidence reconstructed from saved metadata because this entry predates the structured evidence graph.",
      "Re-ingest the original URL to capture page topology, behaviors, and responsive CSS signals.",
    ],
  };
}

async function regenerateOne(slug: string) {
  const meta = await readJson<DesignMeta>(designMetaPath(slug));
  if (!meta) return null;

  const existingProfile = await readJson<DesignSystemProfile>(profilePath(slug));
  const fallbackProfile = synthesizeLegacyProfile(meta);
  const storedProfile = existingProfile ?? meta.profile;
  const baseProfile: DesignSystemProfile = storedProfile
    ? {
        ...fallbackProfile,
        ...storedProfile,
        methodology: storedProfile.methodology ?? fallbackProfile.methodology,
        visualDna: storedProfile.visualDna ?? fallbackProfile.visualDna,
        previewStrategy: storedProfile.previewStrategy ?? fallbackProfile.previewStrategy,
        presentationStyle: storedProfile.presentationStyle ?? fallbackProfile.presentationStyle,
      }
    : fallbackProfile;
  const existingEvidence = await readJson<DesignEvidence>(evidencePath(slug));
  const baseEvidence = existingEvidence ?? legacyEvidence(meta);
  const evidence: DesignEvidence = {
    ...baseEvidence,
    roleEvidence: baseEvidence.roleEvidence ?? buildRoleEvidence(baseProfile, meta.tokens, baseEvidence),
    stateInventory: baseEvidence.stateInventory?.length ? baseEvidence.stateInventory : buildStateInventory(baseEvidence),
  };
  const baseMeta: DesignMeta = {
    ...meta,
    evidencePath: evidencePath(slug),
    profilePath: profilePath(slug),
    designPath: designDocPath(slug),
    openSlideThemePath: openSlideThemePath(slug),
    previews: { web: previewPath(slug, "web"), ppt: previewPath(slug, "ppt"), card: previewPath(slug, "card") },
    profile: baseProfile,
  };
  const webPreview = renderWebPreview(baseMeta);
  const pptPreview = renderPptPreview(baseMeta);
  const quality = evaluateDesignQuality({
    evidence,
    meta: baseMeta,
    previews: { web: webPreview, ppt: pptPreview },
    profile: baseProfile,
    tokens: meta.tokens,
  });
  const profile: DesignSystemProfile = { ...baseProfile, quality };

  await writeText(designDocPath(slug), buildDesignMd(profile, meta.sourceHost, meta.sourceMode, evidence));
  await writeText(openSlideThemePath(slug), buildOpenSlideTheme(profile));
  await writeJson(evidencePath(slug), evidence);
  await writeJson(profilePath(slug), profile);
  const updatedMeta: DesignMeta = withExecutionProtocolPaths({
    ...baseMeta,
    profile,
    updatedAt: new Date().toISOString(),
  });
  const cardPreview = await generateStyleCardPreview(updatedMeta);
  await writeText(previewPath(slug, "web"), renderWebPreview(updatedMeta));
  await writeText(previewPath(slug, "ppt"), renderPptPreview(updatedMeta));
  await writeText(previewPath(slug, "card"), cardPreview.html);
  await writeExecutionProtocol(updatedMeta, cardPreview.html);
  await writeJson(designMetaPath(slug), {
    ...updatedMeta,
  });

  return slug;
}

async function main() {
  const entries = await readdir(DESIGNS_ROOT, { withFileTypes: true });
  const slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const results: Array<string | null> = [];
  for (const slug of slugs) {
    results.push(await regenerateOne(slug));
  }
  const regenerated = results.filter(Boolean);
  await writeRouterSkill();
  console.log(`Regenerated ${regenerated.length} design document(s): ${regenerated.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
