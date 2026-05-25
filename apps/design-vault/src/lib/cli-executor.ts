import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { delimiter } from "node:path";

export type CliChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CliExecutionResult = {
  content: string;
  agentId: SupportedAgentId;
  model: string;
  durationMs: number;
  stderr?: string;
};

export type CliExecutionInput = {
  agentId: SupportedAgentId;
  model: string;
  messages: CliChatMessage[];
  /** When true, append an instruction asking the CLI to output JSON-only and parse the result. */
  jsonOutput?: boolean;
  /** Total timeout for the subprocess in milliseconds. */
  timeoutMs?: number;
  /** Optional failure-label prefix for thrown errors. */
  failureLabel?: string;
  /**
   * Local image file paths to attach as visual evidence. Only `claude` consumes
   * them natively (each becomes a `--image <path>` flag). codex / opencode
   * ignore the option silently — they are non-vision in their current stable
   * subprocess invocations. Missing or oversize files are dropped at exec time.
   */
  imagePaths?: string[];
};

export const SUPPORTED_AGENT_IDS = ["claude", "codex", "opencode"] as const;
export type SupportedAgentId = (typeof SUPPORTED_AGENT_IDS)[number];

export function isSupportedAgentId(value: string | null | undefined): value is SupportedAgentId {
  return typeof value === "string" && (SUPPORTED_AGENT_IDS as readonly string[]).includes(value);
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

/**
 * Per-agent adapter. The contract:
 *   • acceptsImages — does the binary have *any* way to receive pixels?
 *   • buildArgs    — turn (prompt, model, jsonOutput, imagePaths) into argv.
 *                    Each agent decides how to attach images via its own
 *                    flag syntax (--image / --file) or by granting tool
 *                    access (--add-dir + --allowedTools Read).
 *   • wrapPromptForImages — optional final-mile prompt rewrite for agents
 *                    that need an explicit instruction to actually CONSUME
 *                    the images (e.g. claude needs to be told to call Read).
 *                    Agents whose flags attach images multimodally leave
 *                    this undefined.
 *   • parseStdout  — turn stdout into the final assistant text.
 *
 * The synthesis layer only ever calls runCliCompletion; it never branches
 * on agentId for image handling. All CLI specifics live here.
 */
type AgentInvocation = {
  acceptsImages: boolean;
  buildArgs: (input: {
    prompt: string;
    model: string;
    jsonOutput: boolean;
    imagePaths: string[];
  }) => string[];
  wrapPromptForImages?: (prompt: string, imagePaths: string[]) => string;
  /**
   * Multiplier applied to the caller-supplied timeout when image paths are
   * attached. Agents that consume images as separate tool-call round trips
   * (claude → Read) need significantly more wall time than agents whose
   * flags attach images multimodally in a single turn (codex --image,
   * opencode --file). Defaults to 1.
   */
  imageTimeoutFactor?: number;
  /**
   * Native CLI flag for setting the system prompt (e.g. claude's
   * `--system-prompt`). When set, system-role messages are lifted out of the
   * positional prompt and passed via this flag, which avoids triggering
   * prompt-injection refusals on agents trained to spot `[SYSTEM]`-style
   * markers in user input.
   */
  systemPromptFlag?: string;
  /**
   * When true, the prompt is delivered through the child's stdin pipe
   * rather than as a positional argv. Mirrors open-ppt's daemon — pipes
   * sidestep cross-platform argv length caps (E2BIG / ENAMETOOLONG) AND
   * push codex/opencode into the same non-interactive code path they use
   * in their own test suites, which is where the parser-friendly stream
   * shapes actually live.
   */
  promptViaStdin?: boolean;
  parseStdout: (stdout: string, jsonOutput: boolean) => string;
};

const CLAUDE_INVOCATION: AgentInvocation = {
  acceptsImages: true,
  // claude consumes each image as a separate Read tool round trip + the final
  // synthesis turn. That's N+1 turns for N images, so wall time scales roughly
  // 3× the no-image baseline at 5 keyframes.
  imageTimeoutFactor: 3,
  // Use claude's native system-prompt flag instead of inline markers so its
  // safety training doesn't read our role labels as prompt-injection.
  systemPromptFlag: "--system-prompt",
  // claude has no native --image flag. We grant Read access to the keyframe
  // directories and permit only the Read tool; wrapPromptForImages tells the
  // agent which files to actually read before emitting JSON.
  buildArgs: ({ prompt, model, jsonOutput, imagePaths }) => {
    const args = ["-p", prompt];
    if (jsonOutput) args.push("--output-format", "json");
    if (model && model !== "default") args.push("--model", model);
    if (imagePaths.length > 0) {
      const dirs = new Set<string>();
      for (const imagePath of imagePaths) dirs.add(path.dirname(imagePath));
      for (const dir of dirs) args.push("--add-dir", dir);
      args.push("--allowedTools", "Read");
      args.push("--permission-mode", "acceptEdits");
    }
    return args;
  },
  wrapPromptForImages: (prompt, imagePaths) =>
    [
      prompt,
      "",
      "[KEYFRAME IMAGES]",
      "Use the Read tool on each of the paths below before emitting the JSON. The pixels you observe are the primary visual evidence for the synthesis.",
      ...imagePaths.map((p) => `- ${p}`),
    ].join("\n"),
  parseStdout: (stdout, jsonOutput) => {
    if (!jsonOutput) return stdout.trim();
    const parsed = JSON.parse(stdout) as { result?: string; type?: string; error?: string };
    if (parsed.error) throw new Error(`claude reported error: ${parsed.error}`);
    if (typeof parsed.result !== "string") {
      throw new Error("claude JSON output did not contain a string `result` field.");
    }
    return parsed.result.trim();
  },
};

const CODEX_INVOCATION: AgentInvocation = {
  acceptsImages: true,
  // codex accepts native --image attachments; the model receives them
  // multimodally so the prompt doesn't need any extra "look at these" line.
  //
  // Argv recipe mirrors open-ppt's daemon:
  //   * `--skip-git-repo-check` lets codex run from any directory
  //     (Design Vault is run from arbitrary cwds; without this codex
  //     bails before reading the prompt).
  //   * `--sandbox workspace-write` + `sandbox_workspace_write.network_access=true`
  //     match the codex defaults used by an interactive session, so the
  //     non-interactive `exec` path doesn't hit a stricter sandbox that
  //     refuses to fetch its model registry.
  //   * Prompt is piped through stdin (`promptViaStdin`); we no longer
  //     pass a positional PROMPT. Codex's help says "If not provided as
  //     an argument (or if `-` is used), instructions are read from
  //     stdin" — taking that path means codex never prints the
  //     misleading "Reading additional input from stdin..." stderr line
  //     when the prompt is empty.
  buildArgs: ({ model, jsonOutput, imagePaths }) => {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
    ];
    if (jsonOutput) args.push("--json");
    if (model && model !== "default") args.push("--model", model);
    for (const imagePath of imagePaths) {
      args.push("--image", imagePath);
    }
    return args;
  },
  promptViaStdin: true,
  parseStdout: (stdout, jsonOutput) => {
    if (!jsonOutput) return stdout.trim();
    const events = parseJsonl(stdout);
    const completion = events.find((event) => event?.type === "turn.completed" || event?.type === "task_complete");
    if (completion) {
      const text = extractCodexCompletionText(completion);
      if (text) return text;
    }
    const message = events
      .map((event) => extractCodexMessageText(event))
      .filter((value): value is string => Boolean(value))
      .join("")
      .trim();
    if (message) return message;
    throw new Error("codex JSON stream did not contain a final assistant message.");
  },
};

