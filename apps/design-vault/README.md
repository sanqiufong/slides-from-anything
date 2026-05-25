# Design Vault

Design Vault turns a public website URL or design-system project source into a reusable Slides from Anything style system: source evidence, semantic design profile, `design.md`, an open-slide theme, HTML/PPT previews, and agent-readable skill packages for imported design systems.

## Development

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3217](http://localhost:3217).

## AI Synthesis Layer

The ingestion pipeline has two distinct layers:

1. Evidence extraction: HTML, CSS, assets, colors, fonts, page topology, behavior hints, responsive hints, source-chain resolution, or imported project file indexes.
2. AI design understanding: an OpenAI-compatible chat model reads that evidence and synthesizes the visual DNA, component language, preview strategy, anti-patterns, and downstream slide guidance.

## Design-System Project Imports

Use the homepage import card and select **设计系统项目** to import a public GitHub repo, npm package name/URL, or zip archive. The project importer creates a local package record with:

- `manifest.json`: normalized package type, source, license, local paths, and agent skill metadata.
- `capabilities.json`: semantic capabilities such as `dashboard-shell`, `data-table`, `horizontal-swipe-deck`, and `agent-skill-workflow`.
- `skill/SKILL.md`: a wrapper skill that routes agents to the generated references and local vendor snapshot.
- `vendor/`: a selected source snapshot, excluding dependency folders and large build artifacts.

Imported design-system projects also get library card previews tailored to their package type: component systems render dashboard/table shells, presentation systems render deck stacks, visual systems render token boards, and skill packages render routing blocks. Library categories are tag-based: Design Vault adds system tags automatically and users can add custom tags from each detail workbench.

For GitHub/npm/zip project imports, Design Vault scans README/docs HTML and Markdown image references, localizes likely demo/screenshot/preview images into `assets/project-demos/`, and uses them as the first card and Preview tab visual evidence before falling back to generated structural previews.

To use a generated skill in another agent app, copy the reference prompt for a one-off task, run the install command for Codex-compatible skill discovery, or point file-aware agents at the generated `skill/SKILL.md` entrypoint.

CLI examples:

```bash
pnpm refresh-design tabler-tabler-test https://github.com/tabler/tabler design-system-project
pnpm refresh-design tabler-core @tabler/core design-system-project
```

Configure the model in `.env.local`:

```bash
DESIGN_VAULT_MODEL_BASE_URL=https://api.openai.com/v1
DESIGN_VAULT_MODEL_API_KEY=
DESIGN_VAULT_MODEL_NAME=gpt-4.1
DESIGN_VAULT_MODEL_TIMEOUT_MS=120000
DESIGN_VAULT_MODEL_RETRIES=3
DESIGN_VAULT_MODEL_RETRY_DELAY_MS=1800
DESIGN_VAULT_MODEL_SYNTHESIS_MAX_TOKENS=4096
```

You can also configure this from the homepage card **AI 理解层 / 执行模型配置**. It scans local agent CLIs on PATH plus common Homebrew, pnpm, nvm, fnm, mise, cargo, and OpenCode install paths, then offers matching OpenAI-compatible endpoint presets. Saving from the UI writes only to local `.env.local` and updates the running dev server process.

Design Vault writes imported designs, generated previews, job files, and community bundle staging to `data/` by default. Set `DESIGN_VAULT_DATA_DIR=/path/to/runtime-data` when embedding it in another project so downloaded templates stay out of the source tree.

By default, if the model is not configured or fails, Design Vault records a heuristic fallback profile so local development still works. Every generated record shows its AI status in the detail workbench and in `design.md`:

- `model-success`: the AI model produced the design-system profile.
- `model-skipped`: model env vars were missing, so the record used fallback synthesis.
- `model-failed`: the model was configured but failed, so the record used fallback synthesis.
- `heuristic-only`: legacy or explicitly fallback profile.

For production-grade ingestion, force the pipeline to fail when the model is not actually used:

```bash
DESIGN_VAULT_REQUIRE_MODEL=1
```

## Useful Commands

```bash
pnpm lint
pnpm build
pnpm validate-design-docs
pnpm refresh-design <slug> <url-or-package> [url|clone-website|design-system-project]
```

`pnpm refresh-design` is useful when a source resolver or synthesis prompt changes and an existing record should be regenerated in place.
