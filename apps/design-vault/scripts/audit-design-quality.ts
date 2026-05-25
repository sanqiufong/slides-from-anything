import { readdir } from "node:fs/promises";

import { DESIGNS_ROOT, designMetaPath, readJson } from "../src/lib/storage";
import type { DesignMeta } from "../src/lib/types";

const strict = process.argv.includes("--strict");

async function main() {
  const entries = await readdir(DESIGNS_ROOT, { withFileTypes: true });
  const designs = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson<DesignMeta>(designMetaPath(entry.name))),
    )
  ).filter(Boolean) as DesignMeta[];

  const failures: string[] = [];
  const rows = designs
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((design) => {
      const quality = design.profile.quality;
      if (!quality) {
        failures.push(`${design.slug}: missing quality report`);
        return `${design.slug}: missing quality report`;
      }

      const modelStatus = design.profile.synthesis.status ?? "unknown";
      const failingGates = quality.gates.filter((gate) => gate.status === "fail").map((gate) => gate.id);
      if (strict && (quality.score < quality.threshold || failingGates.length > 0)) {
        failures.push(`${design.slug}: ${quality.score}/100 ${quality.grade}; failing gates ${failingGates.join(", ") || "none"}`);
      }
      return `${design.slug}: ${quality.score}/100 ${quality.grade} (${modelStatus})`;
    });

  console.log(rows.join("\n"));

  if (strict && failures.length > 0) {
    console.error(`\nStrict quality audit failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