const OPENCODE_INVOCATION: AgentInvocation = {
  acceptsImages: true,
  // opencode's `--file` is an array option that attaches files (incl. images)
  // to the message. Repeating the flag is the safe form across yargs versions.
  //
  // Argv recipe mirrors open-ppt: `opencode run --format json
  // --dangerously-skip-permissions -`. The trailing `-` tells opencode
  // to read the prompt from stdin (sidesteps argv length caps + lines
  // us up with the canonical non-interactive streaming path that
  // emits well-formed `{ type: "text", part: { text } }` events).
  buildArgs: ({ model, jsonOutput, imagePaths }) => {
    const args = ["run"];
    if (jsonOutput) args.push("--format", "json");
    args.push("--dangerously-skip-permissions");
    if (model && model !== "default") args.push("--model", model);
    for (const imagePath of imagePaths) {
      args.push("--file", imagePath);
    }
    args.push("-");
    return args;
  },
  promptViaStdin: true,
  parseStdout: (stdout, jsonOutput) => {
    if (!jsonOutput) return stdout.trim();
    const events = parseJsonl(stdout);
    const buffer: string[] = [];
    for (const event of events) {
      const text = extractOpenCodeText(event);
      if (text) buffer.push(text);
    }
    const joined = buffer.join("").trim();
    if (joined) return joined;
    throw new Error("opencode JSON stream did not contain assistant text.");
  },
};

