/**
 * Parser for inline <question-form>...</question-form> blocks the agent
 * emits to ask the user a structured set of clarifying questions before
 * starting design work.
 *
 * Body must be JSON. Example:
 *
 *   <question-form id="discovery" title="Quick brief">
 *   {
 *     "questions": [
 *       { "id": "platform", "label": "Platform", "type": "radio",
 *         "options": ["Mobile (iOS/Android)", "Desktop web", "Responsive"],
 *         "required": true },
 *       { "id": "audience", "label": "Primary audience", "type": "text",
 *         "placeholder": "e.g. SaaS buyers" }
 *     ]
 *   }
 *   </question-form>
 *
 * Splits a final assistant text payload into ordered segments — prose +
 * forms — so AssistantMessage can render the form inline.
 */
export type QuestionType =
  | 'radio'
  | 'checkbox'
  | 'select'
  | 'text'
  | 'textarea'
  | 'direction-cards';

/**
 * Rich card metadata for a single `direction-cards` option. The picker
 * renders a swatch row, a serif/sans type sample, a mood blurb, and a
 * "refs" line so users can scan visually instead of squinting at radio
 * labels. The agent emits this metadata inline in the form JSON so the
 * UI can render without additional fetches.
 */
export interface DirectionCard {
  /** The radio value — what comes back in the user's answer. Match a label in `options`. */
  id: string;
  /** Short headline on the card (e.g. "Editorial — Monocle / FT magazine"). */
  label: string;
  /** One- or two-sentence mood blurb. */
  mood: string;
  /** Real-world exemplars (≤ 4). */
  references: string[];
  /** 4–6 swatch hex / OKLch strings for the palette row. */
  palette: string[];
  /** Display (headline) font stack, used to render the live "Aa" sample. */
  displayFont: string;
  /** Body font stack, used to render the secondary sample. */
  bodyFont: string;
}

export interface FormQuestion {
  id: string;
  label: string;
  type: QuestionType;
  options?: string[];
  placeholder?: string;
  required?: boolean;
  help?: string;
  defaultValue?: string | string[];
  /** Only applies when `type === 'checkbox'`. Caps the number of selected options. */
  maxSelections?: number;
  /** Only present when `type === 'direction-cards'`. Mapped to options by `id`. */
  cards?: DirectionCard[];
}

export interface QuestionForm {
  id: string;
  title: string;
  description?: string;
  questions: FormQuestion[];
  submitLabel?: string;
}

export type FormSegment =
  | { kind: 'text'; text: string }
  | { kind: 'form'; form: QuestionForm; raw: string };

const OPEN_RE = /<question-form\b([^>]*)>/i;
const CLOSE_TAG = '</question-form>';

export function splitOnQuestionForms(input: string): FormSegment[] {
  const out: FormSegment[] = [];
  let cursor = 0;
  // Scan repeatedly for <question-form> opens; for each, locate the
  // matching close tag and try to parse the JSON body. Anything that
  // doesn't parse cleanly stays in the prose stream.
  while (cursor < input.length) {
    const slice = input.slice(cursor);
    const m = OPEN_RE.exec(slice);
    if (!m) {
      out.push({ kind: 'text', text: slice });
      break;
    }
    const openStart = cursor + m.index;
    const openEnd = openStart + m[0].length;
    const closeIdx = input.indexOf(CLOSE_TAG, openEnd);
    if (closeIdx === -1) {
      // Unterminated — leave the rest as prose so we don't swallow it.
      out.push({ kind: 'text', text: slice });
      break;
    }
    if (openStart > cursor) {
      out.push({ kind: 'text', text: input.slice(cursor, openStart) });
    }
    const body = input.slice(openEnd, closeIdx);
    const attrs = parseAttrs(m[1] ?? '');
    const parsedForm = tryParseForm(body, attrs);
    const form = parsedForm
      ? hydrateVaultTemplateOptionsFromContext(parsedForm, input.slice(0, openStart))
      : null;
    if (form) {
      out.push({ kind: 'form', form, raw: input.slice(openStart, closeIdx + CLOSE_TAG.length) });
    } else {
      // Malformed — keep raw text so the user can still see it.
      out.push({ kind: 'text', text: input.slice(openStart, closeIdx + CLOSE_TAG.length) });
    }
    cursor = closeIdx + CLOSE_TAG.length;
  }
  return out;
}

