export type VaultIngestMode = 'url' | 'clone-website' | 'design-system-project';

interface ComponentMotionRecipe {
  id: string;
  component: string;
  role: string;
  trigger: string;
  statePair: string;
  properties: string[];
  timing: {
    duration: string;
    easing: string;
    delay?: string;
    stagger?: string;
  };
  choreography: string[];
  cssHint: string;
  pptAdapter: string[];
  evidence: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface VaultDesignMeta {
  slug: string;
  title: string;
  sourceUrl: string;
  sourceHost: string;
  sourceMode: VaultIngestMode;
  status: 'ready';
  summary: string;
  kind?: 'skill-package' | 'prompt-context';
  packageType?: string;
  tags?: string[];
  previewImage?: string;
  createdAt: string;
  updatedAt: string;
  favorite?: boolean;
  designPath: string;
  openSlideThemePath: string;
  evidencePath: string;
  profilePath: string;
  manifestPath?: string;
  capabilitiesPath?: string;
  skillPath?: string;
  tokensPath?: string;
  references?: string[];
  activationPrompt?: string;
  assets: Array<{ name: string; kind: string; path: string; sourceUrl?: string }>;
  previews: { web: string; ppt: string; card?: string };
  tokens?: unknown;
  profile?: {
    archetype?: string;
    confidence?: 'low' | 'medium' | 'high';
    visualThesis?: string;
    toneTags?: string[];
    useCaseTags?: string[];
    audienceFit?: string[];
    contentDensity?: string | { level?: string; rationale?: string };
    narrativeFit?: string[];
    avoidWhen?: string[];
    matchingRationale?: string[];
    slidePatterns?: string[];
    typographyPersonality?: string;
    layoutIntensity?: 'quiet' | 'structured' | 'expressive' | 'immersive' | string;
    assetNeeds?: string[];
    localizationFit?: string;
    colorRoles?: {
      brandPrimary: string;
      brandSecondary: string;
      background: string;
      text: string;
      surfaceAlternate?: string | null;
      surfaceDeep?: string | null;
      accentPalette?: Array<{
        hex: string;
        role?: string | null;
        canonicalRole?: string | null;
        coverage?: string | null;
        evidence?: string | null;
      }> | null;
    };
    typographyRoles?: {
      display?: string;
      body?: string;
      primary?: string;
      mono?: string;
      rationale?: string[];
    };
    openSlideGuidance?: {
      direction: string;
      coverApproach: string;
      layoutApproach: string[];
      motionApproach: string[];
    };
    componentMotionRecipes?: ComponentMotionRecipe[];
  };
}

export interface VaultIngestionJob {
  id: string;
  url: string;
  mode: VaultIngestMode;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  slug?: string;
  error?: string;
}

export interface VaultDesignsResponse {
  designs: VaultDesignMeta[];
}

export interface VaultDesignResponse {
  design: VaultDesignMeta;
}

export interface VaultDeleteResponse {
  ok: true;
  slug: string;
  deleted: boolean;
  removedPaths?: string[];
}

export interface VaultCreateIngestionRequest {
  url: string;
  mode?: VaultIngestMode;
}

export interface VaultSyncItem {
  slug: string;
  title: string;
  kind: 'skill-package' | 'prompt-context';
  packageType?: string;
  skillId?: string;
  designSystemId?: string;
  warnings: string[];
}

export interface VaultSyncResponse {
  mode: 'embedded' | 'external';
  designsRoot: string;
  importSourceRoot?: string;
  importAvailable?: boolean;
  imported: number;
  refreshed: number;
  skippedImports: number;
  total: number;
  synced: number;
  failed: number;
  skillPackages: number;
  promptContexts: number;
  downloadNeeded: boolean;
  downloadAvailable: boolean;
  message?: string;
  items: VaultSyncItem[];
  errors: string[];
}

// See SPEC.md (open-design/discovery@v1). Returned by the daemon's
// GET /api/vault/discovery to drive the install gate + deep-link CTA.
export type VaultDiscoveryState =
  | 'running'
  | 'installed-not-running'
  | 'not-installed'
  | 'configured-not-reachable';

export interface VaultDiscoveryResponse {
  spec: 'open-design/discovery@v1';
  state: VaultDiscoveryState;
  baseUrl: string | null;
  version: string | null;
  vaultSpec: string | null;
  capabilities: string[];
  designCount: number | null;
  lastSeen: string | null;
  explicit: boolean;
  registryPath: string;
  install: {
    cloneCmd: string;
    runCmd: string;
    defaultBaseUrl: string;
  };
}
