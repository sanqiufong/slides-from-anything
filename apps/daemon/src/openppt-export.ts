// @ts-nocheck
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const PPTX_WIDTH = 13.333333;
const PPTX_HEIGHT = 7.5;
const MIN_PPTX_LAYER_AREA = 4;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeSlug(value, fallback = 'openppt-deck') {
  const slug = String(value || '')
    .trim()
    .replace(/\.[^.]+$/g, '')
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function pxToken(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`;
  if (typeof value === 'string' && value.trim()) return value;
  return fallback;
}

function designVarsCss(design) {
  const palette = design?.palette ?? {};
  const fonts = design?.fonts ?? {};
  const typeScale = design?.typeScale ?? {};
  return [
    `--osd-bg: ${palette.bg ?? '#0f172a'};`,
    `--osd-text: ${palette.text ?? '#f8fafc'};`,
    `--osd-accent: ${palette.accent ?? '#38bdf8'};`,
    `--osd-font-display: ${fonts.display ?? 'system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif'};`,
    `--osd-font-body: ${fonts.body ?? 'system-ui, -apple-system, BlinkMacSystemFont, "Inter", sans-serif'};`,
    `--osd-size-hero: ${pxToken(typeScale.hero, '156px')};`,
    `--osd-size-body: ${pxToken(typeScale.body, '38px')};`,
    `--osd-radius: ${pxToken(design?.radius, '12px')};`,
  ].join('\n    ');
}

function renderImagePlaceholder(React, props = {}) {
  return React.createElement(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        minHeight: 160,
        display: 'grid',
        placeItems: 'center',
        border: '1px dashed rgba(255,255,255,0.28)',
        color: 'rgba(255,255,255,0.6)',
        fontFamily: 'var(--osd-font-body)',
      },
    },
    props.label || 'Image',
  );
}

function decodeStyleTextEntities(value) {
  return String(value ?? '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

function restoreRawStyleTagCss(markup) {
  return String(markup ?? '').replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_match, attrs, css) => `<style${attrs}>${decodeStyleTextEntities(css)}</style>`,
  );
}

async function compileOpenPptSource(source) {
  const ts = await import('typescript');
  const result = ts.transpileModule(source, {
    fileName: 'index.tsx',
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      isolatedModules: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  });
  const diagnostics = (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  if (diagnostics.length > 0) {
    throw new Error(`slide source has TypeScript errors: ${diagnostics.join(' · ')}`);
  }
  return result.outputText;
}

async function evaluateOpenPptDeck({ source, slideDir }) {
  const React = require('react');
  const ReactDOMServer = require('react-dom/server');
  const code = await compileOpenPptSource(source);
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === 'react') return React;
    if (specifier === '@open-slide/core') {
      return {
        ImagePlaceholder: (props) => renderImagePlaceholder(React, props),
      };
    }
    if (specifier.startsWith('./assets/') || specifier.startsWith('assets/')) {
      return `assets/${specifier.replace(/^\.?\/*assets\//, '')}`;
    }
    throw new Error(`Unsupported slide import in export: ${specifier}`);
  };
  const run = new Function('React', 'module', 'exports', 'require', code);
  run(React, module, module.exports, localRequire);
  const exports = module.exports;
  const pages = Array.isArray(exports.default ?? exports.pages)
    ? (exports.default ?? exports.pages).filter((item) => typeof item === 'function')
    : [];
  if (pages.length === 0) throw new Error('slide module did not export Page[]');
  const design = exports.design && typeof exports.design === 'object' ? exports.design : {};
  const title = exports.meta?.title || 'SFA deck';
  const htmlPages = pages.map((Page, index) => {
    const markup = restoreRawStyleTagCss(
      ReactDOMServer.renderToStaticMarkup(React.createElement(Page, { design })),
    );
    return `<section class="export-page" data-page="${index + 1}">
  <div class="export-canvas">
    <div class="export-canvas-inner" data-export-canvas-motion-root>${markup}</div>
  </div>
</section>`;
  });
  return { design, title, pageCount: pages.length, htmlPages };
}

function formatTokenStylesheet(stylesheet) {
  const value = String(stylesheet || '').trim();
  if (!/^<style\b/i.test(value) || !/<\/style>\s*$/i.test(value)) return '';
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function renderStandaloneHtml({ title, design, pages, tokenStylesheet }) {
  const vaultTokenStylesheet = formatTokenStylesheet(tokenStylesheet);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
${vaultTokenStylesheet ? `${vaultTokenStylesheet}\n` : ''}
  <style>
    :root {
      ${designVarsCss(design)}
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #111; color: var(--osd-text); }
    body { font-family: var(--osd-font-body); overflow: hidden; }
    .export-deck {
      width: 100vw;
      height: 100vh;
      position: relative;
      overflow: hidden;
      background: #151515;
    }
    .export-page {
      position: absolute;
      inset: 0;
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
      z-index: 0;
      transform: none;
      will-change: opacity, transform, filter;
    }
    .export-page.active {
      opacity: 1;
      pointer-events: auto;
      z-index: 2;
    }
    .export-page.active[data-transition="forward"] {
      animation: openpptExportStageForward 320ms cubic-bezier(0.2, 0.72, 0.16, 1) both;
    }
    .export-page.active[data-transition="backward"] {
      animation: openpptExportStageBackward 320ms cubic-bezier(0.2, 0.72, 0.16, 1) both;
    }
    .export-page.active[data-transition="jump"] {
      animation: openpptExportStageJump 320ms cubic-bezier(0.2, 0.72, 0.16, 1) both;
    }
    .export-canvas {
      width: calc(${CANVAS_WIDTH}px * var(--export-scale, 1));
      height: calc(${CANVAS_HEIGHT}px * var(--export-scale, 1));
      position: relative;
      overflow: hidden;
      flex: 0 0 auto;
      background: var(--osd-bg);
      color: var(--osd-text);
      box-shadow: 0 28px 80px rgba(0,0,0,0.32);
    }
    .export-canvas-inner {
      width: ${CANVAS_WIDTH}px;
      height: ${CANVAS_HEIGHT}px;
      position: relative;
      overflow: hidden;
      transform-origin: top left;
      transform: scale(var(--export-scale, 1));
      background: var(--osd-bg);
      color: var(--osd-text);
    }
    body[data-export-render="page"] {
      width: ${CANVAS_WIDTH}px;
      height: ${CANVAS_HEIGHT}px;
      overflow: hidden;
      background: var(--osd-bg);
    }
    body[data-export-render="page"] .export-deck,
    body[data-export-render="page"] .export-page {
      position: static;
      inset: auto;
      width: ${CANVAS_WIDTH}px;
      height: ${CANVAS_HEIGHT}px;
      opacity: 1;
      transform: none;
      animation: none;
      pointer-events: auto;
    }
    body[data-export-render="page"] .export-page { display: none; }
    body[data-export-render="page"] .export-page.active { display: block; }
    body[data-export-render="page"] .export-canvas {
      width: ${CANVAS_WIDTH}px;
      height: ${CANVAS_HEIGHT}px;
      box-shadow: none;
    }
    body[data-export-render="page"] .export-canvas-inner {
      transform: none;
    }
    .export-ui {
      position: fixed;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      z-index: 50;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 999px;
      background: rgba(16,16,16,0.78);
      backdrop-filter: blur(16px);
      color: white;
      font: 13px system-ui, sans-serif;
    }
    .export-ui button {
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      color: white;
      padding: 7px 12px;
      cursor: pointer;
    }
    .iframe-preview-box iframe {
      pointer-events: none;
    }
    .iframe-lightbox {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 60px;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(12px);
      cursor: zoom-out;
    }
    .iframe-lightbox-inner {
      width: 100%;
      height: 100%;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 20px;
      background: #0a0a0f;
      cursor: default;
    }
    .iframe-lightbox-inner iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    [data-osd-freeze-motion] .os-motion,
    [data-osd-freeze-motion] .os-fade-up,
    [data-osd-freeze-motion] .os-line-grow,
    [data-osd-freeze-motion] .os-canvas-swap,
    [data-osd-freeze-motion] .os-motion-stagger > * {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
      clip-path: none !important;
      filter: none !important;
    }
    .export-page:not(.active) .export-canvas-inner .os-motion,
    .export-page:not(.active) .export-canvas-inner .os-fade-up,
    .export-page:not(.active) .export-canvas-inner .os-line-grow,
    .export-page:not(.active) .export-canvas-inner .os-canvas-swap,
    .export-page:not(.active) .export-canvas-inner .os-motion-stagger > *,
    .export-page:not(.active) .export-canvas-inner .os-bar-stagger > *,
    .export-page:not(.active) .export-canvas-inner [data-osd-motion-id] {
      animation: none !important;
    }
    @page { size: 20in 11.25in; margin: 0; }
    @keyframes openpptExportStageForward {
      from {
        opacity: 0.62;
        transform: translate3d(28px, 0, 0) scale(0.992);
        filter: blur(8px);
      }
      to {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
        filter: blur(0);
      }
    }
    @keyframes openpptExportStageBackward {
      from {
        opacity: 0.62;
        transform: translate3d(-28px, 0, 0) scale(0.992);
        filter: blur(8px);
      }
      to {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
        filter: blur(0);
      }
    }
    @keyframes openpptExportStageJump {
      from {
        opacity: 0.55;
        transform: scale(0.986);
        filter: blur(7px);
      }
      to {
        opacity: 1;
        transform: scale(1);
        filter: blur(0);
      }
    }
    @media print {
      html, body { width: ${CANVAS_WIDTH}px; height: auto; background: white; overflow: visible; }
      .export-deck { width: ${CANVAS_WIDTH}px; height: auto; background: white; }
      .export-page {
        position: relative !important;
        inset: auto !important;
        display: block !important;
        width: ${CANVAS_WIDTH}px;
        height: ${CANVAS_HEIGHT}px;
        opacity: 1 !important;
        transform: none !important;
        animation: none !important;
        pointer-events: auto !important;
        break-after: page;
        page-break-after: always;
        overflow: hidden;
      }
      .export-canvas { width: ${CANVAS_WIDTH}px; height: ${CANVAS_HEIGHT}px; box-shadow: none; }
      .export-canvas-inner { transform: none; }
      .export-ui { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .export-page { animation: none !important; transform: none !important; filter: none !important; }
    }
  </style>
</head>
<body>
  <main class="export-deck">
${pages.join('\n')}
  </main>
  <nav class="export-ui" aria-label="Presentation controls">
    <button type="button" data-prev>Prev</button>
    <span data-folio>1 / ${pages.length}</span>
    <button type="button" data-next>Next</button>
    <button type="button" data-fullscreen>Full</button>
  </nav>
  <script>
    const params = new URLSearchParams(location.search);
    const renderMode = params.get('render');
    const deck = document.querySelector('.export-deck');
    const pages = Array.from(document.querySelectorAll('.export-page'));
    const freezeMotion = params.get('freeze') === '1' || params.get('freeze') === 'true' || (renderMode === 'page' && params.get('freeze') !== '0');
    const initialPage = Math.max(0, Math.min(pages.length - 1, Number(params.get('page') || location.hash.slice(1) || 1) - 1));
    let active = -1;
    if (freezeMotion) {
      document.querySelectorAll('[data-export-canvas-motion-root]').forEach((el) => el.setAttribute('data-osd-freeze-motion', 'true'));
    }
    if (renderMode === 'page') {
      document.body.dataset.exportRender = 'page';
      document.querySelector('.export-ui')?.remove();
    }
    function resize() {
      if (renderMode === 'page') return;
      const scale = Math.min(window.innerWidth / ${CANVAS_WIDTH}, window.innerHeight / ${CANVAS_HEIGHT});
      document.documentElement.style.setProperty('--export-scale', String(scale));
    }
    function restartMotion(page) {
      if (freezeMotion) return;
      const animated = new Set(page.querySelectorAll('.os-motion, .os-fade-up, .os-line-grow, .os-canvas-swap, [data-osd-motion-id], .os-motion-stagger > *, .os-bar-stagger > *'));
      page.querySelectorAll('*').forEach((el) => {
        const style = getComputedStyle(el);
        if (style.animationName && style.animationName !== 'none') animated.add(el);
      });
      animated.forEach((el) => { el.style.animation = 'none'; });
      void page.offsetWidth;
      animated.forEach((el) => { el.style.animation = ''; });
    }
    function show(index) {
      const next = Math.max(0, Math.min(pages.length - 1, index));
      const previous = active;
      const transition = previous < 0 ? 'initial' : next === previous ? 'jump' : next > previous ? 'forward' : 'backward';
      active = next;
      pages.forEach((page, i) => {
        page.classList.toggle('active', i === active);
        page.classList.toggle('is-before', i < active);
        page.classList.toggle('is-after', i > active);
        if (i === active) {
          page.dataset.transition = transition;
        } else {
          delete page.dataset.transition;
          page.style.animation = 'none';
        }
      });
      void pages[active].offsetWidth;
      pages[active].style.animation = '';
      restartMotion(pages[active]);
      const folio = document.querySelector('[data-folio]');
      if (folio) folio.textContent = String(active + 1) + ' / ' + String(pages.length);
      if (renderMode !== 'page') history.replaceState(null, '', '#' + String(active + 1));
    }
    function syncFullscreenLabel() {
      const button = document.querySelector('[data-fullscreen]');
      if (button) button.textContent = document.fullscreenElement ? 'Exit' : 'Full';
    }
    async function toggleFullscreen() {
      if (!document.fullscreenElement) {
        const target = deck || document.documentElement;
        await target.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
      syncFullscreenLabel();
    }
    function closeIframePreviewLightbox() {
      document.querySelector('.iframe-lightbox[data-export-lightbox="true"]')?.remove();
    }
    function openIframePreviewLightbox(box) {
      const iframe = box.querySelector('iframe');
      const src = iframe?.getAttribute('src');
      if (!src) return;
      closeIframePreviewLightbox();
      const overlay = document.createElement('div');
      overlay.className = 'iframe-lightbox';
      overlay.dataset.exportLightbox = 'true';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.tabIndex = -1;
      const inner = document.createElement('div');
      inner.className = 'iframe-lightbox-inner';
      const expanded = document.createElement('iframe');
      expanded.src = iframe.src;
      expanded.title = iframe.getAttribute('title') || 'Demo preview';
      expanded.allowFullscreen = true;
      expanded.setAttribute('allow', 'fullscreen');
      inner.append(expanded);
      overlay.append(inner);
      overlay.addEventListener('click', closeIframePreviewLightbox);
      inner.addEventListener('click', (event) => event.stopPropagation());
      (document.fullscreenElement || document.body).append(overlay);
      overlay.focus();
    }
    document.querySelectorAll('.iframe-preview-box').forEach((box) => {
      box.addEventListener('click', () => openIframePreviewLightbox(box));
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          openIframePreviewLightbox(box);
        }
      });
    });
    document.querySelector('[data-prev]')?.addEventListener('click', () => show(active - 1));
    document.querySelector('[data-next]')?.addEventListener('click', () => show(active + 1));
    document.querySelector('[data-fullscreen]')?.addEventListener('click', () => {
      toggleFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', syncFullscreenLabel);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeIframePreviewLightbox();
      if ((event.key === 'f' || event.key === 'F') && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        toggleFullscreen().catch(() => {});
      }
      if (['ArrowRight', 'PageDown', ' '].includes(event.key)) show(active + 1);
      if (['ArrowLeft', 'PageUp'].includes(event.key)) show(active - 1);
      if (event.key === 'Home') show(0);
      if (event.key === 'End') show(pages.length - 1);
    });
    window.addEventListener('resize', resize);
    resize();
    show(initialPage);
    window.__openpptExportReady = true;
  </script>
</body>
</html>
`;
}

async function copyAssets(slideDir, exportDir) {
  const sourceAssets = path.join(slideDir, 'assets');
  try {
    const stat = await fs.promises.stat(sourceAssets);
    if (stat.isDirectory()) {
      await fs.promises.cp(sourceAssets, path.join(exportDir, 'assets'), { recursive: true });
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function zipDirectory(dir) {
  const zip = new JSZip();
  async function walk(current, rel) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, nextRel);
      } else if (entry.isFile()) {
        zip.file(nextRel, await fs.promises.readFile(full), { binary: true });
      }
    }
  }
  await walk(dir, '');
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

async function renderPdfAndPngs(exportDir, pageCount) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      deviceScaleFactor: 1,
    });
    const htmlUrl = pathToFileURL(path.join(exportDir, 'index.html')).href;
    await fs.promises.mkdir(path.join(exportDir, 'slides'), { recursive: true });
    for (let i = 1; i <= pageCount; i += 1) {
      await page.goto(`${htmlUrl}?render=page&page=${i}&freeze=1`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__openpptExportReady === true, null, { timeout: 10_000 });
      await page.screenshot({
        path: path.join(exportDir, 'slides', `page-${String(i).padStart(2, '0')}.png`),
        fullPage: false,
      });
    }
    await page.goto(`${htmlUrl}?freeze=1`, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: path.join(exportDir, 'deck.pdf'),
      printBackground: true,
      preferCSSPageSize: true,
      width: '20in',
      height: '11.25in',
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await browser.close();
  }
}

function createOpenPptPresentation(title) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.author = 'Slides from Anything';
  pptx.company = 'Slides from Anything';
  pptx.subject = title;
  pptx.title = title;
  pptx.lang = 'zh-CN';
  pptx.layout = 'LAYOUT_WIDE';
  pptx.defineLayout({ name: 'OPENPPT_WIDE', width: PPTX_WIDTH, height: PPTX_HEIGHT });
  pptx.layout = 'OPENPPT_WIDE';
  pptx.theme = {
    headFontFace: 'Inter',
    bodyFontFace: 'Inter',
    lang: 'zh-CN',
  };
  return pptx;
}

function pxToPptxX(value) {
  return (value / CANVAS_WIDTH) * PPTX_WIDTH;
}

function pxToPptxY(value) {
  return (value / CANVAS_HEIGHT) * PPTX_HEIGHT;
}

function pxToPptxPt(value) {
  return pxToPptxY(value) * 72;
}

function layerBox(layer) {
  const left = Math.max(0, Number(layer.x) || 0);
  const top = Math.max(0, Number(layer.y) || 0);
  const right = Math.min(CANVAS_WIDTH, left + Math.max(0, Number(layer.w) || 0));
  const bottom = Math.min(CANVAS_HEIGHT, top + Math.max(0, Number(layer.h) || 0));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width * height < MIN_PPTX_LAYER_AREA) return null;
  return {
    x: pxToPptxX(left),
    y: pxToPptxY(top),
    w: pxToPptxX(width),
    h: pxToPptxY(height),
  };
}

function hexByte(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase();
}

function parseCssColor(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'transparent') return null;
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const body = hex[1].length === 3
      ? hex[1].split('').map((char) => char + char).join('')
      : hex[1];
    return { color: body.toUpperCase(), transparency: 0 };
  }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgb) return null;
  const alpha = rgb[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgb[4])));
  if (alpha <= 0.01) return null;
  return {
    color: `${hexByte(Number(rgb[1]))}${hexByte(Number(rgb[2]))}${hexByte(Number(rgb[3]))}`,
    transparency: Math.round((1 - alpha) * 100),
  };
}

function combinedTransparency(parsedColor, opacity = 1) {
  const colorAlpha = parsedColor ? 1 - (Number(parsedColor.transparency) || 0) / 100 : 1;
  const finalAlpha = Math.max(0, Math.min(1, colorAlpha * Math.max(0, Math.min(1, Number(opacity) || 1))));
  return Math.round((1 - finalAlpha) * 100);
}

function containsCjk(value) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(String(value || ''));
}

function fontFamilyTokens(fontFamily) {
  return String(fontFamily || '')
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function cleanFontFace(fontFamily, text = '') {
  const tokens = fontFamilyTokens(fontFamily);
  const lowerTokens = tokens.map((token) => token.toLowerCase());
  const isMono = lowerTokens.some((token) => token.includes('mono') || token.includes('plex mono') || token === 'monospace');
  const isSerif = lowerTokens.some((token) => (
    token === 'serif' ||
    token.includes('noto serif') ||
    token.includes('source serif') ||
    token.includes('playfair') ||
    token.includes('georgia') ||
    token.includes('song')
  ));
  if (containsCjk(text)) {
    if (isSerif) return 'Songti SC';
    if (isMono) return 'Menlo';
    return 'PingFang SC';
  }
  const first = String(fontFamily || 'Inter')
    .split(',')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  if (!first || first === 'system-ui') return 'Inter';
  if (/monospace/i.test(first)) return 'Menlo';
  return first;
}

function parseCssPx(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function imageSourceForPptx(src, exportDir) {
  const raw = String(src || '').trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return { data: raw };
  if (/^https?:\/\//i.test(raw)) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      return { path: fileURLToPath(raw) };
    } catch {
      return null;
    }
  }
  const resolved = path.resolve(exportDir, raw.replace(/^\/+/, ''));
  if (!resolved.startsWith(exportDir + path.sep) && resolved !== exportDir) return null;
  return { path: resolved };
}

function addShapeLayer(pptx, slide, layer) {
  const box = layerBox(layer);
  if (!box) return false;
  const fill = parseCssColor(layer.fill);
  const line = parseCssColor(layer.borderColor);
  if (!fill && (!line || !layer.borderWidth)) return false;
  const shape = parseCssPx(layer.borderRadius) > 2 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
  const opts = {
    ...box,
    rotate: layer.rotate || 0,
    fill: fill
      ? { color: fill.color, transparency: combinedTransparency(fill, layer.opacity) }
      : { color: 'FFFFFF', transparency: 100 },
    line: line && layer.borderWidth
      ? {
          color: line.color,
          transparency: combinedTransparency(line, layer.opacity),
          width: Math.max(0.25, pxToPptxPt(parseCssPx(layer.borderWidth))),
        }
      : { color: 'FFFFFF', transparency: 100 },
  };
  slide.addShape(shape, opts);
  return true;
}

function addTextLayer(slide, layer) {
  const box = layerBox(layer);
  if (!box || !String(layer.text || '').trim()) return false;
  const color = parseCssColor(layer.color) || { color: '111111', transparency: 0 };
  const fontSizePx = parseCssPx(layer.fontSize, 24);
  const fontSize = Math.max(4, Math.min(120, pxToPptxPt(fontSizePx)));
  const lineHeightPx = parseCssPx(layer.lineHeight, fontSizePx * 1.2);
  const align = ['left', 'center', 'right', 'justify'].includes(layer.textAlign) ? layer.textAlign : 'left';
  const lineSpacing = Math.max(1, pxToPptxPt(lineHeightPx));
  slide.addText(String(layer.text), {
    ...box,
    margin: 0,
    fit: 'none',
    valign: 'top',
    breakLine: false,
    color: color.color,
    fontFace: cleanFontFace(layer.fontFamily, layer.text),
    fontSize,
    bold: Number(layer.fontWeight) >= 600,
    italic: layer.fontStyle === 'italic' || String(layer.fontStyle || '').startsWith('oblique'),
    align,
    lineSpacing,
    wrap: Number(layer.lineCount) > 1,
    charSpacing: pxToPptxPt(parseCssPx(layer.letterSpacing, 0)),
    rotate: layer.rotate || 0,
  });
  return true;
}

function addImageLayer(slide, layer, exportDir) {
  const box = layerBox(layer);
  const image = imageSourceForPptx(layer.src, exportDir);
  if (!box || !image) return false;
  slide.addImage({
    ...image,
    ...box,
    rotate: layer.rotate || 0,
    transparency: Math.round((1 - Math.max(0, Math.min(1, Number(layer.opacity) || 1))) * 100),
  });
  return true;
}

async function captureEditablePptxPages({ exportDir, pageCount }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      deviceScaleFactor: 1,
    });
    const htmlUrl = pathToFileURL(path.join(exportDir, 'index.html')).href;
    const snapshots = [];
    for (let i = 1; i <= pageCount; i += 1) {
      await page.goto(`${htmlUrl}?render=page&page=${i}&freeze=1`, { waitUntil: 'load' });
      await page.waitForFunction('window.__openpptExportReady === true', null, { timeout: 10_000 });
      await page.evaluate('document.fonts?.ready ?? Promise.resolve()');
      snapshots.push(await page.evaluate(`(() => {
        const canvas = document.querySelector('.export-page.active .export-canvas');
        if (!canvas) return { backgroundColor: 'rgb(0, 0, 0)', layers: [] };
        const canvasRect = canvas.getBoundingClientRect();
        const textTags = new Set(['A', 'B', 'BUTTON', 'CAPTION', 'CITE', 'CODE', 'EM', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'I', 'LABEL', 'LI', 'P', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TD', 'TH']);
        let order = 0;

        function px(value) {
          const parsed = Number.parseFloat(String(value || ''));
          return Number.isFinite(parsed) ? parsed : 0;
        }

        function normalizeText(value) {
          return String(value || '')
            .split('\\n')
            .map((line) => line.replace(/\\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\\n');
        }

        function elementText(el) {
          if (['IMG', 'SCRIPT', 'STYLE', 'SVG'].includes(el.tagName)) return '';
          const text = normalizeText(el.innerText || el.textContent || '');
          if (!text) return '';
          const directText = normalizeText(Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || '')
            .join(' '));
          const childHasText = Array.from(el.children).some((child) => normalizeText(child.innerText || child.textContent || ''));
          if (!textTags.has(el.tagName) && !directText) return '';
          if (childHasText && !directText && el.tagName !== 'BUTTON') return '';
          return text;
        }

        function firstCssUrl(value) {
          const match = String(value || '').match(/^url\\((['"]?)(.*?)\\1\\)$/);
          return match?.[2] || '';
        }

        function svgDataUri(el) {
          try {
            const text = new XMLSerializer().serializeToString(el);
            return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
          } catch {
            return '';
          }
        }

        function relativeDomRect(rect) {
          const left = Math.max(0, rect.left - canvasRect.left);
          const top = Math.max(0, rect.top - canvasRect.top);
          const right = Math.min(canvasRect.width, rect.right - canvasRect.left);
          const bottom = Math.min(canvasRect.height, rect.bottom - canvasRect.top);
          return {
            x: left,
            y: top,
            w: Math.max(0, right - left),
            h: Math.max(0, bottom - top),
          };
        }

        function relativeRect(el) {
          return relativeDomRect(el.getBoundingClientRect());
        }

        function directTextRect(el) {
          const rects = [];
          Array.from(el.childNodes).forEach((node) => {
            if (node.nodeType !== Node.TEXT_NODE) return;
            if (!normalizeText(node.textContent || '')) return;
            const range = document.createRange();
            range.selectNodeContents(node);
            Array.from(range.getClientRects()).forEach((rect) => {
              if (rect.width >= 1 && rect.height >= 1) rects.push(rect);
            });
            range.detach();
          });
          if (!rects.length) return null;
          const union = rects.reduce((acc, rect) => ({
            left: Math.min(acc.left, rect.left),
            top: Math.min(acc.top, rect.top),
            right: Math.max(acc.right, rect.right),
            bottom: Math.max(acc.bottom, rect.bottom),
          }), {
            left: rects[0].left,
            top: rects[0].top,
            right: rects[0].right,
            bottom: rects[0].bottom,
          });
          return { ...relativeDomRect(union), lineCount: rects.length };
        }

        function textLayerRect(el, fallback) {
          const textRect = directTextRect(el);
          if (!textRect) return fallback;
          const elementRect = relativeRect(el);
          const right = Math.max(textRect.x + textRect.w, elementRect.x + elementRect.w);
          const bottom = Math.max(textRect.y + textRect.h, elementRect.y + elementRect.h);
          return {
            x: textRect.x,
            y: textRect.y,
            w: Math.max(textRect.w, right - textRect.x),
            h: Math.max(textRect.h, bottom - textRect.y),
            lineCount: textRect.lineCount,
          };
        }

        function cumulativeOpacity(el) {
          let value = 1;
          let current = el;
          while (current instanceof Element && current !== canvas) {
            const currentOpacity = px(getComputedStyle(current).opacity);
            value *= currentOpacity || 1;
            current = current.parentElement;
          }
          return value;
        }

        function motionLayerMetadata(el) {
          const motionEl = el.closest('[data-osd-motion-id], .os-motion, .os-fade-up, .os-line-grow, .os-canvas-swap, .os-motion-stagger');
          const target = motionEl || el;
          const hadFreeze = canvas.hasAttribute('data-osd-freeze-motion');
          if (hadFreeze) canvas.removeAttribute('data-osd-freeze-motion');
          const motionStyle = getComputedStyle(target);
          const motion = {
            motionId: motionEl?.getAttribute('data-osd-motion-id') || '',
            motionClassName: motionEl?.getAttribute('class') || '',
            animationName: motionStyle.animationName,
            animationDuration: motionStyle.animationDuration,
            animationDelay: motionStyle.animationDelay,
            animationTimingFunction: motionStyle.animationTimingFunction,
          };
          if (hadFreeze) canvas.setAttribute('data-osd-freeze-motion', 'true');
          const hasAnimation = motion.animationName && motion.animationName !== 'none';
          if (!motion.motionId && !hasAnimation) return null;
          return motion;
        }

        function visible(el, style) {
          const rect = el.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (px(style.opacity) <= 0.01) return false;
          if (rect.width < 1 || rect.height < 1) return false;
          if (rect.right <= canvasRect.left || rect.left >= canvasRect.right) return false;
          if (rect.bottom <= canvasRect.top || rect.top >= canvasRect.bottom) return false;
          return true;
        }

        function visit(el) {
          if (!(el instanceof Element)) return;
          const style = getComputedStyle(el);
          if (!visible(el, style)) return;
          const rect = relativeRect(el);
          const opacity = cumulativeOpacity(el);
          const rotate = (() => {
            const matrix = style.transform.match(/^matrix\\(([^)]+)\\)$/);
            if (!matrix) return 0;
            const [a, b] = matrix[1].split(',').map((part) => Number(part.trim()));
            return Number.isFinite(a) && Number.isFinite(b) ? Math.round((Math.atan2(b, a) * 180) / Math.PI) : 0;
          })();
          const motion = motionLayerMetadata(el);
          const base = { ...rect, opacity, rotate, ...(motion || {}) };
          const borderWidth = Math.max(
            px(style.borderTopWidth),
            px(style.borderRightWidth),
            px(style.borderBottomWidth),
            px(style.borderLeftWidth),
          );
          const hasBorder = borderWidth > 0 && style.borderTopStyle !== 'none';
          if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || hasBorder) {
            layers.push({
              ...base,
              type: 'shape',
              fill: style.backgroundColor,
              borderColor: hasBorder ? style.borderTopColor : 'rgba(0, 0, 0, 0)',
              borderWidth,
              borderRadius: Math.max(px(style.borderTopLeftRadius), px(style.borderTopRightRadius), px(style.borderBottomRightRadius), px(style.borderBottomLeftRadius)),
              order: order++,
            });
          }
          const backgroundUrl = firstCssUrl(style.backgroundImage);
          if (backgroundUrl) {
            layers.push({
              ...base,
              type: 'image',
              src: new URL(backgroundUrl, location.href).href,
              order: order++,
            });
          }
          if (el instanceof HTMLImageElement) {
            layers.push({
              ...base,
              type: 'image',
              src: el.currentSrc || el.src || el.getAttribute('src') || '',
              order: order++,
            });
          } else if (el instanceof SVGElement && el.tagName.toLowerCase() === 'svg') {
            layers.push({
              ...base,
              type: 'image',
              src: svgDataUri(el),
              order: order++,
            });
            return;
          } else {
            const text = elementText(el);
            if (text) {
              const textRect = textLayerRect(el, base);
              layers.push({
                ...(textRect ? { ...textRect, ...(motion || {}) } : base),
                opacity,
                rotate,
                type: 'text',
                text,
                color: style.color,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                fontStyle: style.fontStyle,
                letterSpacing: style.letterSpacing,
                lineHeight: style.lineHeight,
                textAlign: style.textAlign,
                lineCount: textRect?.lineCount || 1,
                order: order++,
              });
            }
          }
          Array.from(el.children).forEach(visit);
        }

        const layers = [];
        Array.from(canvas.children).forEach(visit);
        return {
          backgroundColor: getComputedStyle(canvas).backgroundColor,
          layers,
        };
      })()`));
    }
    return snapshots;
  } finally {
    await browser.close();
  }
}

async function createEditablePptxFromDomLayers({ exportDir, pageCount, title }) {
  const pptx = createOpenPptPresentation(title);
  const snapshots = await captureEditablePptxPages({ exportDir, pageCount });
  const stats = { layerCount: 0, skippedLayerCount: 0, textLayerCount: 0, imageLayerCount: 0, shapeLayerCount: 0, motionLayerCount: 0 };
  for (const pageSnapshot of snapshots) {
    const slide = pptx.addSlide();
    const bg = parseCssColor(pageSnapshot.backgroundColor) || { color: '000000', transparency: 0 };
    slide.background = { color: bg.color };
    for (const layer of [...pageSnapshot.layers].sort((a, b) => (a.order || 0) - (b.order || 0))) {
      try {
        let added = false;
        if (layer.type === 'shape') {
          added = addShapeLayer(pptx, slide, layer);
          if (added) stats.shapeLayerCount += 1;
        } else if (layer.type === 'text') {
          added = addTextLayer(slide, layer);
          if (added) stats.textLayerCount += 1;
        } else if (layer.type === 'image') {
          added = addImageLayer(slide, layer, exportDir);
          if (added) stats.imageLayerCount += 1;
        }
        if (added) {
          stats.layerCount += 1;
          if (layer.motionId || (layer.animationName && layer.animationName !== 'none')) {
            stats.motionLayerCount += 1;
          }
        } else stats.skippedLayerCount += 1;
      } catch {
        stats.skippedLayerCount += 1;
      }
    }
  }
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return { buffer, stats };
}

// Preserves the original screenshot-only PPTX export as an explicit fallback
// and as the `strategy=raster` comparison path while editable export matures.
async function createRasterPptxFromImages({ exportDir, pageCount, title }) {
  const pptx = createOpenPptPresentation(title);
  for (let i = 1; i <= pageCount; i += 1) {
    const slide = pptx.addSlide();
    slide.background = { color: '000000' };
    slide.addImage({
      path: path.join(exportDir, 'slides', `page-${String(i).padStart(2, '0')}.png`),
      x: 0,
      y: 0,
      w: PPTX_WIDTH,
      h: PPTX_HEIGHT,
    });
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

export async function buildOpenPptExportArtifacts({
  source,
  slideDir,
  title,
  target = 'all',
  pptxStrategy = 'editable',
  tokenStylesheet = null,
}: {
  source: string;
  slideDir: string;
  title?: string;
  target?: 'all' | 'assets' | 'pptx' | string;
  pptxStrategy?: 'editable' | 'raster' | string;
  tokenStylesheet?: string | null;
}) {
  const deck = await evaluateOpenPptDeck({ source, slideDir });
  const exportTitle = title || deck.title || 'SFA deck';
  const exportDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openppt-export-'));
  try {
    let rasterRendered = false;
    await copyAssets(slideDir, exportDir);
    const html = renderStandaloneHtml({
      title: exportTitle,
      design: deck.design,
      pages: deck.htmlPages,
      tokenStylesheet,
    });
    await fs.promises.writeFile(path.join(exportDir, 'index.html'), html, 'utf8');
    await fs.promises.writeFile(path.join(exportDir, 'source.tsx'), source, 'utf8');

    async function ensureRasterRender() {
      if (rasterRendered) return;
      await renderPdfAndPngs(exportDir, deck.pageCount);
      rasterRendered = true;
    }

    let pptx = null;
    let zip = null;
    let resolvedPptxStrategy = null;
    let pptxStats = null;

    if (target === 'all' || target === 'assets') {
      await ensureRasterRender();
      zip = await zipDirectory(exportDir);
    }

    if (target === 'all' || target === 'pptx') {
      if (pptxStrategy === 'raster') {
        await ensureRasterRender();
        pptx = await createRasterPptxFromImages({
          exportDir,
          pageCount: deck.pageCount,
          title: exportTitle,
        });
        resolvedPptxStrategy = 'raster';
      } else {
        // TODO(animated PPTX): once the OOXML timing patcher is hardened, add
        // a separate experimental strategy that maps captured motion metadata
        // to ppt/slides/slideN.xml <p:timing>. The editable path intentionally
        // captures metadata but keeps PowerPoint output in a stable end state.
        try {
          const editable = await createEditablePptxFromDomLayers({
            exportDir,
            pageCount: deck.pageCount,
            title: exportTitle,
          });
          pptx = editable.buffer;
          pptxStats = editable.stats;
          resolvedPptxStrategy = 'editable';
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Editable PPTX export failed: ${reason}`);
        }
      }
    }

    return {
      title: exportTitle,
      slug: safeSlug(exportTitle),
      pageCount: deck.pageCount,
      zip,
      pptx,
      pptxStrategy: resolvedPptxStrategy,
      pptxStats,
    };
  } finally {
    await fs.promises.rm(exportDir, { recursive: true, force: true });
  }
}