function hydrateVaultTemplateOptionsFromContext(
  form: QuestionForm,
  context: string,
): QuestionForm {
  const inferredOptions = extractVaultTemplateOptionsFromText(context);
  if (inferredOptions.length === 0) return form;

  let changed = false;
  const questions = form.questions.map((q) => {
    if (q.type !== 'radio') return q;
    const existingOptions = q.options?.filter((option) => option.trim().length > 0) ?? [];
    if (existingOptions.length > 0) return q;
    if (!isVaultTemplateFormQuestion(form, q)) return q;
    changed = true;
    return { ...q, options: inferredOptions };
  });

  return changed ? { ...form, questions } : form;
}

function isVaultTemplateFormQuestion(_form: QuestionForm, q: FormQuestion): boolean {
  const haystack = [
    q.id,
    q.label,
    q.help,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return /(vault|template|模板|visual|视觉|style|风格|design\s*system|样式)/i.test(haystack);
}

function extractVaultTemplateOptionsFromText(text: string): string[] {
  const relevantText = templateRecommendationContext(text);
  if (!relevantText) return [];
  const lines = relevantText.replace(/\r/g, '').split('\n');
  const entries: Array<{ title: string; reason: string[] }> = [];
  let current: { title: string; reason: string[] } | null = null;

  const finishCurrent = () => {
    if (!current) return;
    const reason = cleanTemplateReason(current.reason.join(' '));
    const option = reason ? `${current.title} — ${reason}` : current.title;
    entries.push({ title: option, reason: [] });
    current = null;
  };

  for (const line of lines) {
    const heading = parseTemplateRecommendationHeading(line);
    if (heading) {
      finishCurrent();
      current = { title: heading, reason: [] };
      continue;
    }
    if (current && line.trim()) {
      current.reason.push(line.trim());
    }
  }
  finishCurrent();

  const seen = new Set<string>();
  const options: string[] = [];
  for (const entry of entries) {
    const option = entry.title.trim();
    const key = option.toLowerCase();
    if (!option || seen.has(key)) continue;
    seen.add(key);
    options.push(option);
    if (options.length >= 6) break;
  }
  return options;
}

function templateRecommendationContext(text: string): string {
  const matches = Array.from(text.matchAll(/(?:design\s+vault|vault|template|templates|模板|视觉模板|风格模板|推荐)/gi));
  const last = matches.at(-1);
  if (!last || last.index === undefined) return '';
  return text.slice(Math.max(0, last.index - 120));
}

function parseTemplateRecommendationHeading(line: string): string | null {
  const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
  if (!match) return null;
  const raw = match[1] ?? '';
  const title = cleanTemplateTitle(raw);
  if (!isLikelyTemplateTitle(title)) return null;
  return title;
}

function cleanTemplateTitle(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+[—–]\s+.*$/, '')
    .replace(/[：:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTemplateReason(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function isLikelyTemplateTitle(value: string): boolean {
  if (value.length < 3 || value.length > 110) return false;
  if (/^(收到|基于|以下|模板|选择|推荐|let the agent|agent choose)/i.test(value)) return false;
  if (/[。！？!?；;]$/.test(value)) return false;
  return /[a-zA-Z\u4e00-\u9fff]/.test(value);
}

function parseAttrs(raw: string): Record<string, string> {
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1] as string] = (m[2] ?? m[3] ?? '') as string;
  }
  return out;
}

function tryParseForm(body: string, attrs: Record<string, string>): QuestionForm | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  // Allow the JSON to be wrapped in a fenced ```json block — common when
  // the model echoes its own indented body.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : null;
  if (!rawQuestions) return null;
  const questions: FormQuestion[] = [];
  const questionIds = new Set<string>();
  rawQuestions.forEach((q, i) => {
    if (!q || typeof q !== 'object') return;
    const qo = q as Record<string, unknown>;
    const id = uniqueQuestionId(
      questionIds,
      typeof qo.id === 'string' ? qo.id : '',
      `q${i + 1}`,
    );
    const label = typeof qo.label === 'string' ? qo.label : id;
    const type = normalizeType(qo.type);
    const options = Array.isArray(qo.options)
      ? qo.options.filter((o): o is string => typeof o === 'string')
      : undefined;
    const placeholder = typeof qo.placeholder === 'string' ? qo.placeholder : undefined;
    const help = typeof qo.help === 'string' ? qo.help : undefined;
    const required = qo.required === true;
    const maxSelections =
      typeof qo.maxSelections === 'number' &&
      Number.isInteger(qo.maxSelections) &&
      qo.maxSelections > 0
        ? qo.maxSelections
        : undefined;
    const cards = parseDirectionCards(qo.cards);
    const defaultValue =
      typeof qo.defaultValue === 'string'
        ? qo.defaultValue
        : Array.isArray(qo.defaultValue)
          ? qo.defaultValue.filter((v): v is string => typeof v === 'string')
          : typeof qo.default === 'string'
            ? qo.default
            : undefined;
    questions.push({
      id,
      label,
      type,
      ...(options ? { options } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(help ? { help } : {}),
      ...(required ? { required } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(maxSelections !== undefined && type === 'checkbox' ? { maxSelections } : {}),
      ...(cards ? { cards } : {}),
    });
  });
  if (questions.length === 0) return null;
  const id = attrs.id ?? (typeof obj.id === 'string' ? obj.id : 'discovery');
  const title =
    attrs.title ?? (typeof obj.title === 'string' ? obj.title : 'A few quick questions');
  const description = typeof obj.description === 'string' ? obj.description : undefined;
  const submitLabel = typeof obj.submitLabel === 'string' ? obj.submitLabel : undefined;
  return {
    id,
    title,
    questions,
    ...(description ? { description } : {}),
    ...(submitLabel ? { submitLabel } : {}),
  };
}

function uniqueQuestionId(seen: Set<string>, rawId: string, fallback: string): string {
  const base = rawId.trim().length > 0 ? rawId.trim() : fallback;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

function normalizeType(raw: unknown): QuestionType {
  if (typeof raw !== 'string') return 'text';
  const lower = raw.toLowerCase().trim();
  if (lower === 'radio' || lower === 'single' || lower === 'choice') return 'radio';
  if (lower === 'checkbox' || lower === 'multi' || lower === 'multiple') return 'checkbox';
  if (lower === 'select' || lower === 'dropdown') return 'select';
  if (lower === 'textarea' || lower === 'long' || lower === 'paragraph') return 'textarea';
  if (
    lower === 'direction-cards' ||
    lower === 'directions' ||
    lower === 'cards' ||
    lower === 'direction'
  )
    return 'direction-cards';
  return 'text';
}

function parseDirectionCards(raw: unknown): DirectionCard[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DirectionCard[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id.trim().length > 0 ? e.id.trim() : null;
    const label = typeof e.label === 'string' ? e.label : null;
    if (id === null || label === null) continue;
    const mood = typeof e.mood === 'string' ? e.mood : '';
    const references = Array.isArray(e.references)
      ? e.references.filter((r): r is string => typeof r === 'string').slice(0, 6)
      : [];
    const palette = Array.isArray(e.palette)
      ? e.palette.filter((p): p is string => typeof p === 'string').slice(0, 8)
      : [];
    const displayFont = typeof e.displayFont === 'string' ? e.displayFont : 'Georgia, serif';
    const bodyFont =
      typeof e.bodyFont === 'string'
        ? e.bodyFont
        : '-apple-system, system-ui, sans-serif';
    out.push({ id, label, mood, references, palette, displayFont, bodyFont });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Format a finished set of answers into a prose user message that the
 * agent can read on its next turn. The shape is stable enough that the
 * agent can recognise "the form was answered" without us emitting any
 * structured wrapper.
 */
export function formatFormAnswers(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
): string {
  const lines: string[] = [];
  lines.push(`[form answers — ${form.id}]`);
  for (const q of form.questions) {
    const v = answers[q.id];
    let display: string;
    if (Array.isArray(v)) display = v.length > 0 ? v.join(', ') : '(skipped)';
    else if (typeof v === 'string') display = v.trim().length > 0 ? v.trim() : '(skipped)';
    else display = '(skipped)';
    lines.push(`- ${q.label}: ${display}`);
  }
  return lines.join('\n');
}
