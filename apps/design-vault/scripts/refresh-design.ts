import { ensureDataRoots, saveJob } from "../src/lib/storage";
import { runCanvaIngestion } from "../src/lib/canva-ingestion";
import { runIngestion } from "../src/lib/ingestion";
import { runProjectIngestion } from "../src/lib/project-ingestion";
import type { IngestMode, IngestionJob } from "../src/lib/types";

function isMode(value: string): value is IngestMode {
  return value === "url" || value === "clone-website" || value === "design-system-project" || value === "canva-template" || value === "canva-editor";
}

const [slug, url, modeInput = "url"] = process.argv.slice(2);
const mode = isMode(modeInput) ? modeInput : null;

if (!slug || !url || !mode) {
  console.error("Usage: node --import tsx ./scripts/refresh-design.ts <slug> <url> [url|clone-website|design-system-project|canva-template|canva-editor]");
  process.exit(1);
}

const normalizedMode: IngestMode = mode;

async function main() {
  await ensureDataRoots();

  const now = new Date().toISOString();
  const job: IngestionJob = {
    id: `refresh_${Date.now()}`,
    url,
    mode: normalizedMode,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    targetSlug: slug,
  };

  await saveJob(job);
  if (normalizedMode === "design-system-project") {
    await runProjectIngestion(job.id);
    return;
  }
  if (normalizedMode === "canva-template" || normalizedMode === "canva-editor") {
    await runCanvaIngestion(job.id);
    return;
  }
  await runIngestion(job.id);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
