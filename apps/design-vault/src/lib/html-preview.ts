function stripMarkdownFence(input: string) {
  let value = input.trim();
  value = value.replace(/^```[a-z0-9_-]*\s*/i, "");
  value = value.replace(/\s*```\s*$/i, "");
  return value.trim();
}

/**
 * W8.1 — strip the AI-emitted preamble that some CLIs (notably codex
 * exec) prepend to the HTML output. A typical leak looks like:
 *
 *   Here is the complete HTML document:
 *
 *   ```html
 *   <!doctype html>...
 *
 * Without removal, the renderer prints "Here is the complete HTML
 * document:" at the top of the style card, breaking the visual.
 * The function trims anything before the first `<!doctype` / `<html` /
 * standalone `<style>` / `<body>` opening when those tags exist; if
 * none are present the input is returned unchanged so the wrapper
 * fallback (which adds <html><body>...</body></html>) still runs.
 */
function stripAiPreamble(input: string): string {
  const value = input.trim();
  // Find the earliest occurrence of a real HTML opener
  const candidates = [/<!doctype\s+html/i, /<html[\s>]/i, /<head[\s>]/i, /<style[\s>]/i, /<body[\s>]/i];
  let earliest = -1;
  for (const re of candidates) {
    const m = value.search(re);
    if (m >= 0 && (earliest === -1 || m < earliest)) earliest = m;
  }
  if (earliest <= 0) return value;
  // W9.5: preserve DV-PREFLIGHT manifest comments that the model
  // emits BEFORE the HTML body. They're audit-trail metadata, not
  // junk preamble — re-attach them just inside the document so the
  // rendered HTML doesn't lose them but the visible card stays clean.
  const before = value.slice(0, earliest);
  const preflightComment = before.match(/<!--\s*DV-PREFLIGHT:[\s\S]*?-->/i);
  const body = value.slice(earliest);
  if (preflightComment) {
    // Insert just after the first opening tag we hit, before doctype-
    // following content. Easiest: prepend to the trimmed body.
    return `${preflightComment[0]}\n${body}`.trim();
  }
  return body.trim();
}

export function sanitizeHtmlPreview(input: string) {
  return stripAiPreamble(stripMarkdownFence(input))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*(?:rel\s*=\s*["']?stylesheet["']?|href\s*=\s*["']https?:\/\/)[^>]*>/gi, "")
    // Strip `@import url('https://…')` declarations. The regex must NOT
    // get tricked by inner `;` characters inside the URL (Google Fonts
    // URLs encode multi-weight specs as `wght@400;500;700;…`). Walk to
    // the closing `)` then to the terminating `;` instead of taking the
    // first `;` after the protocol.
    .replace(/@import\s+url\(\s*["']?https?:\/\/[^)]*\)[^;]*;/gi, "")
    // Fallback for bare-string `@import "https://…";` (no url()).
    .replace(/@import\s+["']https?:\/\/[^"']*["'][^;]*;/gi, "")
    .replace(/url\(\s*["']?https?:\/\/[^)"']+["']?\s*\)/gi, "none")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .trim();
}

export function normalizeHtmlPreview(input: string, fallbackTitle: string) {
  const stripped = sanitizeHtmlPreview(input);
  if (/<html[\s>]/i.test(stripped) && /<\/html>/i.test(stripped)) return stripped;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${fallbackTitle}</title>
  </head>
  <body>${stripped}</body>
</html>`;
}