const INVOCATIONS: Record<SupportedAgentId, AgentInvocation> = {
  claude: CLAUDE_INVOCATION,
  codex: CODEX_INVOCATION,
  opencode: OPENCODE_INVOCATION,
};

function parseJsonl(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
    } catch {
      // Ignore non-JSON lines (CLIs occasionally emit progress text alongside JSON).
    }
  }
  return events;
}

function extractCodexCompletionText(event: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    (event as { last_agent_message?: unknown }).last_agent_message,
    (event as { final?: { content?: unknown } }).final?.content,
    (event as { message?: { content?: unknown } }).message?.content,
    (event as { response?: { output_text?: unknown } }).response?.output_text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function extractCodexMessageText(event: Record<string, unknown>): string | undefined {
  // Codex's `exec --json` stream emits the final assistant content as
  //   { type: "item.completed", item: { type: "agent_message", text: "..." } }
  // followed by a `turn.completed` usage event. Older versions also used
  //   { type: "agent_message", message: "..." }    or { message: { content } }
  //   { type: "agent_message_delta", delta: "..." }
  // Match both.
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "item.completed" || type === "item.updated") {
    const item = (event as { item?: { type?: unknown; text?: unknown; content?: unknown } }).item;
    if (item && typeof item === "object" && item.type === "agent_message") {
      if (typeof item.text === "string" && item.text.trim()) return item.text;
      if (typeof item.content === "string" && item.content.trim()) return item.content;
    }
    return undefined;
  }

  if (type !== "agent_message" && type !== "agent_message_delta" && type !== "message") return undefined;
  const msg = (event as { message?: unknown }).message;
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  const delta = (event as { delta?: unknown }).delta;
  if (typeof delta === "string") return delta;
  const text = (event as { text?: unknown }).text;
  if (typeof text === "string" && text.trim()) return text;
  return undefined;
}

function looksLikeAssistantText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 1) return false;
  // IDs the stream uses (prt_, ses_, msg_, step_) are uniform alphanumeric.
  // Reject them so we don't confuse a session id with an answer.
  if (/^(prt_|ses_|msg_|step_)/.test(trimmed)) return false;
  if (/^[0-9a-f]{32,}$/i.test(trimmed)) return false;
  return true;
}

