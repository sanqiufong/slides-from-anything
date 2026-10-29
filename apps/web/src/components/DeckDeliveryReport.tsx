import type { DeckDeliveryReport as Report } from '@open-design/contracts';
import { useT } from '../i18n';

export function DeckDeliveryReport({ report }: { report: Report }) {
  const t = useT();
  return <aside className={`deck-delivery-report ${report.status}`} aria-label={t('delivery.details')}>
    <strong>{t(report.status === 'passed' ? 'delivery.passed' : report.status === 'failed' ? 'delivery.failed' : 'delivery.notRequired')}</strong>
    <p>{t('delivery.boundary')}</p>
    {report.checks.length ? <details><summary>{t('delivery.details')}</summary>
      <ul>{report.checks.map(check => <li key={check.name}>
        <span>{t(`delivery.${check.name}`)} · {check.status === 'passed' ? '✓' : check.status === 'failed' ? '✕' : '—'}</span>
        {check.issues.length ? <ul>{check.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
      </li>)}</ul>
      {report.warnings.length ? <ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    </details> : null}
  </aside>;
}
