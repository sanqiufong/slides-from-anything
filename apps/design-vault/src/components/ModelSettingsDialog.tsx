"use client";

import {
  ArrowRight,
  Atom,
  Bot,
  Box,
  Brain,
  Check,
  Cpu,
  Diamond,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Moon,
  RefreshCcw,
  Save,
  Sparkles,
  SunMoon,
  TerminalSquare,
  TestTube2,
  Wand2,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  DetectedAgent,
  EndpointCandidate,
  ModelRuntimeConfig,
  ModelRuntimeScan,
  ScanRefreshHandler,
  TestResult,
} from "./modelSettingsTypes";

const SOURCE_LABELS: Record<EndpointCandidate["source"], string> = {
  current: "当前",
  preset: "预设",
  environment: "环境",
  "local-cli": "CLI",
};

const CLI_VISUALS: Record<string, { icon: LucideIcon; tint: string }> = {
  claude: { icon: Sparkles, tint: "from-[#e8a384] to-[#c96442]" },
  codex: { icon: Atom, tint: "from-[#6cd1a5] to-[#1f7a3a]" },
  opencode: { icon: Diamond, tint: "from-[#6cd1a5] to-[#1f7a3a]" },
  gemini: { icon: Wand2, tint: "from-[#a87dd4] to-[#6c3aa6]" },
  kimi: { icon: Globe, tint: "from-[#6b8fe8] to-[#2348b8]" },
  qwen: { icon: Brain, tint: "from-[#a87dd4] to-[#6c3aa6]" },
  "cursor-agent": { icon: ArrowRight, tint: "from-[#9a9690] to-[#5a5448]" },
  copilot: { icon: Bot, tint: "from-[#9a9690] to-[#5a5448]" },
  deepseek: { icon: Brain, tint: "from-[#6b8fe8] to-[#2348b8]" },
};

type DialogTab = "execution" | "appearance" | "about";

const TABS: Array<{ key: DialogTab; label: string; sub: string; icon: LucideIcon }> = [
  { key: "execution", label: "执行 & 模型", sub: "Local CLI / BYOK", icon: Cpu },
  { key: "appearance", label: "外观", sub: "Choose light, dark, or system.", icon: SunMoon },
  { key: "about", label: "关于", sub: "Version and runtime details", icon: Info },
];