function extractOpenCodeText(event: Record<string, unknown>): string | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  if (!type) return undefined;

  // Strict whitelist mirroring open-ppt's parser: only `type === "text"`
  // events carry assistant text in opencode's current stream. Earlier
  // versions of this parser also pulled `part.text` from `step_finish`
  // and `message.part.updated`, which led to the buffer concatenating
  // stop-reason sentinels (e.g. `…test"}stop`) on top of the assistant
  // JSON. Trust opencode's typing — text events have the text; status
  // events do not.
  const part = (event as { part?: { text?: unknown; content?: unknown; delta?: { text?: unknown } } }).part;
  if (type === "text" || type === "text.delta") {
    if (part && typeof part === "object") {
      if (looksLikeAssistantText(part.text)) return part.text as string;
      if (typeof part.delta === "object" && part.delta && looksLikeAssistantText(part.delta.text)) {
        return part.delta.text as string;
      }
      if (looksLikeAssistantText(part.content)) return part.content as string;
    }
    return undefined;
  }

  // Legacy / cousin shapes still observed in older opencode releases or
  // anthropic-style proxies. Keep them quietly available for backward
  // compat — but only when their part.text is plausibly assistant text.
  if (type === "assistant" || type === "result" || type === "content_block_delta") {
    if (part && typeof part === "object") {
      if (looksLikeAssistantText(part.text)) return part.text as string;
      if (Array.isArray(part.content)) {
        for (const inner of part.content) {
          if (inner && typeof inner === "object") {
            const innerText = (inner as { text?: unknown }).text;
            if (looksLikeAssistantText(innerText)) return innerText as string;
          }
        }
      }
    }
    const flat = (event as { text?: unknown; content?: unknown });
    if (looksLikeAssistantText(flat.text)) return flat.text as string;
    if (looksLikeAssistantText(flat.content)) return flat.content as string;
  }

  return undefined;
}

