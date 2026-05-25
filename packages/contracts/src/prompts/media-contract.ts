export const MEDIA_GENERATION_CONTRACT = `
---

## Media generation contract (load-bearing - overrides softer wording above)

This project is a **non-web** surface (image / video / audio). The unifying
contract is: skill workflow + project metadata tell you WHAT to make; one
shell command through \`OD_NODE_BIN\` + \`OD_BIN\` is HOW you actually produce bytes.
Do not try to embed binary content inside \`<artifact>\` tags, and do not
write image/video/audio bytes by hand. Always call out to the dispatcher.

The daemon injects these environment variables for agent sessions:

- \`OD_NODE_BIN\` - absolute path to the Node-compatible runtime that started the daemon.
- \`OD_BIN\` - absolute path to the OD CLI script. On POSIX shells run with \`"$OD_NODE_BIN" "$OD_BIN" ...\`.
- \`OD_PROJECT_ID\` - active project id. Pass it as \`--project "$OD_PROJECT_ID"\`.
- \`OD_PROJECT_DIR\` - active project files directory.
- \`OD_DAEMON_URL\` - base URL of the local daemon.

Run media generation through the dispatcher:

\`\`\`bash
"$OD_NODE_BIN" "$OD_BIN" media generate \\
  --project "$OD_PROJECT_ID" \\
  --surface <image|video|audio> \\
  --model <model-id> \\
  --output <filename> \\
  --prompt "<full prompt>" \\
  [--aspect 1:1|16:9|9:16|4:3|3:4] \\
  [--length <seconds>] \\
  [--duration <seconds>] \\
  [--audio-kind music|speech|sfx] \\
  [--voice <provider-voice-id>]
\`\`\`

Always quote the prompt value. Never splice unquoted user text into the
command line. The command returns JSON containing either a final
\`file\` object or a \`taskId\` for long-running renders.

For long-running renders, continue with:

\`\`\`bash
"$OD_NODE_BIN" "$OD_BIN" media wait <taskId> --since <nextSince>
\`\`\`

\`media wait\` exits \`0\` when done, \`2\` when still running, and \`5\`
when the provider task failed. Exit code \`2\` is not an error; keep polling
with the returned \`nextSince\`.

Do not emit \`<artifact>\` blocks for media. The artifact is the generated
file written by the dispatcher, and the file viewer will render images,
videos, and audio automatically. If generation fails, surface the actual
stderr / exit status instead of inventing a diagnosis.

Special case: \`hyperframes-html\` video projects may author composition HTML
in \`.hyperframes-cache/\`, then render through the daemon-backed dispatcher
with \`--composition-dir\` so Chrome-bound rendering runs outside the agent
sandbox.
`;

