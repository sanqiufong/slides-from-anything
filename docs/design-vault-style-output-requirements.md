# Design Vault Style Output Requirements for OpenPPT

OpenPPT should choose style templates inside the chat, after the user provides the deck brief. To make matching reliable, each Design Vault template needs machine-readable style and fit metadata, not only a preview and theme file.

## Required Fields

Add or ensure these fields under each design's `profile`:

- `visualThesis`: one sentence describing the core visual idea and what makes it distinctive.
- `archetype`: concise category, such as `type foundry / variable font specimen`, `dark event / developer conference`, `consumer wallet / money app`, `editorial research report`.
- `toneTags`: 3-8 normalized tags, such as `editorial`, `technical`, `premium`, `experimental`, `warm`, `minimal`, `dense`, `playful`.
- `useCaseTags`: 3-8 normalized task tags, such as `investor_pitch`, `strategy_review`, `product_demo`, `sales_deck`, `research_report`, `training_deck`, `keynote`, `case_study`.
- `audienceFit`: array of audience labels this style fits, such as `executives`, `investors`, `developers`, `enterprise_buyers`, `students`, `public_event`.
- `contentDensity`: one of `low`, `medium`, `high`, plus a short rationale.
- `narrativeFit`: array of story modes, such as `vision`, `problem_solution`, `data_story`, `product_walkthrough`, `framework_explainer`, `portfolio_showcase`.
- `colorRoles`: existing `{ background, text, brandPrimary, brandSecondary }`, with optional `notes`.
- `openSlideGuidance`: existing `{ direction, coverApproach, layoutApproach, motionApproach }`.
- `avoidWhen`: short list of cases where the template is a bad fit.
- `matchingRationale`: 2-4 reusable reasons an agent can cite when recommending this template.

## Optional But Valuable

- `slidePatterns`: recommended slide types, such as `hero_statement`, `section_divider`, `data_grid`, `timeline`, `comparison`, `quote`, `demo_sequence`.
- `typographyPersonality`: short description of display/body/mono behavior.
- `layoutIntensity`: one of `quiet`, `structured`, `expressive`, `immersive`.
- `assetNeeds`: whether the template depends on screenshots, photography, product UI, diagrams, or can work text-only.
- `mediaPromptGrammar`: how generated images should inherit this source, including crop/framing, image density, subject treatment, chrome/caption relationship, line/border language, and negative prompts for generic visual tropes.
- `localizationFit`: language notes, especially whether Chinese/English mixed typography works.

## Matching Contract

OpenPPT will feed these fields to the agent as a compact catalog. The agent should recommend 2-3 templates based on:

- task fit: deck purpose and story
- audience fit: who will watch/read it
- content fit: density, data, screenshots, diagrams, or text-heavy narrative
- visual fit: tone, palette, typography, layout rhythm

The agent must explain the recommendation in plain language and ask the user to choose before generation.

## Generation Contract

Once a template is locked, OpenPPT should treat it as a composition system, not
as a palette. Before writing slide source or media prompts, the agent should
derive a transfer plan from the template's source anchors:

- page archetypes and what kind of slide each archetype maps to
- layout grammar, including chrome, media regions, rows/tables, grids, and density
- media prompt grammar for every generated image
- motion/state grammar based only on observed source behavior
- anti-patterns that would make the result read as generic rather than source-derived

Generated images are part of this contract. A key-page image prompt should carry
the selected template's media language before it carries the deck topic; for
example, a case-study portfolio source should generate portfolio/case imagery
and chrome-aware crops rather than a generic glowing process diagram.
