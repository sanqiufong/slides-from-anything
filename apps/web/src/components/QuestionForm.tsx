import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import type { DirectionCard, QuestionForm } from '../artifacts/question-form';
import { formatFormAnswers } from '../artifacts/question-form';
import {
  fetchVaultDesigns,
  fetchVaultDiscovery,
  syncVaultDesignSystems,
} from '../providers/registry';
import type { VaultDesignMeta } from '../types';
import { buildVaultDeepLinkUrl } from '../utils/vaultDeepLink';
import { vaultTemplateCoverPreviewSource } from '../utils/vaultPreview';
import { DesignVaultInstallGate } from './DesignVaultInstallGate';
import { Icon } from './Icon';
import { VaultPreviewFrame } from './VaultPreviewFrame';

interface Props {
  form: QuestionForm;
  // Whether the user can still submit answers. The owning AssistantMessage
  // disables the form when the assistant turn is no longer the most recent
  // one (i.e. the user has already moved past it).
  interactive: boolean;
  // Pre-existing answers — when we detect a follow-up user message that
  // begins with "[form answers — <id>]", we parse it back out and pass it
  // here so the rendered form reflects what was sent.
  submittedAnswers?: Record<string, string | string[]>;
  onSubmit?: (text: string, answers: Record<string, string | string[]>) => void;
  activeVaultTemplateSlug?: string | null;
  onVaultTemplateSelect?: (design: VaultDesignMeta) => void | Promise<void>;
}

