import { runCanvaIngestion } from "../src/lib/canva-ingestion";
import { runIngestion } from "../src/lib/ingestion";
import { runProjectIngestion } from "../src/lib/project-ingestion";
import { getJob } from "../src/lib/storage";

const jobId = process.argv[2];

if (!jobId) {
  console.error("Usage: pnpm ingest <jobId>");
  process.exit(1);
}

async function main() {
  const job = await getJob(jobId);
  if (job?.mode === "design-system-project") {
    await runProjectIngestion(jobId);
    return;
  }
  if (job?.mode === "canva-template" || job?.mode === "canva-editor") {
    await runCanvaIngestion(jobId);
    return;
  }
  await runIngestion(jobId);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
