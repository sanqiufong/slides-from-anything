/**
 * Parse theme CSS variable blocks from Design Vault vendor markdown files
 * (e.g. references/themes.md, references/themes-swiss.md).
 *
 * Each H2 section that contains a fenced CSS block is treated as one theme.
 * The parser extracts the theme name, optional description/suitableFor
 * metadata, and all `--variable: value;` declarations.
 */

export type ParsedThemeMarkdownBlock = {
  themeName: string;
  description?: string;
  suitableFor?: string;
  variables: Record<string, string>;
};

/**
 * Style identity inferred from a single `themes*.md` file. Used by the
 * P4 sibling-splitter in project-ingestion to detect when a single skill
 * package contains TWO independent visual systems and to derive a slug
 * suffix for each (e.g. `guizang-ppt-skill-magazine` +
 * `guizang-ppt-skill-swiss`).
 *
 * `styleId` is the slug-safe identifier; `styleName` is the display
 * label rendered in the gallery and sibling.json.
 */
export type ThemeFileStyleIdentity = {
  styleId: string;
  styleName: string;
};

const HEX_RE = /^#[0-9a-f]{3,8}$/i;

/**
 * Derive a style identity from a theme markdown file's path + first H1
 * heading. The rules below are intentionally simple — they prefer
 * filename suffixes (`themes-swiss.md` → `swiss`) and fall back to the
 * first ASCII or pinyin-ish word in the H1 (e.g. "电子杂志风格 · Style A"
 * → `style-a`). When no signal exists, returns `primary`.
 *
 *   themes.md            → { styleId: "primary", styleName: H1 || "Primary" }
 *   themes-swiss.md      → { styleId: "swiss",   styleName: H1 || "Swiss"   }
 *   themes-y2k.md        → { styleId: "y2k",     styleName: H1 || "Y2K"     }
 *   themes-style-a.md    → { styleId: "style-a", styleName: H1 || "Style A" }
 */
export function inferThemeFileStyle(relativePath: string, markdown: string): ThemeFileStyleIdentity {
  // Filename suffix detection
  const fileName = relativePath.split("/").pop() ?? relativePath;
  const suffixMatch = fileName.match(/^themes-([a-z0-9][\w-]*)\.md$/i);
  let styleId = "primary";
  if (suffixMatch) {
    styleId = suffixMatch[1].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!styleId) styleId = "variant";
  }

  // H1-derived display name. Picks the first H1 line, strips markdown
  // decoration, then drops file-purpose suffixes ("· 主题色预设" /
  // "Themes" / "Color Themes") so the visible identity reads as the
  // STYLE NAME (e.g. "瑞士国际主义风格") not as a file label.
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  let styleName: string;
  if (h1Match) {
    let raw = h1Match[1].replace(/[#*`]/g, "").trim();
    // Truncate at the first " · " or " — " or " - " delimiter — these
    // typically separate the style name from the file's purpose.
    const delim = raw.search(/\s+[·—–-]\s+/);
    if (delim > 0) raw = raw.slice(0, delim).trim();
    // Strip generic file-purpose tokens at either end.
    raw = raw.replace(/(?:主题色预设|主题预设|色板预设|Color Themes?|Themes?|Palette)[\s（(].*$/i, "").trim();
    raw = raw.replace(/[（(].*$/, "").trim();
    styleName = raw.slice(0, 60) || (suffixMatch ? capitalise(styleId) : "Primary");
  } else {
    styleName = suffixMatch ? capitalise(styleId) : "Primary";
  }

  return { styleId, styleName };
}

function capitalise(s: string): string {
  return s.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/**
 * Parse a theme markdown file into structured theme blocks.
 *
 * Recognises `## <name>` sections. Within each section:
 *   - First fenced ` ```css ` block is scanned for `--var: value;` lines
 *   - Lines matching `**调性**:` provide the description
 *   - Lines matching `**适合**:` provide suitableFor
 *
 * Variable names are normalised to lowercase with leading `--` stripped
 * (e.g. `--ink-rgb` becomes `ink-rgb`).
 */
export function parseThemeMarkdown(markdown: string): ParsedThemeMarkdownBlock[] {
  const themes: ParsedThemeMarkdownBlock[] = [];
  // Split into H2 sections
  const sections = markdown.split(/^## /m).slice(1); // skip preamble before first ##

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const headerLine = lines[0]?.trim() ?? "";
    const themeName = headerLine.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (!themeName) continue;

    // Skip non-theme sections (e.g. "使用方法", "推荐选择参考", "切换原则")
    const sectionText = section.toLowerCase();
    if (!sectionText.includes("```css")) continue;

    let description: string | undefined;
    let suitableFor: string | undefined;

    // Extract metadata from body text
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\*\*调性\*\*\s*[:：]/.test(trimmed)) {
        description = trimmed.replace(/^\*\*调性\*\*\s*[:：]\s*/, "").trim();
      }
      if (/^\*\*适合\*\*\s*[:：]/.test(trimmed)) {
        suitableFor = trimmed.replace(/^\*\*适合\*\*\s*[:：]\s*/, "").trim();
      }
    }

    // Extract CSS variables from the first fenced CSS block
    const variables: Record<string, string> = {};
    let inCssBlock = false;
    let foundCssBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!foundCssBlock && /^```css\s*$/i.test(trimmed)) {
        inCssBlock = true;
        foundCssBlock = true;
        continue;
      }
      if (inCssBlock && trimmed === "```") {
        inCssBlock = false;
        continue;
      }
      if (inCssBlock) {
        // Match --variable-name: value; or --variable-name: value
        const match = trimmed.match(/^--([\w-]+)\s*:\s*(.+?)\s*;?\s*$/);
        if (match) {
          const varName = match[1].toLowerCase();
          const value = match[2].trim();
          variables[varName] = value;
        }
      }
    }

    if (Object.keys(variables).length > 0) {
      themes.push({ themeName, description, suitableFor, variables });
    }
  }

  return themes;
}

/**
 * Check if a string is a valid CSS hex color.
 */
export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}