export function QuestionFormView({
  form,
  interactive,
  submittedAnswers,
  onSubmit,
  activeVaultTemplateSlug,
  onVaultTemplateSelect,
}: Props) {
  const t = useT();
  const initial = useMemo(() => buildInitialState(form, submittedAnswers), [form, submittedAnswers]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(initial);
  const [vaultDesigns, setVaultDesigns] = useState<VaultDesignMeta[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultRefreshing, setVaultRefreshing] = useState(false);
  const [vaultRefreshMessage, setVaultRefreshMessage] = useState<string | null>(null);
  const [vaultLoadError, setVaultLoadError] = useState<string | null>(null);
  const [vaultPickerQuestionId, setVaultPickerQuestionId] = useState<string | null>(null);
  const [vaultPickerSearch, setVaultPickerSearch] = useState('');
  const [vaultInstallGateOpen, setVaultInstallGateOpen] = useState(false);
  const hasVaultTemplateQuestion = useMemo(
    () => form.questions.some((q) => isVaultTemplateQuestion(form, q)),
    [form],
  );
  const displayTitle = hasVaultTemplateQuestion && isVaultTemplateFormId(form.id)
    ? t('qf.vaultTemplateTitle')
    : form.title;
  const locked = !interactive || !onSubmit || submittedAnswers !== undefined;

  useEffect(() => {
    if (!hasVaultTemplateQuestion) return undefined;
    let cancelled = false;
    setVaultLoading(true);
    setVaultLoadError(null);
    void fetchVaultDesigns()
      .then((designs) => {
        if (!cancelled) setVaultDesigns(designs);
      })
      .catch((error) => {
        if (!cancelled) setVaultLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setVaultLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasVaultTemplateQuestion]);

  const activeVaultPickerQuestion = useMemo(
    () => form.questions.find((q) => q.id === vaultPickerQuestionId && isVaultTemplateQuestion(form, q)) ?? null,
    [form, vaultPickerQuestionId],
  );

  const filteredVaultDesigns = useMemo(
    () => filterVaultDesigns(vaultDesigns, vaultPickerSearch),
    [vaultDesigns, vaultPickerSearch],
  );

  function update(id: string, value: string | string[]) {
    if (locked) return;
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  function selectVaultDesign(questionId: string, design: VaultDesignMeta) {
    if (locked) return;
    update(questionId, vaultDesignToOption(design));
    setVaultPickerQuestionId(null);
    setVaultPickerSearch('');
    void onVaultTemplateSelect?.(design);
  }

  async function refreshVaultTemplatesFromVault() {
    if (vaultRefreshing) return;
    setVaultRefreshing(true);
    setVaultLoadError(null);
    setVaultRefreshMessage(null);
    try {
      await syncVaultDesignSystems();
      const designs = await fetchVaultDesigns();
      setVaultDesigns(designs);
      setVaultRefreshMessage(t('qf.vaultInstallRefreshDone', { count: designs.length }));
    } catch (error) {
      setVaultLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setVaultRefreshing(false);
    }
  }

  async function openDesignVaultForInstall() {
    if (typeof window === 'undefined') return;
    const next = await fetchVaultDiscovery();
    if (next?.state === 'running') {
      window.location.href = buildVaultDeepLinkUrl(next.baseUrl, window.location.href);
      return;
    }
    setVaultPickerQuestionId(null);
    setVaultPickerSearch('');
    setVaultInstallGateOpen(true);
  }

  function toggleCheckbox(id: string, option: string, maxSelections?: number) {
    if (locked) return;
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      const has = current.includes(option);
      if (!has && maxSelections !== undefined && current.length >= maxSelections) {
        return prev;
      }
      const next = has ? current.filter((v) => v !== option) : [...current, option];
      return { ...prev, [id]: next };
    });
  }

  function missingRequired(): string | null {
    for (const q of form.questions) {
      if (!q.required) continue;
      const v = answers[q.id];
      if (Array.isArray(v) ? v.length === 0 : !(typeof v === 'string' && v.trim().length > 0)) {
        return q.label;
      }
    }
    return null;
  }

  function handleSubmit() {
    if (locked || !onSubmit) return;
    if (!withinSelectionLimits) return;
    const missing = missingRequired();
    if (missing) {
      // Soft inline guard — surface via aria but don't alert; the disabled
      // state of the submit button covers most cases.
      return;
    }
    onSubmit(formatFormAnswers(form, answers), answers);
  }

  const required = form.questions.filter((q) => q.required);
  const withinSelectionLimits = form.questions.every((q) => {
    if (q.type !== 'checkbox' || q.maxSelections === undefined) return true;
    const v = answers[q.id];
    return !Array.isArray(v) || v.length <= q.maxSelections;
  });
  const ready = withinSelectionLimits && required.every((q) => {
    const v = answers[q.id];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
  });

  return (
    <div className={`question-form${locked ? ' question-form-locked' : ''}`}>
      <div className="question-form-head">
        <span className="question-form-icon" aria-hidden>?</span>
        <div className="question-form-titles">
          <div className="question-form-title">{displayTitle}</div>
          {form.description ? (
            <div className="question-form-desc">{form.description}</div>
          ) : null}
        </div>
        {locked ? <span className="question-form-pill">{t('qf.answered')}</span> : null}
      </div>
      <div className="question-form-body">
        {form.questions.map((q) => {
          const value = answers[q.id];
          const vaultTemplateQuestion = isVaultTemplateQuestion(form, q);
          const rawOptions = q.options ?? [];
          const mismatchedVaultOptions =
            q.type === 'radio' &&
            !vaultTemplateQuestion &&
            rawOptions.length > 0 &&
            rawOptions.every((opt) => looksLikeVaultTemplateOption(opt));
          const displayLabel = vaultTemplateQuestion ? t('qf.vaultTemplateLabel') : q.label;
          const vaultOptions = rawOptions;
          const plainOptions = mismatchedVaultOptions ? [] : rawOptions;
          const activeVaultTemplateSlugForQuestion = locked ? null : activeVaultTemplateSlug;
          const activeVaultDesign =
            vaultTemplateQuestion && activeVaultTemplateSlugForQuestion
              ? vaultDesigns.find((design) => design.slug === activeVaultTemplateSlugForQuestion) ?? null
              : null;
          const compactAnsweredVaultOptions =
            vaultTemplateQuestion &&
            locked &&
            answeredValuePresent(value);
          const renderedVaultOptions = compactAnsweredVaultOptions
            ? vaultOptions.filter((opt) => {
                const slug = parseVaultTemplateOption(opt).slug;
                return isOptionSelected(value, opt) || Boolean(slug && slug === activeVaultTemplateSlugForQuestion);
              })
            : vaultOptions;
          const renderActiveVaultDesign =
            compactAnsweredVaultOptions &&
            activeVaultDesign &&
            !renderedVaultOptions.some((opt) => parseVaultTemplateOption(opt).slug === activeVaultDesign.slug);
          const emptyPlainRadio =
            q.type === 'radio' &&
            !vaultTemplateQuestion &&
            plainOptions.length === 0;
          return (
            <div key={q.id} className="qf-field">
              <label className="qf-label">
                <span>{displayLabel}</span>
                {q.required ? (
                  <span className="qf-required" aria-label={t('qf.required')}>*</span>
                ) : null}
              </label>
              {q.help ? <div className="qf-help">{q.help}</div> : null}
              {q.type === 'radio' && (vaultTemplateQuestion || plainOptions.length > 0) ? (
                vaultTemplateQuestion ? (
                  <div className="qf-vault-picker-stack">
                    <div className="qf-vault-options">
                      {renderActiveVaultDesign ? (
                        <VaultTemplateOptionView
                          key={`active-session-${activeVaultDesign.slug}`}
                          option={vaultDesignToOption(activeVaultDesign)}
                          parsed={parseVaultTemplateOption(vaultDesignToOption(activeVaultDesign))}
                          design={activeVaultDesign}
                          formId={form.id}
                          questionId={q.id}
                          selected
                          disabled={locked}
                          readOnly={locked}
                          onSelect={() => update(q.id, vaultDesignToOption(activeVaultDesign))}
                        />
                      ) : null}
                      {!renderActiveVaultDesign && vaultSelectedOutsideRecommendedOption(vaultOptions, value) ? (() => {
                        const selectedOption = typeof value === 'string' ? value : '';
                        const parsed = parseVaultTemplateOption(selectedOption);
                        const design = findVaultDesignForOption(vaultDesigns, parsed);
                        return (
                          <VaultTemplateOptionView
                            key={`selected-${parsed.slug ?? selectedOption}`}
                            option={selectedOption}
                            parsed={parsed}
                            design={design}
                            formId={form.id}
                            questionId={q.id}
                            selected
                            disabled={locked}
                            readOnly={locked}
                            onSelect={() => update(q.id, selectedOption)}
                          />
                        );
                      })() : null}
                      {renderedVaultOptions.map((opt) => {
                        const parsed = parseVaultTemplateOption(opt);
                        const design = findVaultDesignForOption(vaultDesigns, parsed);
                        if (!parsed.agentChoice && vaultDesigns.length > 0 && !design) return null;
                        return (
                          <VaultTemplateOptionView
                            key={opt}
                            option={opt}
                            parsed={parsed}
                            design={design}
                            formId={form.id}
                            questionId={q.id}
                            selected={isOptionSelected(value, opt)}
                            disabled={locked}
                            readOnly={locked}
                            onSelect={() => update(q.id, opt)}
                          />
                        );
                      })}
                      <VaultTemplateBrowseEntry
                        count={vaultDesigns.length}
                        onOpen={() => setVaultPickerQuestionId(q.id)}
                      />
                    </div>
                  </div>
                ) : isVaultAgentChoiceQuestion(form, q) ? (
                  <div className="qf-vault-options">
                    {(q.options ?? []).map((opt) => {
                      const parsed = parseVaultTemplateOption(opt);
                      return (
                        <VaultTemplateOptionView
                          key={opt}
                          option={opt}
                          parsed={parsed}
                          design={null}
                          formId={form.id}
                          questionId={q.id}
                          selected={isOptionSelected(value, opt)}
                          disabled={locked}
                          readOnly={locked}
                          onSelect={() => update(q.id, opt)}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div className="qf-options">
                    {plainOptions.map((opt) => (
                      <label key={opt} className={`qf-chip${value === opt ? ' qf-chip-on' : ''}`}>
                        <input
                          type="radio"
                          name={`${form.id}-${q.id}`}
                          value={opt}
                          checked={value === opt}
                          disabled={locked}
                          onChange={() => update(q.id, opt)}
                        />
                        <span>{opt}</span>
                      </label>
                    ))}
                  </div>
                )
              ) : null}
              {emptyPlainRadio ? (
                <input
                  type="text"
                  className="qf-input"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'checkbox' && q.options ? (
                <div className="qf-options">
                  {q.options.map((opt) => {
                    const arr = Array.isArray(value) ? value : [];
                    const on = arr.includes(opt);
                    const maxed =
                      q.maxSelections !== undefined && !on && arr.length >= q.maxSelections;
                    return (
                      <label
                        key={opt}
                        className={`qf-chip${on ? ' qf-chip-on' : ''}${maxed ? ' qf-chip-disabled' : ''}`}
                      >
                        <input
                          type="checkbox"
                          value={opt}
                          checked={on}
                          disabled={locked || maxed}
                          onChange={() => toggleCheckbox(q.id, opt, q.maxSelections)}
                        />
                        <span>{opt}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {q.type === 'select' && q.options ? (
                <select
                  className="qf-select"
                  value={typeof value === 'string' ? value : ''}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                >
                  <option value="" disabled>
                    {t('qf.choose')}
                  </option>
                  {q.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : null}
              {q.type === 'text' ? (
                <input
                  type="text"
                  className="qf-input"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'textarea' ? (
                <textarea
                  className="qf-textarea"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  rows={3}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'direction-cards' && q.cards && q.cards.length > 0 ? (
                <div className="qf-direction-cards">
                  {q.cards.map((card) => (
                    <DirectionCardView
                      key={card.id}
                      card={card}
                      formId={form.id}
                      questionId={q.id}
                      selected={value === card.id || value === card.label}
                      disabled={locked}
                      onSelect={() => update(q.id, card.id)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {activeVaultPickerQuestion ? (
        <VaultTemplatePickerModal
          formId={form.id}
          questionId={activeVaultPickerQuestion.id}
          value={answers[activeVaultPickerQuestion.id]}
          designs={filteredVaultDesigns}
          totalCount={vaultDesigns.length}
          loading={vaultLoading}
          error={vaultLoadError}
          search={vaultPickerSearch}
          readOnly={locked}
          activeVaultTemplateSlug={locked ? null : activeVaultTemplateSlug}
          onSearch={setVaultPickerSearch}
          onSelect={(design) => selectVaultDesign(activeVaultPickerQuestion.id, design)}
          refreshing={vaultRefreshing}
          refreshMessage={vaultRefreshMessage}
          onRefreshFromVault={() => void refreshVaultTemplatesFromVault()}
          onOpenDesignVault={() => void openDesignVaultForInstall()}
          onClose={() => {
            setVaultPickerQuestionId(null);
            setVaultPickerSearch('');
          }}
        />
      ) : null}
      {vaultInstallGateOpen ? (
        <DesignVaultInstallGate
          onClose={() => setVaultInstallGateOpen(false)}
          onReady={(info) => {
            setVaultInstallGateOpen(false);
            if (typeof window !== 'undefined') {
              window.location.href = buildVaultDeepLinkUrl(info.baseUrl, window.location.href);
            }
          }}
        />
      ) : null}
      <div className="question-form-foot">
        {locked ? (
          <span className="qf-locked-note">
            {submittedAnswers ? t('qf.lockedSubmitted') : t('qf.lockedPrev')}
          </span>
        ) : (
          <span className="qf-hint">{t('qf.hint')}</span>
        )}
        {!locked ? (
          <button
            type="button"
            className="primary"
            onClick={handleSubmit}
            disabled={!ready}
            title={ready ? t('qf.submitTitle') : t('qf.submitDisabledTitle')}
          >
            {form.submitLabel ?? t('qf.submitDefault')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DirectionCardView({
  card,
  formId,
  questionId,
  selected,
  disabled,
  onSelect,
}: {
  card: DirectionCard;
  formId: string;
  questionId: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <label
      className={`qf-card${selected ? ' qf-card-on' : ''}${disabled ? ' qf-card-disabled' : ''}`}
    >
      <input
        type="radio"
        name={`${formId}-${questionId}`}
        value={card.id}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect()}
      />
      <div className="qf-card-head">
        <div className="qf-card-title">{card.label}</div>
        {selected ? <span className="qf-card-pill">{t('qf.cardSelected')}</span> : null}
      </div>
      {card.palette.length > 0 ? (
        <div className="qf-card-swatches" aria-hidden>
          {card.palette.slice(0, 6).map((c, i) => (
            <span
              key={i}
              className="qf-card-swatch"
              style={{ background: c }}
              title={c}
            />
          ))}
        </div>
      ) : null}
      <div className="qf-card-types" aria-hidden>
        <span className="qf-card-type-display" style={{ fontFamily: card.displayFont }}>
          Aa
        </span>
        <span className="qf-card-type-body" style={{ fontFamily: card.bodyFont }}>
          {t('qf.cardSampleText')}
        </span>
      </div>
      {card.mood ? <p className="qf-card-mood">{card.mood}</p> : null}
      {card.references.length > 0 ? (
        <p className="qf-card-refs">
          <span className="qf-card-refs-label">{t('qf.cardRefs')}</span>{' '}
          {card.references.slice(0, 4).join(' · ')}
        </p>
      ) : null}
    </label>
  );
}

type VaultPreviewVariant = 'immersive' | 'campaign' | 'product' | 'editorial' | 'system';

type VaultPreviewStyle = CSSProperties & {
  '--qf-vault-bg': string;
  '--qf-vault-text': string;
  '--qf-vault-primary': string;
  '--qf-vault-secondary': string;
  '--qf-vault-surface': string;
  '--qf-vault-line': string;
  '--qf-vault-muted': string;
  '--qf-vault-display': string;
  '--qf-vault-body': string;
};

interface ParsedVaultTemplateOption {
  title: string;
  slug: string | null;
  reason: string;
  agentChoice: boolean;
}

function VaultTemplateOptionView({
  option,
  parsed,
  design,
  formId,
  questionId,
  selected,
  disabled,
  readOnly = false,
  onSelect,
}: {
  option: string;
  parsed: ParsedVaultTemplateOption;
  design: VaultDesignMeta | null;
  formId: string;
  questionId: string;
  selected: boolean;
  disabled: boolean;
  readOnly?: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const style = vaultOptionStyle(design, parsed);
  const variant = vaultOptionVariant(design, parsed);
  const swatches = vaultOptionSwatches(design, parsed);
  const title = design?.title || parsed.title;
  const source = design?.sourceHost || parsed.slug || 'agent matched';
  const reason = parsed.reason || design?.profile?.visualThesis || design?.summary || '';
  const fontLabel = design?.profile?.typographyPersonality || vaultFontLabel(design, 'display');
  const layoutLabel =
    design?.profile?.openSlideGuidance?.direction ||
    design?.profile?.layoutIntensity ||
    design?.profile?.archetype ||
    'slide-ready layout';
  const preview = design ? vaultTemplateCoverPreviewSource(design) : null;
  const typeLabel = design ? vaultTypeLabel(design) : '';

  if (parsed.agentChoice) {
    return (
      <label className={`qf-vault-agent-choice${selected ? ' qf-vault-agent-choice-on' : ''}${disabled && !readOnly ? ' qf-card-disabled' : ''}${readOnly ? ' qf-vault-card-readonly' : ''}`}>
        <input
          type="radio"
          name={`${formId}-${questionId}`}
          value={option}
          checked={selected}
          disabled={disabled || readOnly}
          onChange={() => {
            if (!readOnly) onSelect();
          }}
        />
        <span>{t('qf.vaultAgentChoose')}</span>
        <small>{t('qf.vaultAgentChooseDesc')}</small>
      </label>
    );
  }

  return (
    <label
      className={`qf-vault-card qf-vault-card-${variant}${selected ? ' qf-vault-card-on' : ''}${disabled && !readOnly ? ' qf-card-disabled' : ''}${readOnly ? ' qf-vault-card-readonly' : ''}`}
      style={style}
    >
      <input
        type="radio"
        name={`${formId}-${questionId}`}
        value={option}
        checked={selected}
        disabled={disabled || readOnly}
        onChange={() => {
          if (!readOnly) onSelect();
        }}
      />
      <span className={`qf-vault-preview${preview ? ' qf-vault-preview-real' : ''}`} aria-hidden>
        {preview?.kind === 'image' ? (
          <img className="qf-vault-preview-media" src={preview.src} alt="" loading="lazy" />
        ) : preview?.kind === 'frame' ? (
          <VaultPreviewFrame
            className="qf-vault-preview-scaled"
            src={preview.src}
            title={preview.title}
            width={preview.width}
            height={preview.height}
            sandbox=""
          />
        ) : (
          <>
            <span className="qf-vault-preview-top">
              <span>{source}</span>
              <span>{design?.profile?.confidence ?? 'vault'}</span>
            </span>
            <span className="qf-vault-preview-title">{vaultShortTitle(title)}</span>
            <span className="qf-vault-preview-rule" />
            <span className="qf-vault-preview-layout">
              <span />
              <span />
              <span />
            </span>
            <span className="qf-vault-preview-type">
              <strong>Aa</strong>
              <em>标题 / 正文 / 标注</em>
            </span>
          </>
        )}
      </span>
      <span className="qf-vault-card-body">
        <span className="qf-vault-title-row">
          <strong>{title}</strong>
          {typeLabel ? <span className="qf-vault-kind">{typeLabel}</span> : null}
          {selected ? <span>{t('qf.cardSelected')}</span> : null}
        </span>
        <span className="qf-vault-slug">{parsed.slug ?? source}</span>
        <span className="qf-vault-tags qf-vault-palette-row">
          <span>{t('qf.vaultPalette')}</span>
          <span className="qf-vault-swatches" aria-hidden>
            {swatches.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </span>
        </span>
        <span className="qf-vault-tags qf-vault-layout-row">
          <span>{t('qf.vaultLayout')}</span>
          <em>{truncate(layoutLabel, 46)}</em>
        </span>
        <span className="qf-vault-tags qf-vault-font-row">
          <span>{t('qf.vaultFont')}</span>
          <em>{truncate(fontLabel, 42)}</em>
        </span>
        {reason ? <span className="qf-vault-reason">{reason}</span> : null}
      </span>
    </label>
  );
}

function VaultTemplateBrowseEntry({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  const t = useT();
  const empty = count === 0;
  return (
    <button
      type="button"
      className={`qf-vault-browse-card${empty ? ' qf-vault-browse-card-empty' : ''}`}
      onClick={onOpen}
    >
      <span className="qf-vault-browse-icon" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="qf-vault-browse-body">
        <strong>{empty ? t('qf.vaultBrowseInstall') : t('qf.vaultBrowseAll')}</strong>
        {empty ? <small>{t('qf.vaultBrowseInstallDesc')}</small> : null}
      </span>
      {count > 0 ? <em>{t('qf.vaultBrowseAllCount', { count })}</em> : null}
    </button>
  );
}

type VaultPickerKindKey = 'design-system' | 'skill-package';
type VaultPickerSourceKey = 'url' | 'clone-website' | 'design-system-project';
type VaultPickerSortKey = 'quality' | 'recent' | 'title';

function vaultPickerKindKey(design: VaultDesignMeta): VaultPickerKindKey {
  if (design.kind === 'skill-package') return 'skill-package';
  if (design.packageType === 'component-system' || design.packageType === 'presentation-system' || design.packageType === 'agent-skill-package') {
    return 'skill-package';
  }
  if (design.skillPath || design.capabilitiesPath) return 'skill-package';
  return 'design-system';
}

function vaultPickerScore(design: VaultDesignMeta): number | null {
  const quality = (design.profile as { quality?: { score?: unknown } } | undefined)?.quality;
  return typeof quality?.score === 'number' && Number.isFinite(quality.score) ? quality.score : null;
}

function vaultPickerScoreTone(score: number | null): 'good' | 'warn' | 'bad' | 'neutral' {
  if (score === null) return 'neutral';
  if (score >= 86) return 'good';
  if (score >= 72) return 'warn';
  return 'bad';
}

function vaultPickerTimestamp(design: VaultDesignMeta): number {
  const ts = Date.parse(design.updatedAt ?? design.createdAt ?? '');
  return Number.isFinite(ts) ? ts : 0;
}

function vaultPickerSourceLabel(design: VaultDesignMeta): string {
  if (design.sourceHost) return design.sourceHost;
  try {
    return new URL(design.sourceUrl).host;
  } catch {
    return design.slug;
  }
}

function VaultTemplatePickerModal({
  formId,
  questionId,
  value,
  designs,
  totalCount,
  loading,
  error,
  search,
  readOnly,
  activeVaultTemplateSlug,
  refreshing,
  refreshMessage,
  onSearch,
  onSelect,
  onRefreshFromVault,
  onOpenDesignVault,
  onClose,
}: {
  formId: string;
  questionId: string;
  value: string | string[] | undefined;
  designs: VaultDesignMeta[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  search: string;
  readOnly: boolean;
  activeVaultTemplateSlug?: string | null;
  refreshing: boolean;
  refreshMessage: string | null;
  onSearch: (value: string) => void;
  onSelect: (design: VaultDesignMeta) => void;
  onRefreshFromVault: () => void;
  onOpenDesignVault: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [kindFilter, setKindFilter] = useState<'all' | VaultPickerKindKey>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | VaultPickerSourceKey>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [qualityOnly, setQualityOnly] = useState(false);
  const [sortKey, setSortKey] = useState<VaultPickerSortKey>('quality');
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  const kindCounts = useMemo(() => {
    const map = new Map<VaultPickerKindKey, number>();
    for (const design of designs) {
      const key = vaultPickerKindKey(design);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [designs]);

  const sourceCounts = useMemo(() => {
    const map = new Map<VaultPickerSourceKey, number>();
    for (const design of designs) {
      const key = (design.sourceMode || 'url') as VaultPickerSourceKey;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [designs]);

  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const design of designs) {
      for (const tag of design.tags ?? []) {
        const trimmed = String(tag || '').trim();
        if (!trimmed) continue;
        counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10);
  }, [designs]);

  const visibleDesigns = useMemo(() => {
    const filtered = designs.filter((design) => {
      if (kindFilter !== 'all' && vaultPickerKindKey(design) !== kindFilter) return false;
      if (sourceFilter !== 'all' && (design.sourceMode || 'url') !== sourceFilter) return false;
      if (tagFilter !== 'all' && !(design.tags ?? []).includes(tagFilter)) return false;
      if (qualityOnly) {
        const score = vaultPickerScore(design);
        if (score === null || score < 90) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (sortKey === 'title') return (a.title || a.slug).localeCompare(b.title || b.slug);
      if (sortKey === 'recent') return vaultPickerTimestamp(b) - vaultPickerTimestamp(a);
      const sb = vaultPickerScore(b) ?? -1;
      const sa = vaultPickerScore(a) ?? -1;
      if (sb !== sa) return sb - sa;
      return vaultPickerTimestamp(b) - vaultPickerTimestamp(a);
    });
    return filtered;
  }, [designs, kindFilter, sourceFilter, tagFilter, qualityOnly, sortKey]);

  const selectedVaultTemplateSlug = useMemo(() => {
    if (Array.isArray(value)) return null;
    return typeof value === 'string' ? parseVaultTemplateOption(value).slug : null;
  }, [value]);
  const effectiveSelectedSlug = selectedVaultTemplateSlug ?? (readOnly ? null : activeVaultTemplateSlug ?? null);

  useEffect(() => {
    if (!effectiveSelectedSlug) return;
    const nextIndex = visibleDesigns.findIndex((design) => design.slug === effectiveSelectedSlug);
    if (nextIndex >= 0) setActiveIndex(nextIndex);
  }, [effectiveSelectedSlug, visibleDesigns]);

  useEffect(() => {
    if (visibleDesigns.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex >= visibleDesigns.length) setActiveIndex(visibleDesigns.length - 1);
  }, [visibleDesigns.length, activeIndex]);

  useEffect(() => {
    if (typeof activeRowRef.current?.scrollIntoView === 'function') {
      activeRowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const activeDesign = visibleDesigns[activeIndex] ?? null;

  function handleKey(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (visibleDesigns.length === 0) return;
      setActiveIndex((i) => Math.min(i + 1, visibleDesigns.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (visibleDesigns.length === 0) return;
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      if ((event.target as HTMLElement | null)?.closest('.qf-vault-modal-row')) return;
      const design = visibleDesigns[activeIndex];
      if (!design || readOnly) return;
      event.preventDefault();
      onSelect(design);
    } else if (event.key === 'Escape') {
      onClose();
    }
  }

  const filterActive =
    kindFilter !== 'all' || sourceFilter !== 'all' || tagFilter !== 'all' || qualityOnly;

  function clearFilters() {
    setKindFilter('all');
    setSourceFilter('all');
    setTagFilter('all');
    setQualityOnly(false);
  }

  const modal = (
    <div className="qf-vault-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="qf-vault-modal qf-vault-modal-v2"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qf-vault-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKey}
      >
        <header className="qf-vault-modal-head">
          <div>
            <strong id="qf-vault-modal-title">{t('qf.vaultPickerTitle')}</strong>
            <span>
              {readOnly
                ? t('qf.vaultPickerReadOnlyDesc', { count: totalCount })
                : t('qf.vaultPickerDesc', { count: totalCount })}
            </span>
          </div>
          <button
            type="button"
            className="qf-vault-modal-close"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="qf-vault-modal-controls">
          <input
            className="qf-vault-modal-search-input"
            value={search}
            autoFocus
            placeholder={t('qf.vaultSearchPlaceholder')}
            onChange={(event) => onSearch(event.target.value)}
          />
          <div className="qf-vault-modal-filterbar" aria-label="Vault template filters">
            <select
              className="qf-vault-modal-select"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
              title={t('chat.vaultContextFilterKind')}
            >
              <option value="all">{t('chat.vaultContextFilterKind')} · {t('chat.vaultContextFilterAll')}</option>
              <option value="design-system">{t('chat.vaultContextDesignSystem')} ({kindCounts.get('design-system') ?? 0})</option>
              <option value="skill-package">{t('chat.vaultContextSkill')} ({kindCounts.get('skill-package') ?? 0})</option>
            </select>
            <select
              className="qf-vault-modal-select"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
              title={t('chat.vaultContextFilterSource')}
            >
              <option value="all">{t('chat.vaultContextFilterSource')} · {t('chat.vaultContextFilterAll')}</option>
              <option value="url">{t('chat.vaultContextSourceUrl')} ({sourceCounts.get('url') ?? 0})</option>
              <option value="clone-website">{t('chat.vaultContextSourceClone')} ({sourceCounts.get('clone-website') ?? 0})</option>
              <option value="design-system-project">{t('chat.vaultContextSourceProject')} ({sourceCounts.get('design-system-project') ?? 0})</option>
            </select>
            <select
              className="qf-vault-modal-select qf-vault-modal-select-tag"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              title={t('chat.vaultContextFilterTag')}
            >
              <option value="all">{t('chat.vaultContextFilterTag')} · {t('chat.vaultContextFilterAll')}</option>
              {tagOptions.map(([tag, count]) => (
                <option key={tag} value={tag}>{tag} ({count})</option>
              ))}
            </select>
            <select
              className="qf-vault-modal-select qf-vault-modal-select-sort"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as VaultPickerSortKey)}
              title={t('chat.vaultContextSortQuality')}
            >
              <option value="quality">↕ {t('chat.vaultContextSortQuality')}</option>
              <option value="recent">↕ {t('chat.vaultContextSortRecent')}</option>
              <option value="title">↕ {t('chat.vaultContextSortTitle')}</option>
            </select>
            <button
              type="button"
              className={`qf-vault-modal-toggle${qualityOnly ? ' active' : ''}`}
              onClick={() => setQualityOnly((v) => !v)}
              title={t('chat.vaultContextFilterQualityHint')}
              aria-pressed={qualityOnly}
            >
              ✦ {t('chat.vaultContextFilterQuality')}
            </button>
            {filterActive ? (
              <button
                type="button"
                className="qf-vault-modal-clear"
                onClick={clearFilters}
              >
                {t('chat.vaultContextClearFilters')}
              </button>
            ) : null}
            <span className="qf-vault-modal-count">
              {t('chat.vaultContextResultCount', {
                filtered: String(visibleDesigns.length),
                total: String(designs.length),
              })}
            </span>
          </div>
        </div>
        <div className="qf-vault-modal-split">
          <div className="qf-vault-modal-list">
            {loading ? (
              <div className="qf-vault-modal-empty">{t('common.loading')}</div>
            ) : error ? (
              <div className="qf-vault-modal-empty">{error}</div>
            ) : designs.length === 0 ? (
              <div className="qf-vault-modal-empty qf-vault-modal-empty-action">
                <span className="qf-vault-empty-title">{t('qf.vaultInstallTitle')}</span>
                <span className="qf-vault-empty-body">{t('qf.vaultInstallBody')}</span>
                <span className="qf-vault-empty-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={onOpenDesignVault}
                  >
                    <Icon name="external-link" size={13} />
                    <span>{t('qf.vaultInstallAction')}</span>
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={refreshing}
                    onClick={onRefreshFromVault}
                  >
                    <Icon name={refreshing ? 'spinner' : 'refresh'} size={13} />
                    <span>{refreshing ? t('qf.vaultInstallRefreshing') : t('qf.vaultInstallRefresh')}</span>
                  </button>
                </span>
                {refreshMessage ? <span className="qf-vault-empty-message">{refreshMessage}</span> : null}
              </div>
            ) : visibleDesigns.length === 0 ? (
              <div className="qf-vault-modal-empty">{t('chat.vaultContextNoMatch')}</div>
            ) : (
              visibleDesigns.map((design, index) => {
                const option = vaultDesignToOption(design);
                const score = vaultPickerScore(design);
                const tone = vaultPickerScoreTone(score);
                const isSelected =
                  isOptionSelected(value, option) || (!readOnly && activeVaultTemplateSlug === design.slug);
                const isActive = index === activeIndex;
                return (
                  <button
                    type="button"
                    key={design.slug}
                    ref={isActive ? activeRowRef : undefined}
                    className={
                      'qf-vault-modal-row' +
                      (isActive ? ' active' : '') +
                      (isSelected ? ' selected' : '')
                    }
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={(event) => {
                      event.preventDefault();
                      setActiveIndex(index);
                      if (!readOnly) onSelect(design);
                    }}
                  >
                    <span className="qf-vault-modal-row-main">
                      <span className="qf-vault-modal-row-title-line">
                        <span className="qf-vault-modal-row-title">{design.title || design.slug}</span>
                        <span className={`qf-vault-modal-row-score ${tone}`} aria-hidden>
                          {score !== null ? Math.round(score) : '–'}
                        </span>
                      </span>
                      <span className="qf-vault-modal-row-meta">
                        <span className="qf-vault-modal-row-source">{vaultPickerSourceLabel(design)}</span>
                        {design.summary ? (
                          <>
                            <span aria-hidden> · </span>
                            <span className="qf-vault-modal-row-summary">{design.summary}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    {isSelected ? <span className="qf-vault-modal-row-tick" aria-hidden>✓</span> : null}
                  </button>
                );
              })
            )}
          </div>
          <aside className="qf-vault-modal-preview">
            {activeDesign ? (
              <VaultTemplateOptionView
                option={vaultDesignToOption(activeDesign)}
                parsed={parseVaultTemplateOption(vaultDesignToOption(activeDesign))}
                design={activeDesign}
                formId={formId}
                questionId={`${questionId}-preview`}
                selected={
                  isOptionSelected(value, vaultDesignToOption(activeDesign)) ||
                  (!readOnly && activeVaultTemplateSlug === activeDesign.slug)
                }
                disabled={false}
                readOnly={readOnly}
                onSelect={() => {
                  if (!readOnly) onSelect(activeDesign);
                }}
              />
            ) : (
              <div className="qf-vault-modal-preview-empty">
                {t('chat.vaultContextEmptySelection')}
              </div>
            )}
            <div className="qf-vault-modal-preview-hint">
              {t('chat.vaultContextPreviewHint')}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return modal;
  return createPortal(modal, document.body);
}

function isVaultTemplateQuestion(form: QuestionForm, q: QuestionForm['questions'][number]): boolean {
  if (q.type !== 'radio') return false;
  const options = q.options ?? [];
  const questionText = `${q.id} ${q.label} ${q.help ?? ''}`;
  const formText = `${form.id} ${form.title}`;
  const explicitTemplateIntent =
    hasExplicitVaultTemplateIntent(questionText) ||
    isVaultTemplateFormId(form.id) ||
    hasExplicitVaultTemplateIntent(formText);
  const broadStyleIntent = hasBroadStyleIntent(questionText);
  const optionsLookLikeVault = options.some((opt) => looksLikeVaultTemplateOption(opt));
  if (options.length === 0) return explicitTemplateIntent;
  return explicitTemplateIntent || (broadStyleIntent && optionsLookLikeVault);
}

function isVaultTemplateFormId(id: string): boolean {
  return /vault-template|style-template|visual-template/i.test(id);
}

function hasExplicitVaultTemplateIntent(text: string): boolean {
  return /(vault|template|模板|design\s*system|style\s*(template|reference)|visual\s*template|视觉模板|风格模板|设计风格|样式模板)/i.test(text);
}

function hasBroadStyleIntent(text: string): boolean {
  return /(visual|视觉|风格|样式|style)/i.test(text);
}

function isVaultAgentChoiceQuestion(form: QuestionForm, q: QuestionForm['questions'][number]): boolean {
  if (q.type !== 'radio' || !q.options?.some((opt) => parseVaultTemplateOption(opt).agentChoice)) return false;
  const formHasTemplateRecommendations = form.questions.some((item) => isVaultTemplateQuestion(form, item));
  const label = `${q.id} ${q.label} ${q.help ?? ''}`.toLowerCase();
  return formHasTemplateRecommendations && /(不想选|agent|choose|自动|skip)/i.test(label);
}

function parseVaultTemplateOption(option: string): ParsedVaultTemplateOption {
  if (/(agent choose|agent\s+decide|let[-\s]+the[-\s]+agent[-\s]+choose|自动|我不想选|自己选)/i.test(option) && !/slug:/i.test(option)) {
    return {
      title: 'Let the agent choose',
      slug: null,
      reason: '',
      agentChoice: true,
    };
  }
  const explicitSlug = option.match(/slug:\s*([a-z0-9][a-z0-9-]*)/i)?.[1] ?? null;
  const inferredSlug =
    explicitSlug ??
    option.match(/^\s*([a-z0-9][a-z0-9-]{2,})(?:\s*[—–]\s|\s+\||\s*$)/i)?.[1]?.toLowerCase() ??
    null;
  const slug = inferredSlug;
  const beforeSlug = option.split(/\|\s*slug:/i)[0]?.trim();
  const title = beforeSlug || option.split(/[—–-]/)[0]?.trim() || option;
  const reason =
    option.match(/\s[—–]\s([\s\S]+)$/)?.[1]?.trim() ||
    option.replace(/^.*?slug:\s*[a-z0-9][a-z0-9-]*/i, '').replace(/^[\s—–-]+/, '').trim();
  return {
    title,
    slug,
    reason,
    agentChoice: false,
  };
}

function looksLikeVaultTemplateOption(option: string): boolean {
  const trimmed = option.trim();
  if (/slug:\s*[a-z0-9][a-z0-9-]*/i.test(option)) return true;
  if (/(agent choose|agent\s+decide|let[-\s]+the[-\s]+agent[-\s]+choose|自动|我不想选|自己选)/i.test(option)) return true;
  if (/^\s*[a-z0-9][a-z0-9-]{2,}\s*[—–]\s+/i.test(option)) return true;
  if (/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(trimmed)) return true;
  if (/\b(guizang|tabler|phantom|vercel|mechanik)\b/i.test(option)) return true;
  return false;
}

function findVaultDesignForOption(
  designs: VaultDesignMeta[],
  parsed: ParsedVaultTemplateOption | string | null,
): VaultDesignMeta | null {
  if (!parsed) return null;
  const parsedOption = typeof parsed === 'string'
    ? { slug: parsed, title: parsed }
    : parsed;
  const candidates = [
    parsedOption.slug,
    parsedOption.title,
    slugifyVaultLookup(parsedOption.title),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (candidates.length === 0) return null;
  const designCandidates = (design: VaultDesignMeta): string[] => [
    design.slug,
    design.title,
    slugifyVaultLookup(design.title),
    design.sourceHost,
    slugifyVaultLookup(design.sourceHost),
    design.sourceUrl,
    slugifyVaultLookup(design.sourceUrl),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  const slugDistanceMatch = (a: string, b: string) => (
    a === b ||
    a.startsWith(b) ||
    b.startsWith(a) ||
    (a.length >= 12 && b.includes(a)) ||
    (b.length >= 12 && a.includes(b))
  );
  const scored = designs
    .map((design) => {
      const designValues = designCandidates(design);
      let matchScore = 0;
      for (const candidate of candidates) {
        if (design.slug.toLowerCase() === candidate) matchScore = Math.max(matchScore, 6);
        if (design.title.toLowerCase() === candidate) matchScore = Math.max(matchScore, 5);
        if (slugifyVaultLookup(design.title) === candidate) matchScore = Math.max(matchScore, 4);
        if (designValues.some((designCandidate) => slugDistanceMatch(designCandidate, candidate))) {
          matchScore = Math.max(matchScore, 3);
        }
        const title = design.title.toLowerCase();
        const host = (design.sourceHost || '').toLowerCase();
        if (title.includes(candidate) || candidate.includes(title) || host.includes(candidate)) {
          matchScore = Math.max(matchScore, 2);
        }
      }
      if (matchScore <= 0) return null;
      return {
        design,
        score: vaultDesignPreviewStrength(design) * 100 + matchScore,
      };
    })
    .filter((item): item is { design: VaultDesignMeta; score: number } => item !== null)
    .sort((a, b) => (
      b.score - a.score ||
      a.design.title.localeCompare(b.design.title, undefined, { sensitivity: 'base' }) ||
      a.design.slug.localeCompare(b.design.slug)
    ));
  return scored[0]?.design ?? null;
}

function slugifyVaultLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function vaultDesignPreviewStrength(design: VaultDesignMeta): number {
  let score = 0;
  if (design.previews?.card || design.previews?.ppt || design.previews?.web) score += 8;
  if (design.previewImage) score += 3;
  if (design.profile && Object.keys(design.profile).length > 0) score += 3;
  if (design.tokens) score += 2;
  if (design.sourceHost || design.sourceUrl) score += 1;
  return score;
}

function isOptionSelected(value: string | string[] | undefined, option: string): boolean {
  if (Array.isArray(value)) return value.includes(option);
  if (value === option) return true;
  const a = typeof value === 'string' ? parseVaultTemplateOption(value).slug : null;
  const b = parseVaultTemplateOption(option).slug;
  return Boolean(a && b && a === b);
}

function answeredValuePresent(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

function vaultSelectedOutsideRecommendedOption(
  options: string[] | undefined,
  value: string | string[] | undefined,
): boolean {
  if (!options || typeof value !== 'string' || !value.trim()) return false;
  const parsed = parseVaultTemplateOption(value);
  if (parsed.agentChoice || !parsed.slug) return false;
  return !options.some((option) => isOptionSelected(value, option));
}

function vaultDesignToOption(design: VaultDesignMeta): string {
  const rationale =
    design.profile?.matchingRationale?.[0] ||
    design.profile?.visualThesis ||
    design.summary ||
    design.profile?.openSlideGuidance?.direction ||
    '';
  return `${design.title} | slug: ${design.slug}${rationale ? ` — ${rationale}` : ''}`;
}

function filterVaultDesigns(designs: VaultDesignMeta[], query: string): VaultDesignMeta[] {
  const needle = query.trim().toLowerCase();
  const sorted = [...designs].sort((a, b) => (
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
    a.slug.localeCompare(b.slug)
  ));
  if (!needle) return sorted;
  return sorted.filter((design) => {
    const profile = design.profile;
    const haystack = [
      design.title,
      design.slug,
      design.sourceHost,
      design.summary,
      profile?.archetype,
      profile?.visualThesis,
      profile?.typographyPersonality,
      profile?.layoutIntensity,
      profile?.localizationFit,
      ...(profile?.toneTags ?? []),
      ...(profile?.useCaseTags ?? []),
      ...(profile?.audienceFit ?? []),
      ...(profile?.narrativeFit ?? []),
      ...(profile?.matchingRationale ?? []),
      ...(profile?.slidePatterns ?? []),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

function vaultOptionStyle(
  design: VaultDesignMeta | null,
  parsed: ParsedVaultTemplateOption,
): VaultPreviewStyle {
  const colors = vaultOptionColors(design, parsed);
  const dark = isDarkHex(colors.background);
  return {
    '--qf-vault-bg': colors.background,
    '--qf-vault-text': colors.text,
    '--qf-vault-primary': colors.primary,
    '--qf-vault-secondary': colors.secondary,
    '--qf-vault-surface': colors.surface,
    '--qf-vault-line': colorWithAlpha(colors.text, dark ? 0.3 : 0.18),
    '--qf-vault-muted': colorWithAlpha(colors.text, dark ? 0.64 : 0.56),
    '--qf-vault-display': vaultFontStack(design, 'display'),
    '--qf-vault-body': vaultFontStack(design, 'primary'),
  };
}

function vaultOptionColors(design: VaultDesignMeta | null, parsed: ParsedVaultTemplateOption) {
  const tokenColors = getVaultTokenColors(design?.tokens);
  const profileColors = design?.profile?.colorRoles;
  const fallback = fallbackPaletteForSlug(parsed.slug ?? parsed.title);
  const background = cleanHexColor(
    profileColors?.background,
    cleanHexColor(tokenColors.surface, fallback.background),
  );
  const text = cleanHexColor(
    profileColors?.text,
    cleanHexColor(tokenColors.text, readableTextFor(background)),
  );
  const primary = cleanHexColor(
    profileColors?.brandPrimary,
    cleanHexColor(tokenColors.primary, fallback.primary),
  );
  const secondary = cleanHexColor(
    profileColors?.brandSecondary,
    cleanHexColor(tokenColors.secondary ?? tokenColors.neutral, fallback.secondary),
  );
  const surface = cleanHexColor(
    tokenColors.surface,
    isDarkHex(background) ? '#211f1d' : '#f7f3ee',
  );
  return { background, text, primary, secondary, surface };
}

function fallbackPaletteForSlug(seed: string) {
  const lower = seed.toLowerCase();
  if (/vercel/.test(lower)) {
    return { background: '#050505', text: '#f5f5f5', primary: '#ffffff', secondary: '#6b7280' };
  }
  if (/mechanik|gt/.test(lower)) {
    return { background: '#f9f9f7', text: '#0b6c00', primary: '#929b1a', secondary: '#cce3da' };
  }
  if (/phantom/.test(lower)) {
    return { background: '#f3ecff', text: '#3c315b', primary: '#ab9ff2', secondary: '#111111' };
  }
  return { background: '#171512', text: '#f7f3ee', primary: '#d97855', secondary: '#7f766d' };
}

function vaultOptionSwatches(design: VaultDesignMeta | null, parsed: ParsedVaultTemplateOption): string[] {
  const colors = vaultOptionColors(design, parsed);
  return Array.from(new Set([
    colors.background,
    colors.text,
    colors.primary,
    colors.secondary,
    colors.surface,
  ])).slice(0, 5);
}

function vaultOptionVariant(
  design: VaultDesignMeta | null,
  parsed: ParsedVaultTemplateOption,
): VaultPreviewVariant {
  const profile = design?.profile as Record<string, any> | undefined;
  const haystack = [
    design?.title,
    parsed.title,
    parsed.reason,
    design?.summary,
    design?.profile?.archetype,
    design?.profile?.openSlideGuidance?.direction,
    profile?.visualThesis,
    profile?.visualDna?.layoutGrammar,
    profile?.visualDna?.componentLanguage,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/(immersive|webgl|webgpu|audio|canvas|hud|experiment|dither|fluid)/.test(haystack)) {
    return 'immersive';
  }
  if (/(campaign|movement|launch|brand|advocacy)/.test(haystack)) return 'campaign';
  if (/(product|developer|platform|saas|dashboard|tool|workflow|infrastructure|vercel)/.test(haystack)) {
    return 'product';
  }
  if (/(editorial|magazine|portfolio|gallery|publication)/.test(haystack)) return 'editorial';
  return 'system';
}

function vaultShortTitle(title: string): string {
  const clean = title.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
  const primary = clean.split(/[—–]/)[0]?.trim() || clean;
  const words = primary.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return primary;
  return words.slice(0, 3).join(' ');
}

function vaultTypeLabel(design: VaultDesignMeta): string {
  if (design.kind === 'skill-package') {
    if (design.packageType === 'component-system') return '组件系统';
    if (design.packageType === 'presentation-system') return '演示系统';
    return 'Skill 包';
  }
  if (design.packageType === 'component-system') return '组件系统';
  if (design.packageType === 'presentation-system') return '演示系统';
  if (design.packageType === 'agent-skill-package') return 'Skill 包';
  return '网站风格';
}

function vaultFontStack(design: VaultDesignMeta | null, role: 'display' | 'primary'): string {
  const typography = getVaultTypography(design?.tokens);
  const families = typography.families;
  const value =
    role === 'display'
      ? families?.display ?? families?.primary
      : families?.primary ?? families?.display;
  return typeof value === 'string' && value.trim()
    ? `${value}, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`
    : role === 'display'
      ? 'Georgia, "Times New Roman", serif'
      : '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';
}

function vaultFontLabel(design: VaultDesignMeta | null, role: 'display' | 'primary'): string {
  const typography = getVaultTypography(design?.tokens);
  const value = role === 'display'
    ? typography.families?.display ?? typography.families?.primary
    : typography.families?.primary ?? typography.families?.display;
  return typeof value === 'string' && value.trim() ? value : 'system font stack';
}

function getVaultTokenColors(tokens: unknown): Record<string, string | undefined> {
  if (!tokens || typeof tokens !== 'object') return {};
  const colors = (tokens as { colors?: unknown }).colors;
  if (!colors || typeof colors !== 'object') return {};
  return colors as Record<string, string | undefined>;
}

function getVaultTypography(tokens: unknown): { families?: Record<string, string | undefined> } {
  if (!tokens || typeof tokens !== 'object') return {};
  const typography = (tokens as { typography?: unknown }).typography;
  if (!typography || typeof typography !== 'object') return {};
  const families = (typography as { families?: unknown }).families;
  return families && typeof families === 'object'
    ? { families: families as Record<string, string | undefined> }
    : {};
}

function cleanHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : fallback;
}

function isDarkHex(value: string): boolean {
  const rgb = hexToRgb(value);
  if (!rgb) return true;
  const [r, g, b] = rgb.map((n) => {
    const channel = n / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

function readableTextFor(background: string): string {
  return isDarkHex(background) ? '#f7f3ee' : '#151312';
}

function colorWithAlpha(value: string, alpha: number): string {
  const rgb = hexToRgb(value);
  if (!rgb) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function hexToRgb(value: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

function buildInitialState(
  form: QuestionForm,
  submitted: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of form.questions) {
    if (submitted && submitted[q.id] !== undefined) {
      out[q.id] = submitted[q.id]!;
      continue;
    }
    if (q.defaultValue !== undefined) {
      out[q.id] = q.defaultValue;
      continue;
    }
    if (q.type === 'checkbox') {
      out[q.id] = [];
    } else {
      out[q.id] = '';
    }
  }
  return out;
}

/**
 * Reverse of formatFormAnswers — when we render an old assistant message
 * that contained a form, look at the next user message in the conversation
 * to see if the form was already answered. If so, return the answers map
 * so the form renders in the locked "answered" state with the user's
 * picks visible.
 */
export function parseSubmittedAnswers(
  form: QuestionForm,
  userMessageContent: string,
): Record<string, string | string[]> | null {
  const lines = userMessageContent.split('\n').map((l) => l.trim());
  if (lines.length === 0) return null;
  const header = lines[0] ?? '';
  // We accept any "form answers" header so the agent can paraphrase.
  if (!/^\[form answers/i.test(header)) return null;
  const answers: Record<string, string | string[]> = {};
  const labelToId = new Map<string, string>();
  for (const q of form.questions) labelToId.set(q.label.toLowerCase(), q.id);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^[-*]\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const labelKey = m[1]!.trim().toLowerCase();
    const value = m[2]!.trim();
    const id = labelToId.get(labelKey);
    if (!id) continue;
    const q = form.questions.find((x) => x.id === id);
    if (!q) continue;
    if (q.type === 'checkbox') {
      answers[id] = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.toLowerCase() !== '(skipped)');
    } else {
      answers[id] = value.toLowerCase() === '(skipped)' ? '' : value;
    }
  }
  return Object.keys(answers).length > 0 ? answers : null;
}
