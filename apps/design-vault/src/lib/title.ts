/**
 * Shared display-title hygiene for the vault library card and the in-preview
 * headline. Two leaks this guards against:
 *   1. The internal archetype/system boilerplate synthesis appends when the
 *      model produced no proper system name ("… — source-derived web style
 *      system", "… Source Profile") — classification must not reach the UI.
 *   2. Crawled page <title> that trailed navigation button labels
 *      ("We're Your Cloud Ops Team - EarlyDogMenu Close").
 */

const BOILERPLATE_SUFFIXES: RegExp[] = [
  /\s*[-–—]\s*templates? by canva.*$/i,
  /\s+presentation\s+in\s+.+?\s+style$/i,
  /\s*[-–—]\s*source[- ]derived\b.*$/i,
  /\s+source[- ]derived\s+web\s+style\s+system$/i,
  /\s+source\s+profile$/i,
  // Crawled page <title> trailing nav-button labels, e.g.
  // "We're Your Cloud Ops Team - EarlyDogMenu Close" → drop "- …Menu Close".
  // "menu" may be glued to the brand word, so no left word-boundary.
  /\s*[-–—|]\s*\S*menu\s+close\s*$/i,
  /\s+template\s*$/i,
];

/** Strip the archetype/system/canva boilerplate suffixes from a name. */
export function stripTitleBoilerplate(value: string | undefined | null): string {
  let out = (value ?? "").replace(/\s+/g, " ").trim();
  for (const re of BOILERPLATE_SUFFIXES) out = out.replace(re, "").trim();
  return out;
}

/**
 * Best human label for a design. Prefers the (cleaned) source page title since
 * that is what people recognise; falls back to the abstracted system name when
 * the title clearly captured navigation chrome (e.g. "… Menu … Close").
 */
export function cleanDisplayTitle(systemName: string | undefined | null, title: string): string {
  const cleanedTitle = stripTitleBoilerplate(title);
  const cleanedName = stripTitleBoilerplate(systemName);
  const looksLikeChrome = /menu\s+close/i.test(cleanedTitle) || /\bskip to\b/i.test(cleanedTitle);
  if (looksLikeChrome && cleanedName) return cleanedName;
  return cleanedTitle || cleanedName || title;
}
