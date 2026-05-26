import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

import { NextResponse } from "next/server";

import { classifyCanvaUrl } from "@/lib/canva-ingestion";
import { updateJobProgress } from "@/lib/job-progress";
import { ensureDataRoots, getJob, jobLogPath, saveJob } from "@/lib/storage";
import type { IngestionJob, IngestMode } from "@/lib/types";

function validMode(input: string): input is IngestMode {
  return input === "url" || input === "clone-website" || input === "design-system-project" || input === "canva-template" || input === "canva-editor";
}

function validProjectSource(input: string) {
  if (!input.trim()) return false;
  try {
    const parsed = new URL(input);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return /^(?:npm:)?(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(input.trim());
  }
}

/**
 * Detect URLs that are SOURCE-REPO destinations (user wants to import the
 * REPO, not screenshot its rendered chrome). Submitting a github.com URL
 * to URL mode silently produces a design entry that abstracts github.com's
 * own UI instead of the repo's design system, which is virtually never
 * what the user wanted. Auto-redirect to project mode unless the caller
 * explicitly insists on URL mode via `forceMode: true`.
 */
function looksLikeProjectSource(input: string): boolean {
  const value = input.trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith("npm:")) return true;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.replace(/^www\./, "");
    // Source-control destinations:
    if (host === "github.com" || host.endsWith(".github.com")) return true;
    if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return true;
    if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return true;
    if (host === "codeberg.org" || host === "sr.ht") return true;
    // Package registries:
    if (host === "npmjs.com") return true;
    if (host === "pkg.go.dev" || host === "crates.io" || host === "pypi.org") return true;
    // Direct downloadable archive
    if (/\.(zip|tar\.gz|tgz)(\?|$)/i.test(parsed.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  await ensureDataRoots();
  const body = (await request.json().catch(() => null)) as { url?: string; mode?: string; forceMode?: boolean } | null;
  const url = body?.url?.trim() ?? "";
  const requestedMode = body?.mode ?? "url";
  const forceMode = body?.forceMode === true;
  const canvaMode = requestedMode === "url" ? classifyCanvaUrl(url) : null;
  // Auto-route source-repo URLs to project mode unless the caller
  // explicitly opted out — protects against the common mis-click where
  // a github.com URL hits URL mode and produces a github.com chrome
  // abstraction instead of the intended repo design-system extraction.
  const repoRedirect =
    !forceMode && requestedMode === "url" && !canvaMode && looksLikeProjectSource(url)
      ? ("design-system-project" as const)
      : null;
  const mode = repoRedirect ?? canvaMode ?? requestedMode;

  if (!validMode(mode)) return NextResponse.json({ error: "Unsupported source mode." }, { status: 400 });
  if (mode === "design-system-project") {
    if (!validProjectSource(url)) {
      return NextResponse.json({ error: "Please provide a public GitHub repo, npm package name/URL, or zip archive URL." }, { status: 400 });
    }
  } else {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https URLs are supported.");
    } catch {
      return NextResponse.json({ error: "Please provide a valid public URL." }, { status: 400 });
    }
  }

  const now = new Date().toISOString();
  const jobId = `job_${Date.now()}`;
  const logPath = jobLogPath(jobId);
  const job: IngestionJob = {
    id: jobId,
    url,
    mode,
    status: "queued",
    stage: "queued",
    stageLabel: "等待后台导入 worker 启动",
    progress: 8,
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    workerLogPath: `jobs/logs/${jobId}.log`,
  };
  await saveJob(job);

  let logFd: number | null = null;
  try {
    logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, ["--import", "tsx", "./scripts/run-ingest.ts", job.id], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    child.once("error", (error) => {
      void updateJobProgress(job, {
        status: "failed",
        stage: "failed",
        stageLabel: "后台导入 worker 启动失败",
        progress: 100,
        error: error.message,
      });
    });
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      void (async () => {
        const current = await getJob(job.id);
        if (!current || current.status === "completed" || current.status === "failed") return;
        await updateJobProgress(current, {
          status: "failed",
          stage: "failed",
          stageLabel: "后台导入 worker 异常退出",
          progress: 100,
          error: `Ingestion worker exited before finishing${typeof code === "number" ? ` (code ${code})` : ""}${signal ? ` (signal ${signal})` : ""}.`,
        });
      })();
    });
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }

  return NextResponse.json({
    ...job,
    ...(repoRedirect
      ? {
          modeRedirected: true,
          modeRedirectReason:
            "URL points to a source repository / package registry — automatically routed to 项目 (design-system-project) mode. Pass forceMode:true to override.",
        }
      : {}),
  });
}
