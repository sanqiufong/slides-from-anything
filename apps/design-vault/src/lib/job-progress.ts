import { getJob, saveJob } from "./storage";
import type { IngestionJob } from "./types";

type JobProgressUpdate = Partial<
  Pick<
    IngestionJob,
    "status" | "stage" | "stageLabel" | "progress" | "slug" | "error" | "diagnostics" | "workerLogPath"
  >
>;

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return undefined;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export async function updateJobProgress(jobOrId: IngestionJob | string, update: JobProgressUpdate) {
  const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId.id;
  const fallback = typeof jobOrId === "string" ? null : jobOrId;
  const current = await getJob(jobId);
  const base = current ?? fallback;
  if (!base) throw new Error(`Job not found: ${jobId}`);

  const now = new Date().toISOString();
  const next: IngestionJob = {
    ...base,
    ...update,
    progress: typeof update.progress === "number" ? clampProgress(update.progress) : base.progress,
    updatedAt: now,
    lastHeartbeatAt: now,
  };
  await saveJob(next);
  return next;
}
