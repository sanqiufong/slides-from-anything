import type { CSSProperties, ReactNode } from 'react';
import type {
  ChatSlideFeedbackAttachment,
  SlideFeedback,
} from '@open-design/contracts';

export interface OpenSlideWorkbenchSource {
  projectId: string;
  slideId: string;
  sourcePath: string;
  source: string;
  design?: unknown;
  comments?: Array<{ id: string; line: number; note: string; hint?: string }>;
  feedback?: SlideFeedback[];
}

export interface OpenSlideWorkbenchActions {
  onSelectPage?: (pageIndex: number) => void;
  onPatchDesign?: (patch: unknown) => void | Promise<void>;
  onCreateComment?: (input: {
    line?: number;
    pageIndex?: number;
    targetLabel?: string;
    text: string;
    hint?: string;
  }) => void | Promise<void>;
  onQueueFeedback?: (feedback: ChatSlideFeedbackAttachment) => void | Promise<void>;
  onExport?: (kind: 'html' | 'pdf' | 'pptx') => void | Promise<void>;
}

export interface OpenSlideWorkbenchProps {
  deck: OpenSlideWorkbenchSource;
  activePageIndex?: number;
  pageCount?: number;
  actions?: OpenSlideWorkbenchActions;
  preview?: ReactNode;
  style?: CSSProperties;
}

export function OpenSlideWorkbench({
  deck,
  activePageIndex = 0,
  pageCount = Math.max(1, deck.source.match(/const\s+\w+\s*:\s*Page\s*=/g)?.length ?? 1),
  actions,
  preview,
  style,
}: OpenSlideWorkbenchProps) {
  const queued = deck.feedback?.filter((item) => item.status === 'queued') ?? [];

  return (
    <section className="open-slide-workbench" style={style}>
      <aside className="open-slide-workbench__rail" aria-label="Slide thumbnails">
        {Array.from({ length: pageCount }).map((_, index) => (
          <button
            key={index}
            type="button"
            className={index === activePageIndex ? 'is-active' : ''}
            onClick={() => actions?.onSelectPage?.(index)}
          >
            <span>{index + 1}</span>
          </button>
        ))}
      </aside>

      <main className="open-slide-workbench__stage">
        {preview ?? (
          <div className="open-slide-workbench__placeholder">
            <strong>{deck.slideId}</strong>
            <span>{deck.sourcePath}</span>
          </div>
        )}
      </main>

      <aside className="open-slide-workbench__inspector" aria-label="Open Slide inspector">
        <section>
          <h3>Design</h3>
          <button
            type="button"
            onClick={() => actions?.onPatchDesign?.({})}
          >
            Patch tokens
          </button>
        </section>
        <section>
          <h3>Feedback</h3>
          <p>{queued.length} queued</p>
          <button
            type="button"
            onClick={() =>
              actions?.onQueueFeedback?.({
                id: `local-${Date.now()}`,
                order: queued.length + 1,
                kind: 'semantic-edit',
                slideId: deck.slideId,
                pageIndex: activePageIndex,
                note: 'Queued from Open Slide workbench',
                source: 'open-slide-workbench',
              })
            }
          >
            Queue feedback
          </button>
        </section>
        <section>
          <h3>Export</h3>
          <div className="open-slide-workbench__exports">
            <button type="button" onClick={() => actions?.onExport?.('html')}>HTML</button>
            <button type="button" onClick={() => actions?.onExport?.('pdf')}>PDF</button>
            <button type="button" onClick={() => actions?.onExport?.('pptx')}>PPTX</button>
          </div>
        </section>
      </aside>
    </section>
  );
}

export const openSlideWorkbenchSlots = [
  'SlideCanvas',
  'ThumbnailRail',
  'DesignPanel',
  'InspectorPanel',
  'CommentWidget',
  'ExportMenu',
] as const;