function resolvePathDirs(): string[] {
  const home = homedir();
  const seen = new Set<string>();
  const dirs = [
    ...(process.env.PATH || "").split(delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

function resolveBinary(bin: string): string | null {
  const dirs = resolvePathDirs();
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const full = path.join(dir, `${bin}${ext}`);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Compose role-tagged messages into the argv shape a given CLI expects.
 *
 * Earlier versions wrapped each message in `[SYSTEM]` / `[USER]` / `[FORMAT]`
 * brackets and concatenated everything into one positional prompt. claude's
 * safety training reads those brackets as a prompt-injection attempt and
 * refuses the request ("This looks like a prompt injection attempt..."), so
 * the markers are gone.
 *
 *   • If the agent declares `systemPromptFlag`, system messages are lifted
 *     out and passed via that CLI flag (claude: --system-prompt). The
 *     positional prompt then carries only the user content.
 *   • Otherwise the system content is prepended as a plain paragraph, with
 *     one blank line separating it from the user content. No role labels,
 *     no all-caps markers, no `<>` tags — just natural prose the model can
 *     parse without triggering injection heuristics.
 */
function composeMessages(
  messages: CliChatMessage[],
  jsonOutput: boolean,
  systemPromptFlag?: string,
): { systemArgs: string[]; prompt: string } {
  const systemArgs: string[] = [];
  const promptBlocks: string[] = [];

  for (const message of messages) {
    if (!message.content) continue;
    const content = message.content.trim();
    if (!content) continue;
    if (message.role === "system") {
      if (systemPromptFlag) {
        systemArgs.push(systemPromptFlag, content);
      } else {
        promptBlocks.push(content);
      }
    } else {
      promptBlocks.push(content);
    }
  }

  if (jsonOutput) {
    promptBlocks.push(
      "Output format: return a single valid JSON object as your final answer. No prose, markdown fences, or commentary outside the JSON.",
    );
  }

  return { systemArgs, prompt: promptBlocks.join("\n\n") };
}

function trimForLog(value: string, max = 500): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}… (+${trimmed.length - max} chars)`;
}

export async function runCliCompletion(input: CliExecutionInput): Promise<CliExecutionResult> {
  if (!isSupportedAgentId(input.agentId)) {
    throw new Error(`Local CLI agent "${input.agentId}" is not supported yet. Supported: ${SUPPORTED_AGENT_IDS.join(", ")}.`);
  }
  const invocation = INVOCATIONS[input.agentId];
  const binary = resolveBinary(input.agentId);
  if (!binary) {
    throw new Error(`Local CLI binary "${input.agentId}" was not found on PATH. Install or activate it before retrying.`);
  }

  const jsonOutput = input.jsonOutput ?? true;
  const composed = composeMessages(input.messages, jsonOutput, invocation.systemPromptFlag);
  const { systemArgs } = composed;
  let prompt = composed.prompt;

  // Filter image paths: only forward to agents that accept them, drop any
  // entry that disappeared from disk between the synthesis call and the spawn.
  const imagePaths = invocation.acceptsImages
    ? (input.imagePaths ?? []).filter((imagePath) => {
        try {
          return existsSync(imagePath);
        } catch {
          return false;
        }
      })
    : [];

  // Some agents (claude) need an explicit "use Read tool on these paths"
  // instruction added to the prompt; others (codex/opencode) attach images
  // multimodally via flags and don't need any prompt help.
  if (imagePaths.length > 0 && invocation.wrapPromptForImages) {
    prompt = invocation.wrapPromptForImages(prompt, imagePaths);
  }

  const args = [
    ...systemArgs,
    ...invocation.buildArgs({
      prompt,
      model: input.model.trim() || "default",
      jsonOutput,
      imagePaths,
    }),
  ];

  // Scale the caller's timeout when this agent needs extra wall time to
  // consume images (e.g. claude's sequential Read tool calls).
  const baseTimeoutMs = Math.max(5_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const imageFactor =
    imagePaths.length > 0 && invocation.imageTimeoutFactor ? invocation.imageTimeoutFactor : 1;
  const timeoutMs = Math.round(baseTimeoutMs * imageFactor);
  const failureLabel = input.failureLabel ?? "Local CLI execution failed";

  const startedAt = Date.now();

  const usesStdinPrompt = Boolean(invocation.promptViaStdin);

  return new Promise<CliExecutionResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: process.env,
      // When the agent reads its prompt from stdin, give the child a real
      // pipe; we'll write the prompt and close stdin so the agent sees a
      // proper EOF (codex/opencode hang or print noise otherwise).
      stdio: [usesStdinPrompt ? "pipe" : "ignore", "pipe", "pipe"],
    });

    // Pipe the prompt + half-close stdin. Errors on the stdin stream
    // (e.g. EPIPE if the child died before reading) are swallowed; the
    // exit code / stderr path will surface the real failure.
    if (usesStdinPrompt && child.stdin) {
      child.stdin.on("error", () => {
        /* swallow — child died first */
      });
      child.stdin.end(prompt);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let killedForBuffer = false;
    let killedForTimeout = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BUFFER_BYTES) {
        if (!killedForBuffer) {
          killedForBuffer = true;
          child.kill("SIGTERM");
        }
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${failureLabel}: failed to spawn ${input.agentId} (${error.message}).`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const durationMs = Date.now() - startedAt;

      if (killedForTimeout) {
        const timeoutNote =
          imageFactor !== 1
            ? `${timeoutMs}ms (base ${baseTimeoutMs}ms × ${imageFactor} for ${imagePaths.length} image input(s))`
            : `${timeoutMs}ms`;
        return reject(new Error(`${failureLabel}: ${input.agentId} timed out after ${timeoutNote}.${stderr ? ` stderr=${trimForLog(stderr)}` : ""}`));
      }
      if (killedForBuffer) {
        return reject(new Error(`${failureLabel}: ${input.agentId} produced more than ${MAX_BUFFER_BYTES} bytes of stdout and was aborted.`));
      }
      if (code !== 0) {
        const signalNote = signal ? ` signal=${signal}` : "";
        // Recognise common codex internal failure modes — model registry
        // refresh timeout, MCP transport failure, ChatGPT auth fetch
        // breakage — and rewrite the error so the user knows it's codex's
        // own network/auth, not Design Vault.
        if (input.agentId === "codex") {
          // Codex emits structured errors as JSON events on STDOUT (not
          // stderr) when --json is set. We probe both streams so model-
          // version mismatches, auth lapses, and MCP failures all map
          // to actionable hints.
          const haystack = `${stderr}\n${stdout}`;
          const codexHints: Array<{ pattern: RegExp; hint: string }> = [
            {
              pattern: /requires a newer version of Codex|model requires a newer/i,
              hint: "codex 默认模型（看起来是 gpt-5.5）需要更新的 codex CLI。要么升级 codex（`brew upgrade codex` / 重新安装 codex），要么在 Design Vault 的 Local CLI 卡片上明确选一个你当前 codex 已支持的模型（例如 gpt-5 / o3 / o4-mini），别用 default。也可以编辑 `~/.codex/config.toml` 把 `model = \"gpt-5.5\"` 改成兼容的型号",
            },
            {
              pattern: /codex_models_manager.*timeout waiting for child process to exit/i,
              hint: "codex 自身的模型注册表刷新超时（codex 内部子进程未在限定时间内返回）",
            },
            {
              pattern: /rmcp::transport::worker.*Transport channel closed/i,
              hint: "codex 的 MCP transport 连不上 chatgpt.com/backend-api（TLS 握手被中断，常见原因：VPN/代理拦截、ChatGPT 登录失效、网络对 openai 域名做了限制）",
            },
            {
              pattern: /chatgpt\.com\/backend-api/i,
              hint: "codex 内部子进程无法访问 chatgpt.com backend，请检查 ChatGPT 登录状态（`codex auth status` / `codex login`）和网络对 openai 域名的可达性",
            },
            {
              pattern: /401|unauthorized|invalid token/i,
              hint: "codex 的 ChatGPT 鉴权失效，请在终端执行 `codex login` 重新登录后重试",
            },
            {
              pattern: /"type":"error"|"turn\.failed"/i,
              hint: "codex 在执行 turn 时报错（详见上面 stdout 的 JSON error 事件）",
            },
          ];
          const hit = codexHints.find((entry) => entry.pattern.test(haystack));
          if (hit) {
            const stdoutNote = stdout.trim() ? ` stdout=${trimForLog(stdout)}` : "";
            return reject(
              new Error(
                `${failureLabel}: ${hit.hint}。这是 codex 本地环境问题，与 Design Vault 无关。请先在终端单独跑一次 \`codex exec "hello"\` 验证 codex 是否能独立工作，再回来重试。原始 stderr=${trimForLog(stderr)}${stdoutNote}`,
              ),
            );
          }
        }
        // Generic non-zero exit. Include both stderr AND a stdout tail so
        // failure modes that report errors as JSONL events (codex --json
        // prints structured errors to stdout, not stderr) are visible to
        // the caller.
        const stdoutTail = stdout.trim() ? ` stdout=${trimForLog(stdout)}` : "";
        return reject(
          new Error(
            `${failureLabel}: ${input.agentId} exited with code ${code ?? "null"}${signalNote}.${stderr ? ` stderr=${trimForLog(stderr)}` : ""}${stdoutTail}`,
          ),
        );
      }

      try {
        const content = invocation.parseStdout(stdout, jsonOutput);
        resolve({
          content,
          agentId: input.agentId,
          model: input.model.trim() || "default",
          durationMs,
          stderr: stderr.trim() ? trimForLog(stderr) : undefined,
        });
      } catch (parseError) {
        reject(
          new Error(
            `${failureLabel}: failed to parse ${input.agentId} output (${parseError instanceof Error ? parseError.message : String(parseError)}). stdout=${trimForLog(stdout)}${stderr ? ` stderr=${trimForLog(stderr)}` : ""}`,
          ),
        );
      }
    });
  });
}
