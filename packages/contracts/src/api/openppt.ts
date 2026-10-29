export interface DeckDeliveryReport {
  status: 'passed' | 'failed' | 'not_required';
  checkedAt: number;
  slideId?: string;
  sourceDigest?: string;
  pageCount?: number;
  checks: Array<{
    name: 'source' | 'render' | 'assets' | 'motion';
    status: 'passed' | 'failed' | 'skipped';
    issues: string[];
  }>;
  warnings: string[];
  /** Technical validation does not certify narrative or visual quality. */
  visualReview: 'pending';
}

export interface DeckVersion {
  id: string;
  createdAt: number;
  reason: 'before-edit' | 'after-edit' | 'before-run' | 'after-run' | 'manual' | 'restore';
  digest: string;
  fileCount: number;
  totalBytes: number;
  runId?: string;
  restoredFrom?: string;
}

export interface DeckVersionsResponse {
  versions: DeckVersion[];
  currentDigest: string;
}

export interface RestoreDeckVersionRequest {
  slideId: string;
  versionId: string;
  /** Reject a restore when files changed since the history was opened. */
  expectedDigest: string;
}

export interface RestoreDeckVersionResponse {
  ok: true;
  version: DeckVersion;
}
