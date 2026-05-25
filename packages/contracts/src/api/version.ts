export interface AppVersionInfo {
  version: string;
  channel: string;
  packaged: boolean;
  platform: string;
  arch: string;
}

export interface AppVersionResponse {
  version: AppVersionInfo;
}

export interface AppUpdateAsset {
  url: string;
  sha256?: string;
  size?: number;
}

export interface AppUpdateManifest {
  version: string;
  channel?: string;
  minimumVersion?: string;
  releasedAt?: string;
  notes?: string;
  notesUrl?: string;
  releaseUrl?: string;
  assets?: Record<string, AppUpdateAsset>;
}

export type AppUpdateStatus = 'disabled' | 'latest' | 'available' | 'error';

export interface AppUpdateCheckResponse {
  current: AppVersionInfo;
  status: AppUpdateStatus;
  checkedAt: string;
  sourceMode: 'source' | 'packaged';
  latestVersion?: string;
  platformKey?: string;
  manifestUrl?: string;
  asset?: AppUpdateAsset | null;
  notes?: string;
  notesUrl?: string;
  releaseUrl?: string;
  error?: string;
}