function compactEndpoint(value: string) {
  if (!value) return "未设置";
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function normalizeOpenCodeModel(model: string) {
  const trimmed = model.trim();
  if (trimmed.startsWith("opencode-go/")) return trimmed.replace(/^opencode-go\//, "");
  return trimmed;
}

function formatTestDetail(result: TestResult) {
  const detail = result.message || result.error || "没有返回详情。";
  if (typeof detail !== "string") return JSON.stringify(detail, null, 2);
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

function isActiveCandidate(
  candidate: EndpointCandidate,
  config: ModelRuntimeConfig | null | undefined,
) {
  if (!config) return false;
  const sameModel =
    normalizeOpenCodeModel(candidate.model) === normalizeOpenCodeModel(config.model || "");
  const sameHost = (() => {
    try {
      return new URL(candidate.baseUrl).host === new URL(config.baseUrl || "").host;
    } catch {
      return candidate.baseUrl === config.baseUrl;
    }
  })();
  return sameModel && sameHost;
}

function CliCard({
  agent,
  active,
  currentModel,
  showModelRow,
  onSelect,
  onSelectModel,
}: {
  agent: DetectedAgent;
  active: boolean;
  currentModel: string | null;
  showModelRow: boolean;
  onSelect: () => void;
  onSelectModel: (modelId: string) => void;
}) {
  const visual = CLI_VISUALS[agent.id] ?? { icon: TerminalSquare, tint: "from-[#9a9690] to-[#5a5448]" };
  const Icon = visual.icon;
  const installed = agent.available;
  // Always expose the agent's full model list (including "default") as chips
  // so users can swap between Sonnet / Opus / Haiku without leaving the card.
  const modelChips = agent.models;
  return (
    <div
      className={`group min-w-0 rounded-md border transition ${
        active
          ? "border-accent bg-accent-soft/40"
          : "border-line bg-surface hover:border-accent/40 hover:bg-surface-muted"
      } ${installed ? "" : "opacity-55"}`}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={!installed}
        aria-pressed={active}
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition disabled:cursor-not-allowed"
      >
        <span
          className={`flex h-10 w-10 flex-none items-center justify-center rounded-md bg-gradient-to-br text-white ${visual.tint}`}
          aria-hidden="true"
        >
          <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-foreground">{agent.name}</span>
          <span className="block truncate text-[11px] text-[color:var(--soft)]">
            {installed ? agent.version || agent.bin : "not installed"}
          </span>
        </span>
        <span
          className={`flex h-3 w-3 flex-none items-center justify-center rounded-full border ${
            active
              ? "border-accent bg-accent"
              : "border-line bg-surface group-hover:border-accent/60"
          }`}
          aria-hidden="true"
        >
          {active ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
        </span>
      </button>
      {showModelRow && installed && modelChips.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1 border-t border-line/70 px-3 py-2">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Model</span>
          {modelChips.map((option) => {
            const selected = active && (currentModel ?? "default") === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onSelectModel(option.id)}
                aria-pressed={selected}
                className={`inline-flex h-6 items-center rounded-full px-2 text-[11px] font-semibold transition ${
                  selected
                    ? "bg-accent text-white"
                    : "border border-line bg-surface text-foreground hover:border-accent/40 hover:bg-accent-soft/40"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ModelSettingsDialog({
  open,
  onClose,
  scan,
  loading,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  scan: ModelRuntimeScan | null;
  loading: boolean;
  onRefresh: ScanRefreshHandler;
}) {
  // Lock body scroll while open + bind Escape to close.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  // The dialog body is remounted whenever the saved config snapshot changes
  // — this lets us hydrate form state from `scan` purely via useState lazy
  // initializers (no setState-in-effect) while still picking up the new
  // values after a successful save.
  const snapshotKey = scan
    ? `${scan.config.baseUrl || ""}|${scan.config.model || ""}|${scan.config.apiKeyConfigured ? "k" : "_"}`
    : "loading";

  return (
    <DialogShell onClose={onClose}>
      <DialogBody key={snapshotKey} scan={scan} loading={loading} onRefresh={onRefresh} onClose={onClose} />
    </DialogShell>
  );
}

function DialogShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="flex h-[min(720px,calc(100vh-3rem))] w-[min(1080px,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-lg)]"
        role="dialog"
        aria-modal="true"
        aria-label="模型与执行设置"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function DialogBody({
  scan,
  loading,
  onRefresh,
  onClose,
}: {
  scan: ModelRuntimeScan | null;
  loading: boolean;
  onRefresh: ScanRefreshHandler;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Lazy initializers — these only run on the first mount of this DialogBody.
  // When the parent's snapshotKey changes (after save), a fresh instance is
  // mounted with fresh defaults.
  const candidates = useMemo(() => scan?.endpointCandidates ?? [], [scan]);
  const cliCandidatesById = useMemo(() => {
    const map = new Map<string, EndpointCandidate>();
    for (const c of candidates) {
      if (c.id.startsWith("cli-")) map.set(c.id.replace(/^cli-/, ""), c);
    }
    return map;
  }, [candidates]);

  const byokCandidates = useMemo(
    () => candidates.filter((c) => c.source === "environment" || c.source === "preset"),
    [candidates],
  );

  const initial = useMemo(() => {
    const cfg = scan?.config;
    // Subprocess-mode takes priority — if the saved runtime is in local-cli
    // mode, surface that directly instead of trying to match HTTP candidates.
    const savedSubprocessCli = cfg?.mode === "local-cli" ? cfg.localCli?.agentId ?? null : null;
    const matchedCli =
      savedSubprocessCli ??
      (scan?.agents.find((a) => {
        const c = cliCandidatesById.get(a.id);
        return c && cfg ? isActiveCandidate(c, cfg) : false;
      })?.id ?? null);
    const matchedByok = byokCandidates.find((c) => (cfg ? isActiveCandidate(c, cfg) : false));
    return {
      baseUrl: cfg?.baseUrl || "https://api.openai.com/v1",
      model: cfg?.model || "gpt-4.1",
      timeoutMs: cfg?.timeoutMs || 120000,
      requireModel: cfg?.requireModel ?? true,
      apiKeySource: cfg?.apiKeySource,
      mode: matchedCli ? ("local" as const) : matchedByok ? ("byok" as const) : ("local" as const),
      cliId: matchedCli,
      byokId: matchedByok?.id ?? null,
    };
  }, [scan, cliCandidatesById, byokCandidates]);

  const [tab, setTab] = useState<DialogTab>("execution");
  const [mode, setMode] = useState<"local" | "byok">(initial.mode);
  const [selectedCli, setSelectedCli] = useState<string | null>(initial.cliId);
  const [selectedByokId, setSelectedByokId] = useState<string | null>(initial.byokId);

  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnvName, setApiKeyEnvName] = useState<string | undefined>(initial.apiKeySource);
  const [timeoutMs, setTimeoutMs] = useState(initial.timeoutMs);
  const [requireModel, setRequireModel] = useState(initial.requireModel);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  async function applyAndSave(candidate: EndpointCandidate) {
    setSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const response = await fetch("/api/model-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: candidate.baseUrl,
          model: normalizeOpenCodeModel(candidate.model),
          apiKeyEnvName: candidate.keyEnvName,
          timeoutMs,
          requireModel,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { config?: ModelRuntimeConfig; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error || "切换模型失败。");
      setNotice(`已切换到 ${candidate.label}。`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换模型失败。");
    } finally {
      setSaving(false);
    }
  }

  async function saveManual() {
    setSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const response = await fetch("/api/model-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          model: normalizeOpenCodeModel(model),
          apiKey: apiKey.trim() || undefined,
          apiKeyEnvName,
          timeoutMs,
          requireModel,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { config?: ModelRuntimeConfig; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error || "保存模型配置失败。");
      setNotice("已保存到本地 .env.local。");
      setApiKey("");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存模型配置失败。");
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      // When the currently saved runtime is in local-cli mode AND the user
      // has not switched the dialog to BYOK, test the subprocess directly.
      const useSubprocessTest =
        scan?.config?.mode === "local-cli" &&
        scan.config.localCli &&
        mode === "local" &&
        selectedCli &&
        new Set(["claude", "codex", "opencode"]).has(selectedCli);
      const payload = useSubprocessTest
        ? {
            mode: "local-cli" as const,
            cliAgent: selectedCli,
            cliModel: scan?.config?.localCli?.model || "default",
            timeoutMs,
          }
        : {
            mode: "byok" as const,
            baseUrl,
            model: normalizeOpenCodeModel(model),
            apiKey: apiKey.trim() || undefined,
            apiKeyEnvName,
            timeoutMs,
          };
      const response = await fetch("/api/model-config/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as TestResult | null;
      setTestResult(body ?? { ok: false, error: "模型测试没有返回可读结果。" });
      if (!response.ok && !body) throw new Error("模型测试失败。");
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "模型测试失败。" });
    } finally {
      setTesting(false);
    }
  }

  // Supported agents whose CLI binary we can actually spawn as a subprocess.
  // Other detected CLIs fall back to the old "HTTP preset" behaviour.
  const SUPPORTED_CLI_AGENTS = new Set(["claude", "codex", "opencode"]);

  async function applySubprocessAndSave(agentId: string, agentLabel: string, explicitModel?: string) {
    setSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const agent = scan?.agents.find((a) => a.id === agentId);
      const chosenModel =
        explicitModel ?? agent?.models.find((m) => m.id !== "default")?.id ?? "default";
      const response = await fetch("/api/model-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "local-cli",
          cliAgent: agentId,
          cliModel: chosenModel,
          timeoutMs,
          requireModel,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { config?: ModelRuntimeConfig; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error || "切换到本机 CLI 失败。");
      setNotice(`已切换到 ${agentLabel} 子进程模式（${chosenModel}）。`);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换到本机 CLI 失败。");
    } finally {
      setSaving(false);
    }
  }

  function handleSelectCliModel(agentId: string, modelId: string) {
    const agent = scan?.agents.find((a) => a.id === agentId);
    if (!agent?.available) return;
    if (!SUPPORTED_CLI_AGENTS.has(agentId)) return;
    setSelectedCli(agentId);
    void applySubprocessAndSave(agentId, agent.name, modelId);
  }

  function handleSelectCli(agentId: string) {
    setSelectedCli(agentId);
    const agent = scan?.agents.find((a) => a.id === agentId);
    if (!agent?.available) return;

    // Subprocess-capable agents → spawn directly, no HTTP/key needed.
    if (SUPPORTED_CLI_AGENTS.has(agentId)) {
      void applySubprocessAndSave(agentId, agent.name);
      return;
    }

    // Other detected CLIs: legacy HTTP-preset behaviour.
    const candidate = cliCandidatesById.get(agentId);
    if (candidate) {
      if (candidate.keyAvailable) {
        void applyAndSave(candidate);
      } else {
        setBaseUrl(candidate.baseUrl);
        setModel(normalizeOpenCodeModel(candidate.model));
        setApiKeyEnvName(candidate.keyEnvName);
        setMode("byok");
        setNotice(`已套用 ${candidate.label} 的 HTTP 端点。该 CLI 未接入子进程执行，请在下方"BYOK"补全 API key。`);
      }
    }
  }

  const installedCount = scan?.agents.filter((a) => a.available).length ?? 0;

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line px-6 pt-5 pb-4">
          <div className="min-w-0">
            <div className="dv-eyebrow text-accent">SETTINGS</div>
            <h2 className="font-serif mt-1 text-[22px] font-semibold leading-none text-foreground">
              Execution &amp; model
            </h2>
            <p className="mt-2 text-[12.5px] leading-5 text-muted">
              Local CLI 与 BYOK 二选一，API key 仅保存在本地 .env.local。
            </p>
          </div>
          <button
            ref={closeRef}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-surface-muted hover:text-foreground"
            aria-label="关闭"
            type="button"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Body: side nav + main */}
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
          {/* Side nav */}
          <nav className="overflow-y-auto border-r border-line bg-surface-muted/40 p-3" aria-label="设置分类">
            <ul className="grid gap-1">
              {TABS.map((item) => {
                const Icon = item.icon;
                const active = item.key === tab;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setTab(item.key)}
                      className={`grid w-full grid-cols-[24px_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-2 text-left transition ${
                        active
                          ? "border border-accent bg-surface"
                          : "border border-transparent text-muted hover:bg-surface hover:text-foreground"
                      }`}
                    >
                      <Icon size={14} className={active ? "mt-0.5 text-accent" : "mt-0.5"} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className={`block text-[12.5px] font-semibold leading-tight ${active ? "text-foreground" : "text-foreground/90"}`}>{item.label}</span>
                        <span className="mt-0.5 block truncate text-[10.5px] text-[color:var(--soft)]">{item.sub}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Main */}
          <div className="overflow-y-auto px-6 py-5">
            {tab === "execution" ? (
              <div className="grid min-w-0 gap-5">
                {/* Local CLI / BYOK toggle */}
                <div className="grid grid-cols-2 gap-3">
                  <ModeCard
                    active={mode === "local"}
                    title="Local CLI"
                    sub={`${installedCount} installed`}
                    onClick={() => setMode("local")}
                  />
                  <ModeCard
                    active={mode === "byok"}
                    title="BYOK"
                    sub="API provider"
                    onClick={() => setMode("byok")}
                  />
                </div>

                {/* Mode content */}
                {mode === "local" ? (
                  <section>
                    <div className="flex items-end justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-[13px] font-semibold text-foreground">Local CLI</h3>
                        <p className="mt-1 text-[11.5px] leading-[1.55] text-muted">
                          Detected by scanning your PATH. Pick the CLI you want generations to flow through.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void onRefresh()}
                        disabled={loading}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] font-semibold text-muted transition hover:border-accent/40 hover:text-foreground disabled:opacity-60"
                      >
                        {loading ? <Loader2 className="animate-spin" size={12} aria-hidden="true" /> : <RefreshCcw size={12} aria-hidden="true" />}
                        Rescan
                      </button>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {scan?.agents.map((agent) => {
                        const isActive = selectedCli === agent.id && agent.available;
                        const supportsSubprocess = SUPPORTED_CLI_AGENTS.has(agent.id);
                        const currentModel =
                          isActive && scan?.config.localCli?.agentId === agent.id
                            ? scan.config.localCli?.model ?? null
                            : null;
                        return (
                          <CliCard
                            key={agent.id}
                            agent={agent}
                            active={isActive}
                            currentModel={currentModel}
                            showModelRow={isActive && supportsSubprocess}
                            onSelect={() => handleSelectCli(agent.id)}
                            onSelectModel={(modelId) => handleSelectCliModel(agent.id, modelId)}
                          />
                        );
                      })}
                      {!scan && (
                        <div className="col-span-full rounded-md border border-dashed border-line bg-surface-muted px-3 py-6 text-center text-xs text-muted">
                          <Loader2 className="mx-auto mb-2 animate-spin" size={14} aria-hidden="true" />
                          Scanning…
                        </div>
                      )}
                    </div>
                  </section>
                ) : (
                  <section className="grid gap-4">
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground">环境检测到的 BYOK provider</h3>
                      <p className="mt-1 text-[11.5px] leading-[1.55] text-muted">
                        从 OPENAI_API_KEY / OPENROUTER_API_KEY 等环境变量自动发现的端点，点击直接套用。
                      </p>
                      {byokCandidates.length ? (
                        <div className="mt-3 grid gap-2">
                          {byokCandidates.map((candidate) => {
                            const active = selectedByokId === candidate.id;
                            return (
                              <button
                                key={candidate.id}
                                type="button"
                                onClick={() => {
                                  setSelectedByokId(candidate.id);
                                  if (candidate.keyAvailable) {
                                    void applyAndSave(candidate);
                                  } else {
                                    setBaseUrl(candidate.baseUrl);
                                    setModel(normalizeOpenCodeModel(candidate.model));
                                    setApiKeyEnvName(candidate.keyEnvName);
                                  }
                                }}
                                className={`flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left transition ${
                                  active ? "border-accent bg-accent-soft/40" : "border-line bg-surface hover:border-accent/40 hover:bg-surface-muted"
                                }`}
                              >
                                <Box size={14} className="flex-none text-muted" aria-hidden="true" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[12.5px] font-semibold text-foreground">{candidate.label}</span>
                                  <span className="block truncate font-mono text-[10.5px] text-[color:var(--soft)]">
                                    {candidate.model} · {compactEndpoint(candidate.baseUrl)}
                                  </span>
                                </span>
                                <span className="flex-none rounded border border-line bg-surface-muted px-1 py-px text-[9px] font-semibold uppercase tracking-[0.1em] text-muted">
                                  {SOURCE_LABELS[candidate.source]}
                                </span>
                                {candidate.keyAvailable ? (
                                  <span className="flex-none rounded border border-[color:var(--success)]/25 bg-[color:var(--success-soft)] px-1 py-px text-[9px] font-semibold text-[color:var(--success)]">
                                    ✓
                                  </span>
                                ) : (
                                  <span className="flex-none rounded border border-[color:var(--warning)]/25 bg-[color:var(--warning-soft)] px-1 py-px text-[9px] font-semibold text-[color:var(--warning)]">
                                    Key
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mt-3 rounded-md border border-dashed border-line bg-surface-muted px-3 py-3 text-[11.5px] text-muted">
                          没有检测到环境变量。请在下方手动填写。
                        </p>
                      )}
                    </div>

                    <div className="grid gap-3 rounded-md border border-line bg-surface-muted/60 p-3">
                      <h3 className="text-[13px] font-semibold text-foreground">手动配置</h3>

                      <label className="grid gap-1">
                        <span className="dv-eyebrow">Base URL</span>
                        <input
                          className="h-8 rounded-md border border-line bg-surface px-2.5 text-[12.5px] text-foreground transition focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft"
                          value={baseUrl}
                          onChange={(e) => setBaseUrl(e.target.value)}
                          placeholder="https://api.openai.com/v1"
                        />
                      </label>

                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
                        <label className="grid gap-1">
                          <span className="dv-eyebrow">Model</span>
                          <input
                            className="h-8 rounded-md border border-line bg-surface px-2.5 text-[12.5px] text-foreground transition focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            placeholder="gpt-4.1"
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className="dv-eyebrow">Timeout</span>
                          <input
                            className="h-8 rounded-md border border-line bg-surface px-2.5 text-[12.5px] text-foreground transition focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft"
                            min={5000}
                            step={1000}
                            type="number"
                            value={timeoutMs}
                            onChange={(e) => setTimeoutMs(Number(e.target.value))}
                          />
                        </label>
                      </div>

                      <label className="grid gap-1">
                        <span className="dv-eyebrow flex items-center gap-1">
                          <KeyRound size={11} aria-hidden="true" />
                          API Key
                        </span>
                        <input
                          className="h-8 rounded-md border border-line bg-surface px-2.5 text-[12.5px] text-foreground transition placeholder:text-[color:var(--faint)] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft"
                          type="password"
                          value={apiKey}
                          onChange={(e) => {
                            setApiKey(e.target.value);
                            setApiKeyEnvName(undefined);
                          }}
                          placeholder={
                            scan?.config.apiKeyConfigured
                              ? `已保存 ${scan.config.apiKeyMasked}`
                              : "粘贴 API key，仅保存到本地"
                          }
                        />
                      </label>

                      <label className="flex items-start gap-2 text-[11.5px] text-muted">
                        <input
                          className="mt-0.5"
                          type="checkbox"
                          checked={requireModel}
                          onChange={(e) => setRequireModel(e.target.checked)}
                        />
                        <span>
                          <span className="block font-semibold text-foreground">生产导入必须使用模型</span>
                          <span className="block leading-[1.55]">开启后，模型失败会阻止导入，避免静默降级。</span>
                        </span>
                      </label>
                    </div>
                  </section>
                )}

              </div>
            ) : tab === "appearance" ? (
              <AppearanceTab />
            ) : (
              <AboutTab scan={scan} />
            )}
          </div>
        </div>

        {/* Feedback strip — full-width, sits above the footer so 测试 / 切换 /
            手填 反馈 永远在 'next to the action buttons' 的可视范围里. */}
        {notice || error || testResult ? (
          <div className="border-t border-line bg-surface-muted/40 px-6 py-3">
            <div className="grid gap-2">
              {notice ? (
                <div className="rounded-md border border-[color:var(--success)]/25 bg-[color:var(--success-soft)] px-3 py-2 text-[11.5px] leading-5 text-[color:var(--success)]">
                  {notice}
                </div>
              ) : null}
              {error ? (
                <div className="dv-wrap-anywhere rounded-md border border-[color:var(--danger)]/25 bg-[color:var(--danger-soft)] px-3 py-2 text-[11.5px] leading-5 text-[color:var(--danger)]" role="alert">
                  {error}
                </div>
              ) : null}
              {testResult ? (
                <div
                  className={`overflow-hidden rounded-md border px-3 py-2 text-[11.5px] leading-5 ${
                    testResult.ok
                      ? "border-[color:var(--success)]/25 bg-[color:var(--success-soft)] text-[color:var(--success)]"
                      : "border-[color:var(--warning)]/25 bg-[color:var(--warning-soft)] text-[color:var(--warning)]"
                  }`}
                >
                  <div className="font-semibold">
                    {testResult.ok ? "基础 JSON 调用成功" : `调用未通过${testResult.status ? ` · HTTP ${testResult.status}` : ""}`}
                    {testResult.finishReason ? ` · finish_reason ${testResult.finishReason}` : ""}
                    {typeof testResult.durationMs === "number" ? ` · ${Math.round(testResult.durationMs)}ms` : ""}
                  </div>
                  <pre className="dv-wrap-anywhere mt-2 max-h-[28vh] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-2 font-mono text-[10.5px] leading-5 text-foreground">
                    {formatTestDetail(testResult)}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Footer — shows what is ACTUALLY active right now, not stale BYOK fields. */}
        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface px-6 py-3">
          <div className="min-w-0 text-[11px] text-muted">
            {scan?.config ? (
              (() => {
                const cfg = scan.config;
                if (!cfg.configured) {
                  return (
                    <span className="inline-flex items-center gap-1.5 text-[color:var(--warning)]">
                      <XCircle size={11} aria-hidden="true" />
                      未配置
                    </span>
                  );
                }
                if (cfg.mode === "local-cli" && cfg.localCli) {
                  const agent = scan.agents.find((a) => a.id === cfg.localCli?.agentId);
                  const cliModelLabel = cfg.localCli.model && cfg.localCli.model !== "default"
                    ? cfg.localCli.model
                    : "默认模型";
                  return (
                    <span className="inline-flex items-center gap-1.5">
                      <Check size={11} className="text-[color:var(--success)]" aria-hidden="true" />
                      <span className="rounded-sm bg-accent-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.1em] text-accent-strong">
                        当前调用
                      </span>
                      <span className="font-semibold text-foreground">本机子进程</span>
                      <span>·</span>
                      <span className="font-semibold text-foreground">{agent?.name ?? cfg.localCli.agentId}</span>
                      <span>·</span>
                      <span className="font-mono text-foreground/85">{cliModelLabel}</span>
                    </span>
                  );
                }
                return (
                  <span className="inline-flex items-center gap-1.5">
                    <Check size={11} className="text-[color:var(--success)]" aria-hidden="true" />
                    <span className="rounded-sm bg-surface-muted px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                      当前调用
                    </span>
                    <span className="font-semibold text-foreground">HTTP</span>
                    <span>·</span>
                    <span className="font-semibold text-foreground">{cfg.model}</span>
                    <span>·</span>
                    <span className="truncate font-mono">{compactEndpoint(cfg.baseUrl)}</span>
                  </span>
                );
              })()
            ) : (
              <span className="inline-flex items-center gap-1.5 text-muted">加载中…</span>
            )}
          </div>
          <div className="flex flex-none items-center gap-2">
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={testing}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[12px] font-semibold text-foreground transition hover:border-accent/40 hover:bg-surface-muted disabled:opacity-60"
            >
              {testing ? <Loader2 className="animate-spin" size={13} aria-hidden="true" /> : <TestTube2 size={13} aria-hidden="true" />}
              测试
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-[12px] font-semibold text-muted transition hover:border-accent/40 hover:text-foreground"
            >
              Cancel
            </button>
            {mode === "byok" ? (
              <button
                type="button"
                onClick={() => void saveManual()}
                disabled={saving}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_0_rgba(180,90,59,0.18),var(--shadow-xs)] transition hover:bg-accent-strong disabled:opacity-60"
              >
                {saving ? <Loader2 className="animate-spin" size={13} aria-hidden="true" /> : <Save size={13} aria-hidden="true" />}
                Save
              </button>
            ) : null}
          </div>
        </div>
    </>
  );
}

function ModeCard({
  active,
  title,
  sub,
  onClick,
}: {
  active: boolean;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border px-3 py-3 text-left transition ${
        active
          ? "border-accent bg-accent-soft/40"
          : "border-line bg-surface hover:border-accent/40 hover:bg-surface-muted"
      }`}
    >
      <div className="text-[13.5px] font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-[11.5px] text-muted">{sub}</div>
    </button>
  );
}

function AppearanceTab() {
  // Light wrapper so this tab is functional even though the actual theme
  // toggle lives in the topbar — we just direct the user there.
  return (
    <div className="grid gap-4">
      <div>
        <h3 className="text-[13px] font-semibold text-foreground">Appearance</h3>
        <p className="mt-1 text-[11.5px] leading-[1.55] text-muted">
          切换亮 / 暗 / 跟随系统。和顶栏右上角的主题开关同步。
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface-muted/60 px-3 py-2.5">
        <Moon size={14} className="text-accent" aria-hidden="true" />
        <span className="text-[12.5px] text-foreground">使用顶栏的 ☀ 🌙 🖥 切换器调整主题。</span>
      </div>
    </div>
  );
}

function AboutTab({ scan }: { scan: ModelRuntimeScan | null }) {
  const cfg = scan?.config;
  return (
    <div className="grid gap-4">
      <div>
        <h3 className="text-[13px] font-semibold text-foreground">About</h3>
        <p className="mt-1 text-[11.5px] leading-[1.55] text-muted">运行时与环境概要。</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-line bg-surface-muted/40 p-3 text-[11.5px]">
        <dt className="text-muted">App</dt>
        <dd className="font-mono text-foreground">Design Vault</dd>
        <dt className="text-muted">Model endpoint</dt>
        <dd className="truncate font-mono text-foreground">{compactEndpoint(cfg?.baseUrl || "")}</dd>
        <dt className="text-muted">Model</dt>
        <dd className="truncate font-mono text-foreground">{cfg?.model || "未设置"}</dd>
        <dt className="text-muted">Timeout</dt>
        <dd className="font-mono text-foreground">{(cfg?.timeoutMs ?? 0) / 1000}s</dd>
        <dt className="text-muted">API key</dt>
        <dd className="font-mono text-foreground">{cfg?.apiKeyConfigured ? `${cfg.apiKeyMasked || "已保存"}` : "未保存"}</dd>
        <dt className="text-muted">.env.local</dt>
        <dd className="truncate font-mono text-foreground">{cfg?.envLocalPath || "—"}</dd>
      </dl>
    </div>
  );
}
