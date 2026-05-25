import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { DESIGNS_ROOT } from "../src/lib/storage";

const expectedSections = [
  "## 1. Visual Theme & Atmosphere",
  "## 2. Color",
  "## 3. Typography",
  "## 4. Spacing & Grid",
  "## 5. Layout & Composition",
  "## 6. Components",
  "## 7. Motion & Interaction",
  "## 8. Voice & Brand",
  "## 9. Anti-patterns",
];

async function main() {
  const entries = await readdir(DESIGNS_ROOT, { withFileTypes: true });
  const failures: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(DESIGNS_ROOT, entry.name, "meta.json");
    const docPath = path.join(DESIGNS_ROOT, entry.name, "design.md");
    const profilePath = path.join(DESIGNS_ROOT, entry.name, "profile.json");

    const hasMeta = await access(metaPath)
      .then(() => true)
      .catch(() => false);
    if (!hasMeta) {
      skipped.push(entry.name);
      continue;
    }

    const missingFiles = (
      await Promise.all(
        [
          ["design.md", docPath],
          ["profile.json", profilePath],
        ].map(async ([label, filePath]) =>
          access(filePath)
            .then(() => null)
            .catch(() => label),
        ),
      )
    ).filter(Boolean);
    if (missingFiles.length > 0) {
      failures.push(`${entry.name}: missing files [${missingFiles.join(", ")}]`);
      continue;
    }

    const content = await readFile(docPath, "utf8");
    const profile = JSON.parse(await readFile(profilePath, "utf8")) as { quality?: { score?: number; threshold?: number; gates?: unknown[] } };
    const headings = content.match(/^##\s.+$/gm) ?? [];
    const missing = expectedSections.filter((section) => !content.includes(section));
    const extraOrWrongCount = headings.length !== expectedSections.length;
    const requiredEvidenceBlocks = ["9/10 production quality gate", "Source Evidence Ledger", "Role evidence", "Page topology", "Behavior evidence"];
    const missingEvidenceBlocks = requiredEvidenceBlocks.filter((block) => !content.includes(block));
    const missingQuality = typeof profile.quality?.score !== "number" || typeof profile.quality?.threshold !== "number" || !Array.isArray(profile.quality?.gates);

    if (missing.length > 0 || extraOrWrongCount || missingEvidenceBlocks.length > 0 || missingQuality) {
      failures.push(
        `${entry.name}: missing sections [${missing.join(", ") || "none"}], heading count ${headings.length}, missing evidence blocks [${missingEvidenceBlocks.join(", ") || "none"}], quality report ${missingQuality ? "missing" : "ok"}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(
    `All design.md files follow the 9-section Open Design contract with evidence blocks.${skipped.length ? ` Skipped incomplete asset-only directories: ${skipped.join(", ")}.` : ""}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