export const OPENPPT_DECK_MEDIA_CONTRACT = `
---

## Auxiliary skill — OpenPPT deck media generation (load-bearing)

This project is still an **OpenPPT Web-PPT deck**. The canonical deliverable
remains \`slides/<slideId>/index.tsx\`, but project metadata says generated
imagery is part of this deck. Natural-language requests such as "use an image
model", "media model", "generate images", "key-page illustrations",
"配图", "图片生成", "svg/image", "图片辅助描述", or "关键页面使用媒体模型"
are not satisfied in the final deck by writing a placeholder box, SVG-only
substitute, or a caption. You must produce real image bytes through the media
dispatcher when an image model is configured and available, save them under the
deck folder, import them, and render them in the slide source.

Read \`deckMediaImageModel\`, \`deckMediaAspect\`, and
\`deckMediaKeySlidePolicy\` from Project metadata. \`deckMediaImageModel\` is
the configured image model when the project has one. If it is absent, no generic
default image model is implied; do not assume \`gpt-image-2\` or any other
specific provider is available. The default deck image aspect is \`16:9\`.

If \`deckMediaImageModel\` is absent, do **not** call
\`"$OD_NODE_BIN" "$OD_BIN" media generate\` at all. The CLI requires
\`--model\` and has no backend default; calling it without a concrete model is
an invalid command. In that state, keep writing the deck, mark the intended
media slot with \`data-openppt-media-status="pending"\`, label the deck
\`needs media replacement\`, and ask the user to choose one available image
model before retrying the generation step.

Every generated deck image must inherit the same visual system as
\`slides/<slideId>/index.tsx\`. If a Vault template, active Design Vault
context, or active DESIGN.md is present, write the image prompt from the
pre-generation transfer plan: source anchors, page archetype, media treatment,
chrome/caption relationship, line/border language, density, and motion/state
cues. Do not satisfy the style by color alone. The daemon may append an
"OpenPPT media prompt style context" to image tasks when it can resolve an
active Vault system; treat that appendix as a provider style brief, not visible
image text.

Slot-first rule: write the page layout and Media Slot Plan before dispatching
image generation. Each image prompt must include the intended slide page,
output filename, narrative job, container dimensions or CSS size, final aspect
ratio, fit/crop policy, focal-safe zone, and whether the asset should include
negative space for adjacent typography or chrome. The generated image must be
composed for that exact slot. Do not create a generic image and resize, stretch,
or crop it until it happens to fit the deck.

Crop-safety rule: the generated bitmap is the final visible crop. For diagrams,
UI/screenshots, annotated layouts, process maps, and any image with readable
text, place all meaningful marks inside an inner safe area with quiet padding
around every edge. The prompt must explicitly forbid half icons, cropped words,
cut-off arrows, clipped cards, partial people, and continuation lines leaving
the canvas. These information-bearing images must be embedded with
\`object-fit: contain\` or another no-crop layout unless the model-generated
asset already includes all meaningful content safely inside the exact slot
aspect.

For process diagrams and abstract visuals, translate the source design system
into diagram marks and composition language. Avoid generic cyber glow, fantasy
scenes, neon HUDs, stock SaaS gradients, or cinematic concept art unless those
traits appear in the selected source evidence.

Required command when \`deckMediaImageModel\` is present:

\`\`\`bash
"$OD_NODE_BIN" "$OD_BIN" media generate \\
  --project "$OD_PROJECT_ID" \\
  --surface image \\
  --model <deckMediaImageModel> \\
  --aspect <slot-matched aspect from deckMediaAspect or the Media Slot Plan> \\
  --output "slides/<slideId>/assets/<descriptive-slug>.png" \\
  --prompt "<full image prompt tied to the slide story, selected design system, and planned slide container>"
\`\`\`

Use only project-relative outputs under \`slides/<slideId>/assets/\`. After the
command succeeds, import the asset in \`slides/<slideId>/index.tsx\` and render
it with \`<img src={...} />\` or a CSS background. If the dispatcher returns a
\`taskId\`, keep polling with \`media wait\` until it returns a final \`file\`
object or a provider failure.

Only pass \`--model <deckMediaImageModel>\` when Project metadata names a model
or the user explicitly selects one in chat. Do not substitute \`gpt-image-2\`
as a hidden fallback. If no model is configured, keep authoring the deck layout
and mark the affected media region as pending instead of blocking the whole
slide source. Never attempt to "test" media generation by omitting \`--model\`;
that only creates a known configuration failure.

If \`deckMedia.required\` is true, do not mark the task presentation-ready until
at least one real generated image file has been written under
\`slides/<slideId>/assets/\` and rendered from \`slides/<slideId>/index.tsx\`
via \`<img src={...} />\` or a CSS \`backgroundImage\`. Also do not leave
\`ImagePlaceholder\`, "Media-model image", "insert generated image", or any
textual stand-in for a generated picture in presentation-ready source. If media
generation fails, surface the exact stderr / exit status to the user. You may
still write or keep the deck source with an explicit pending media slot so
layout and narrative work can continue. Mark that region with
\`data-openppt-media-status="pending"\`, include the intended output path and
failure details in nearby source comments or structured data, and label the
deck \`needs media replacement\` in your final status. Do not silently downgrade
to an \`ImagePlaceholder\`, do not claim the deck is complete, do not call it
export-ready, and do not fake completion with a written description of the
image. Only try another model when that model is explicitly configured or the
user selects it.
`;
