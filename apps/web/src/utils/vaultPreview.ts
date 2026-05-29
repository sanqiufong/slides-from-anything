import type { VaultDesignMeta } from '../types';

type VaultTemplateCoverPreviewFrame = {
  kind: 'frame';
  src: string;
  title: string;
  width: number;
  height: number;
};

type VaultTemplateCoverPreviewImage = {
  kind: 'image';
  src: string;
  title: string;
};

export type VaultTemplateCoverPreviewSource = VaultTemplateCoverPreviewFrame | VaultTemplateCoverPreviewImage;

export function vaultTemplateCoverPreviewSource(design: VaultDesignMeta): VaultTemplateCoverPreviewSource | null {
  if (design.slug && design.previews?.ppt) {
    return {
      kind: 'frame',
      src: `/api/vault/designs/${encodeURIComponent(design.slug)}/preview?kind=ppt&slide=title`,
      title: `${design.title} PPT cover preview`,
      width: 1120,
      height: 630,
    };
  }

  if (design.slug && design.previews?.card) {
    return {
      kind: 'frame',
      src: `/api/vault/designs/${encodeURIComponent(design.slug)}/preview?kind=card&surface=library`,
      title: `${design.title} style card preview`,
      width: 800,
      height: 500,
    };
  }

  if (design.slug && design.previews?.web) {
    return {
      kind: 'frame',
      src: `/api/vault/designs/${encodeURIComponent(design.slug)}/preview?kind=web`,
      title: `${design.title} web preview`,
      width: 800,
      height: 500,
    };
  }

  return design.previewImage
    ? {
        kind: 'image',
        src: design.previewImage,
        title: `${design.title} preview image`,
      }
    : null;
}
