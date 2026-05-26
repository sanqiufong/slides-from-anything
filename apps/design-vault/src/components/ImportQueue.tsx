"use client";

import { CheckCircle2, ChevronDown, ChevronUp, Clock3, ExternalLink, ListChecks, Loader2, Trash2, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { IngestionJob } from "@/lib/types";

const STORAGE_KEY = "design-vault:ingestion-queue:v1";
const INGESTION_QUEUE_EVENT = "design-vault:ingestion-job";

function isActive(job: IngestionJob) {
  return job.status === "queued" || job.status === "running";
}

function jobProgress(job: IngestionJob) {
  if (typeof job.progress === "number") return Math.max(0, Math.min(100, job.progress));
  if (job.status === "queued") return 18;
  if (job.status === "running") return 62;
  if (job.status === "completed") return 100;
  return 100;
}

function jobStatusLabel(job: IngestionJob) {
  if (job.status === "queued") return "等待中";
  if (job.status === "running") return "生成中";
  if (job.status === "completed") return "已完成";
  return "失败";
}

function modeLabel(job: IngestionJob) {
  if (job.mode === "canva-template") return "Canva Template";
  if (job.mode === "canva-editor") return "Canva Editor";
  if (job.mode === "design-system-project") return "Project";
  if (job.mode === "clone-website") return "Clone";
  return "URL";
}

function sourceLabel(job: IngestionJob) {
  try {
    const parsed = new URL(job.url);
    return parsed.hostname.replace(/^www\./, "") || job.url;
  } catch {
    return job.url;
  }
}

function friendlyJobError(error?: string) {
  if (!error) return "导入任务失败，请稍后重试。";
  const botChallengeLike = /bot-protection|403 challenge|cf-mitigated|cloudflare|just a moment|enable javascript and cookies/i.test(error);
  if (botChallengeLike) return "目标网站启用了反爬或访问挑战，当前公开 URL 导入无法稳定抓取。可以换最终落地页、社区/本地包，或后续使用登录浏览器捕获。";
  const modelSynthesisLike = /AI model synthesis is required|Model synthesis failed|Style card generation failed/i.test(error);
  if (modelSynthesisLike) return `模型抽象失败：${error}`;
  const quotaLike = /HTTP 429|quota|usage limit|rate limit|Monthly usage limit/i.test(error);
  if (quotaLike) return "模型额度或限流导致导入失败，请更换可用端点/API key 后重试。";
  const authLike = /HTTP 401|HTTP 403|authentication|permission|unauthorized|forbidden/i.test(error);
  if (authLike) return "模型或来源鉴权失败，请检查 API key、base URL、模型 ID 或来源权限。";
  const networkLike = /fetch failed|network request failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|AbortError|TLS|certificate/i.test(error);
  if (networkLike) return "模型端点或来源连接失败，请检查网络、代理/VPN、DNS/TLS 和服务商状态。";
  return error;
}

function elapsedJobLabel(job: IngestionJob) {
  const startedAt = Date.parse(job.createdAt);
  if (!Number.isFinite(startedAt)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function activeJobMessage(job: IngestionJob) {
  const elapsed = elapsedJobLabel(job);
  const stage = job.stageLabel || (job.status === "queued" ? "等待后台处理" : "后台处理中");
  return `${stage}${elapsed ? ` · 已运行 ${elapsed}` : ""}`;
}

function modelDiagnosticSummary(job: IngestionJob) {
  const diagnostics = job.diagnostics?.modelRequest;
  if (!diagnostics) return null;
  const tokens = diagnostics.estimatedInputTokens;
  const range = tokens ? `${tokens.charsPerToken4}-${tokens.charsPerToken3}` : "unknown";
  return [
    `request ${diagnostics.requestChars} chars`,
    `~${range} input tokens`,
    diagnostics.maxTokens ? `max_tokens ${diagnostics.maxTokens}` : null,
    diagnostics.thinking ? `thinking ${diagnostics.thinking}` : null,
    diagnostics.reasoning ? `reasoning ${diagnostics.reasoning}` : null,
    `timeout ${diagnostics.timeoutMs}ms`,
    `${diagnostics.attempts} attempts`,
  ].filter(Boolean).join(" · ");
}

function mergeJobs(current: IngestionJob[], incoming: IngestionJob[]) {
  const map = new Map<string, IngestionJob>();
  for (const job of current) map.set(job.id, job);
  for (const job of incoming) map.set(job.id, { ...map.get(job.id), ...job });
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function loadStoredJobs() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as IngestionJob[];
    return Array.isArray(parsed) ? parsed.filter((job) => job?.id && job?.url && job?.status) : [];
  } catch {
    return [];
  }
}

export function ImportQueue() {
  const router = useRouter();
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const activeCount = jobs.filter(isActive).length;
  const completedCount = jobs.filter((job) => job.status === "completed").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setJobs((current) => mergeJobs(loadStoredJobs(), current));
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(0, 30)));
  }, [hydrated, jobs]);

  useEffect(() => {
    const listener = (event: Event) => {
      const job = (event as CustomEvent<IngestionJob>).detail;
      if (!job?.id) return;
      setJobs((current) => mergeJobs(current, [job]));
      setExpanded(true);
    };
    window.addEventListener(INGESTION_QUEUE_EVENT, listener);
    return () => window.removeEventListener(INGESTION_QUEUE_EVENT, listener);
  }, []);

  useEffect(() => {
    if (!activeCount) return;
    const timer = window.setInterval(async () => {
      const activeJobs = jobs.filter(isActive);
      const updates = await Promise.all(
        activeJobs.map(async (job) => {
          try {
            const response = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
            if (!response.ok) return job;
            return (await response.json()) as IngestionJob;
          } catch {
            return job;
          }
        }),
      );
      const completedBefore = new Set(jobs.filter((job) => job.status === "completed").map((job) => job.id));
      const completedAfter = updates.some((job) => job.status === "completed" && !completedBefore.has(job.id));
      setJobs((current) => mergeJobs(current, updates));
      if (completedAfter) router.refresh();
    }, 1400);
    return () => window.clearInterval(timer);
  }, [activeCount, jobs, router]);

  const summary = useMemo(() => {
    if (!jobs.length) return "暂无任务";
    if (activeCount) return `${activeCount} 个进行中`;
    if (failedCount) return `${failedCount} 个失败`;
    return `${completedCount} 个已完成`;
  }, [activeCount, completedCount, failedCount, jobs.length]);

  function removeJob(jobId: string) {
    setJobs((current) => current.filter((job) => job.id !== jobId));
  }

  function clearDone() {
    setJobs((current) => current.filter(isActive));
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 grid max-w-[calc(100vw-2.5rem)] justify-items-end gap-3">
      {expanded ? (
        <section className="panel-shadow w-[420px] max-w-full overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" aria-label="导入等待队列">
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <div className="dv-eyebrow flex items-center gap-2">
                <ListChecks size={13} aria-hidden="true" />
                等待队列
              </div>
              <div className="font-serif mt-1 text-[17px] font-semibold leading-tight text-foreground">{summary}</div>
            </div>
            <div className="flex flex-none items-center gap-1">
              {jobs.some((job) => !isActive(job)) ? (
                <button className="rounded-md px-2 py-1 text-xs font-semibold text-muted transition hover:bg-surface-muted hover:text-foreground" type="button" onClick={clearDone}>
                  清空完成
                </button>
              ) : null}
              <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-surface-muted hover:text-foreground" aria-label="收起导入队列" type="button" onClick={() => setExpanded(false)}>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="max-h-[440px] overflow-y-auto p-3">
            {!jobs.length ? (
              <div className="rounded-lg border border-dashed border-line bg-surface-muted px-4 py-8 text-center text-sm leading-6 text-muted">开始导入后，任务会出现在这里。</div>
            ) : (
              <div className="grid gap-2">
                {jobs.map((job) => {
                  const active = isActive(job);
                  const failed = job.status === "failed";
                  const done = job.status === "completed";
                  return (
                    <article key={job.id} className="min-w-0 rounded-lg border border-line bg-surface-muted p-3">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            {active ? <Loader2 className="flex-none animate-spin text-accent" size={15} aria-hidden="true" /> : done ? <CheckCircle2 className="flex-none text-success" size={15} aria-hidden="true" /> : <XCircle className="flex-none text-danger" size={15} aria-hidden="true" />}
                            <div className="truncate text-sm font-semibold text-foreground">{sourceLabel(job)}</div>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold">
                            <span className="rounded-md bg-surface px-2 py-1 uppercase tracking-[0.12em] text-muted">{modeLabel(job)}</span>
                            <span className={failed ? "rounded-md bg-[color:var(--danger-soft)] px-2 py-1 text-[color:var(--danger)]" : done ? "rounded-md bg-[color:var(--success-soft)] px-2 py-1 text-[color:var(--success)]" : "rounded-md bg-accent-soft px-2 py-1 text-accent-strong"}>{jobStatusLabel(job)}</span>
                          </div>
                        </div>
                        <button className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-muted transition hover:bg-surface hover:text-danger" aria-label="移除任务" type="button" onClick={() => removeJob(job.id)}>
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[color:var(--line)]" aria-hidden="true">
                        <div className={failed ? "h-full rounded-full bg-[color:var(--danger)]" : "h-full rounded-full bg-accent transition-all duration-300"} style={{ width: `${jobProgress(job)}%` }} />
                      </div>
                      {failed ? (
                        <div className="mt-2 grid gap-1.5">
                          <div className="dv-wrap-anywhere text-xs leading-5 text-[color:var(--danger)]">{friendlyJobError(job.error)}</div>
                          {modelDiagnosticSummary(job) ? <div className="dv-wrap-anywhere rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] leading-5 text-muted">{modelDiagnosticSummary(job)}</div> : null}
                        </div>
                      ) : null}
                      {done && job.slug ? (
                        <Link className="mt-3 inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-accent transition hover:bg-surface" href={`/designs/${job.slug}`}>
                          打开工作台
                          <ExternalLink size={13} aria-hidden="true" />
                        </Link>
                      ) : (
                        <div className="mt-2 flex items-center gap-1 text-xs text-muted">
                          <Clock3 size={12} aria-hidden="true" />
                          {active ? activeJobMessage(job) : "任务已结束。"}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      ) : null}

      <button
        className="flex min-h-12 items-center gap-3 rounded-full border border-accent/40 bg-accent px-4 text-sm font-semibold text-white shadow-[var(--shadow-md)] transition hover:-translate-y-0.5 hover:bg-accent-strong"
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-white/18">
          {activeCount ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : <ListChecks size={16} aria-hidden="true" />}
          {jobs.length ? <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-surface px-1 text-[10px] leading-none text-accent-strong">{jobs.length}</span> : null}
        </span>
        <span>{summary}</span>
        {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}
