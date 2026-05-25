import { readdir } from "node:fs/promises";

import { DESIGNS_ROOT, designMetaPath, previewPath, readJson, readText } from "../src/lib/storage";
import type { DesignMeta } from "../src/lib/types";

const strict = process.argv.includes("--strict");
const requiredPptSlides = ["title", "data", "image", "single", "multi"];

function pptSlideIds(html: string) {
  return new Set([...html.matchAll(/data-slide=["']([^"']+)/g)].map((match) => match[1]));
}

function hasRemoteMedia(html: string) {
  return /<(?:img|source|video|audio|iframe)\b[^>]+\s(?:src|srcset)\s*=\s*["']https?:\/\//i.test(html);
}

async function main() {
  const entries = await readdir(DESIGNS_ROOT, { withFileTypes: true });
  const failures: string[] = [];
  const rows: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const design = await readJson<DesignMeta>(designMetaPath(entry.name));
    if (!design) continue;

    const pptHtml = await readText(previewPath(design.slug, "ppt")).catch(() => "");
    const slideIds = pptSlideIds(pptHtml);
    const missingSlides = requiredPptSlides.filter((slide) => !slideIds.has(slide));
    const hasSlideClass = /\bdv-ppt-slide\b/i.test(pptHtml);
    const remoteMedia = hasRemoteMedia(pptHtml);
    const imageCount = design.assets.filter((asset) => asset.kind === "image").length;
    const fallback = pptHtml.includes("Design Vault PPT model fallback");

    const issues = [
      !pptHtml ? "missing ppt.html" : "",
      !hasSlideClass ? "missing dv-ppt-slide class" : "",
      missingSlides.length ? `missing slides [${missingSlides.join(", ")}]` : "",
      remoteMedia ? "remote media in preview" : "",
      imageCount === 0 && design.sourceMode === "url" ? "url import has no raster images" : "",
    ].filter(Boolean);

    if (issues.length > 0) failures.push(`${design.slug}: ${issues.join("; ")}`);
    rows.push(
      `${design.slug}: mode=${design.sourceMode} assets=${design.assets.length} images=${imageCount} ppt=${issues.length ? "review" : "ok"}${fallback ? " fallback" : ""}`,
    );
  }

  console.log(rows.join("\n"));
  if (failures.length > 0) {
    console.error(`\nPreview audit found ${failures.length} item(s) needing review:\n${failures.join("\n")}`);
    if (strict) process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
