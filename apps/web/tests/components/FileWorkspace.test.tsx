import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createOpenSlideRuntimeReact,
  evaluateOpenSlideRuntime,
  FileWorkspace,
  OpenSlideAssetPreviewDialog,
  OpenSlidePreviewSelectShell,
  OpenSlideRuntimePageView,
  resolveOpenSlideRuntimeAssetUrl,
} from '../../src/components/FileWorkspace';

function cssRuleBody(source: string, selector: string): string {
  const matches = cssRuleBodies(source, selector);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0] ?? '';
}

function cssRuleBodies(source: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(source.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, 'g'))).map((match) => match[1] ?? '');
}

function numericDeclaration(body: string, property: string): number {
  const match = new RegExp(`${property}:\\s*(\\d+)\\b`).exec(body);
  expect(match).not.toBeNull();
  return Number(match?.[1] ?? 0);
}

describe('FileWorkspace upload input', () => {
  it('keeps the Design Files picker aligned with drag-and-drop file support', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        files={[]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="design-files-upload-input"');
    expect(markup).not.toContain('accept=');
  });

  it('keeps Open Slide export available from the topbar', () => {
    const deckSource = {
      name: 'slides/main-deck/index.tsx',
      kind: 'code' as const,
      mime: 'text/typescript',
      size: 100,
      mtime: 1,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        files={[deckSource]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck
        tabsState={{ tabs: [deckSource.name], active: deckSource.name }}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(markup).toContain('open-slide-export-menu');
    expect(markup).toContain('Export');
  });
});

describe('Open Slide workbench styles', () => {
  it('stacks the topbar above active side panels so export stays clickable', () => {
    const styles = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
    const topbar = cssRuleBody(styles, '.open-slide-topbar');
    const sidePanel = cssRuleBody(styles, '.open-slide-side-panel');

    expect(numericDeclaration(topbar, 'z-index')).toBeGreaterThan(numericDeclaration(sidePanel, 'z-index'));
    expect(topbar).toContain('isolation: isolate');
  });

  it('centers the player canvas inside a viewport-sized 16:9 stage', () => {
    const styles = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
    const stage = cssRuleBodies(styles, '.open-slide-player-stage').find((body) => body.includes('align-items: center')) ?? '';
    const shell = cssRuleBodies(styles, '.open-slide-player .open-slide-canvas-shell').find((body) => body.includes('100dvw')) ?? '';

    expect(stage).toContain('align-items: center');
    expect(stage).toContain('justify-content: center');
    expect(shell).toContain('width: min(100dvw, 177.777778dvh)');
    expect(shell).toContain('height: min(100dvh, 56.25dvw)');
    expect(shell).toContain('padding: 0');
  });

  it('keeps asset preview images contained inside the viewer stage', () => {
    const styles = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
    const stageImage = cssRuleBody(styles, '.open-slide-asset-preview-stage img');

    expect(stageImage).toContain('max-width: 100%');
    expect(stageImage).toContain('max-height: 100%');
    expect(stageImage).toContain('object-fit: contain');
  });
});

describe('Open Slide runtime asset URLs', () => {
  it('renders slide asset previews as an in-app dialog with explicit exits', () => {
    const asset = {
      name: 'slides/main-deck/assets/hero.png',
      kind: 'image' as const,
      mime: 'image/png',
      size: 100,
      mtime: 1,
    };
    const markup = renderToStaticMarkup(
      <OpenSlideAssetPreviewDialog
        projectId="project-1"
        asset={asset}
        label="hero.png"
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('class="open-slide-asset-preview-close"');
    expect(markup).toContain('src="/api/projects/project-1/raw/slides/main-deck/assets/hero.png"');
    expect(markup).toContain('download="hero.png"');
    expect(markup).toContain('target="_blank"');
  });

  it('maps slide asset specifiers to project raw URLs', () => {
    expect(resolveOpenSlideRuntimeAssetUrl('project-1', 'main-deck', './assets/hero image.png')).toBe(
      '/api/projects/project-1/raw/slides/main-deck/assets/hero%20image.png',
    );
    expect(resolveOpenSlideRuntimeAssetUrl('project-1', 'main-deck', 'hero.png')).toBe(
      '/api/projects/project-1/raw/hero.png',
    );
    expect(resolveOpenSlideRuntimeAssetUrl('project-1', 'main-deck', 'https://example.com/hero.png')).toBe(
      'https://example.com/hero.png',
    );
  });

  it('rewrites JSX image and CSS url props during TSX preview rendering', () => {
    const runtimeReact = createOpenSlideRuntimeReact('project-1', 'main-deck');
    const markup = renderToStaticMarkup(
      runtimeReact.createElement(
        'div',
        {
          style: {
            backgroundImage: 'url("./assets/bg.png")',
          },
        },
        runtimeReact.createElement('img', {
          src: './assets/hero.png',
          srcSet: './assets/hero.png 1x, https://example.com/hero@2x.png 2x',
          alt: 'hero',
        }),
      ),
    );

    expect(markup).toContain('background-image:url(&quot;/api/projects/project-1/raw/slides/main-deck/assets/bg.png&quot;)');
    expect(markup).toContain('src="/api/projects/project-1/raw/slides/main-deck/assets/hero.png"');
    expect(markup).toContain(
      'srcSet="/api/projects/project-1/raw/slides/main-deck/assets/hero.png 1x, https://example.com/hero@2x.png 2x"',
    );
  });

  it('renders a local fallback when generated slide components throw during render', () => {
    const runtimeReact = createOpenSlideRuntimeReact('project-1', 'main-deck');
    const MissingGeneratedGraphic = () => {
      throw new ReferenceError('EmotionCurveSVG is not defined');
    };
    const RuntimePage = () => runtimeReact.createElement(MissingGeneratedGraphic);

    const markup = renderToStaticMarkup(runtimeReact.createElement(RuntimePage));

    expect(markup).toContain('Slide component failed: MissingGeneratedGraphic');
    expect(markup).toContain('EmotionCurveSVG is not defined');
  });

  it('renders a local fallback when a generated page directly references a missing helper', () => {
    const BrokenPage = () => {
      throw new ReferenceError('EmotionCurveSVG is not defined');
    };

    const markup = renderToStaticMarkup(
      <OpenSlideRuntimePageView page={BrokenPage} design={null} />,
    );

    expect(markup).toContain('Slide component failed: BrokenPage');
    expect(markup).toContain('EmotionCurveSVG is not defined');
  });

  it('stubs missing generated SVG helpers before they become ReferenceErrors', () => {
    const runtime = evaluateOpenSlideRuntime(
      `
      exports.default = [PipelineSVG];
      exports.meta = { title: Object.keys({ ok: true })[0] };
      `,
      'project-1',
      'main-deck',
    );

    expect(runtime?.error).toBeUndefined();
    expect(runtime?.meta?.title).toBe('ok');
    expect(runtime?.pages).toHaveLength(1);

    const page = runtime?.pages[0];
    expect(page).toBeTruthy();
    const markup = renderToStaticMarkup(
      <OpenSlideRuntimePageView page={page!} design={null} />,
    );

    expect(markup).toContain('PipelineSVG');
    expect(markup).toContain('PipelineSVG is not defined');
  });

  it('stubs missing generated SVG helpers referenced inside rendered pages', () => {
    const runtime = evaluateOpenSlideRuntime(
      `
      const StoryPage = () => React.createElement('section', null, React.createElement(EmotionCurveSVG));
      exports.default = [StoryPage];
      `,
      'project-1',
      'main-deck',
    );

    expect(runtime?.error).toBeUndefined();
    expect(runtime?.pages).toHaveLength(1);

    const page = runtime?.pages[0];
    const markup = renderToStaticMarkup(
      <OpenSlideRuntimePageView page={page!} design={null} />,
    );

    expect(markup).toContain('EmotionCurveSVG');
    expect(markup).toContain('EmotionCurveSVG is not defined');
  });

  it('does not shadow the generated module React global', () => {
    const runtime = evaluateOpenSlideRuntime(
      `
      const Cover = () => React.createElement('section', null, 'Core first page');
      exports.default = [Cover];
      `,
      'project-1',
      'main-deck',
    );

    expect(runtime?.error).toBeUndefined();
    expect(runtime?.pages).toHaveLength(1);

    const page = runtime?.pages[0];
    const markup = renderToStaticMarkup(
      <OpenSlideRuntimePageView page={page!} design={null} />,
    );

    expect(markup).toContain('Core first page');
    expect(markup).not.toContain('React.createElement is not a function');
  });

  it('exposes React hooks to generated pages that reference them directly', () => {
    const runtime = evaluateOpenSlideRuntime(
      `
      const HookPage = () => {
        const [label] = useState('Hook ready');
        return React.createElement('section', null, label);
      };
      exports.default = [HookPage];
      `,
      'project-1',
      'main-deck',
    );

    expect(runtime?.error).toBeUndefined();
    expect(runtime?.pages).toHaveLength(1);

    const page = runtime?.pages[0];
    const markup = renderToStaticMarkup(
      <OpenSlideRuntimePageView page={page!} design={null} />,
    );

    expect(markup).toContain('Hook ready');
    expect(markup).not.toContain('useState is not defined');
  });
});

describe('Open Slide preview selectors', () => {
  it('keeps rendered slide controls outside the selector button', () => {
    const markup = renderToStaticMarkup(
      <OpenSlidePreviewSelectShell
        active
        className="open-slide-thumb-item"
        hitClassName="open-slide-thumb-hit-target"
        label="Page 03"
        onSelect={() => undefined}
      >
        <div className="open-slide-thumb">
          <button type="button">Slide action</button>
        </div>
      </OpenSlidePreviewSelectShell>,
    );

    expect(markup).toContain('class="open-slide-thumb-hit-target"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('<button type="button">Slide action</button>');
    expect(markup).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>).)*<button\b/is);
  });
});
