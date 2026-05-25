import { describe, expect, it } from 'vitest';

import { auditOpenPptMotionCoverage } from '../src/openppt-motion-audit';

describe('auditOpenPptMotionCoverage', () => {
  it('fails sparse decks that declare motion but barely apply it', () => {
    const audit = auditOpenPptMotionCoverage(`
const motionStyles = \`
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
[data-osd-freeze-motion] .line-reveal { animation: none !important; opacity: 1 !important; }
@media (prefers-reduced-motion: reduce) { .line-reveal { animation: none !important; } }
\`;
const MotionStyles = () => <style>{motionStyles}</style>;
const Cover = () => <div><MotionStyles /><button {...motionAttrs("pill-hover")} /></div>;
const PageTwo = () => <div className="line-reveal" />;
const PageThree = () => <div />;
const PageFour = () => <div />;
export default [Cover, PageTwo, PageThree, PageFour] satisfies Page[];
`);

    expect(audit.pageCount).toBe(4);
    expect(audit.pass).toBe(false);
    expect(audit.issues.join('\n')).toContain('Motion coverage');
    expect(audit.issues.join('\n')).toContain('Missing page-by-page motion choreography map.');
  });

  it('passes decks with choreography, coverage, freeze, and reduced-motion rules', () => {
    const audit = auditOpenPptMotionCoverage(`
/*
Motion Choreography Map
01 Title: title fade up, diagram line grow
02 Proof: cards stagger
03 Close: canvas swap
*/
const motionStyles = \`
@keyframes fadeUp { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: translateY(0) } }
.os-motion { animation: fadeUp 420ms both; }
.os-fade-up { animation: fadeUp 420ms both; }
.os-line-grow { animation: fadeUp 420ms both; }
.os-canvas-swap { animation: fadeUp 260ms both; }
[data-osd-freeze-motion] .os-motion,
[data-osd-freeze-motion] .os-fade-up,
[data-osd-freeze-motion] .os-line-grow,
[data-osd-freeze-motion] .os-canvas-swap { animation: none !important; opacity: 1 !important; transform: none !important; }
@media (prefers-reduced-motion: reduce) { .os-motion, .os-fade-up, .os-line-grow, .os-canvas-swap { animation: none !important; transform: none !important; } }
\`;
const MotionStyles = () => <style>{motionStyles}</style>;
const Cover = () => <div><MotionStyles /><h1 data-osd-motion-id="title" className="os-motion os-fade-up" /></div>;
const Proof = () => <div className="os-motion os-line-grow" data-osd-motion-id="proof" />;
const Close = () => <div className="os-motion os-canvas-swap" data-osd-motion-id="close" />;
export default [Cover, Proof, Close] satisfies Page[];
`);

    expect(audit.pass).toBe(true);
    expect(audit.coverageRatio).toBe(1);
    expect(audit.hasChoreographyMap).toBe(true);
    expect(audit.hasFreezeMotionRule).toBe(true);
    expect(audit.hasReducedMotionRule).toBe(true);
  });

  it('does not count unused helper CSS definitions as applied motion', () => {
    const audit = auditOpenPptMotionCoverage(`
/*
Motion Choreography Map
01 Title: fade up
02 Proof: stagger
03 Close: canvas swap
*/
const motionStyles = \`
@keyframes fadeUp { from { opacity: 0 } to { opacity: 1 } }
.os-motion { animation: fadeUp 420ms both; }
.os-fade-up { animation: fadeUp 420ms both; }
.os-line-grow { animation: fadeUp 420ms both; }
.os-canvas-swap { animation: fadeUp 260ms both; }
[data-osd-freeze-motion] .os-motion,
[data-osd-freeze-motion] .os-fade-up,
[data-osd-freeze-motion] .os-line-grow,
[data-osd-freeze-motion] .os-canvas-swap { animation: none !important; opacity: 1 !important; transform: none !important; }
@media (prefers-reduced-motion: reduce) { .os-motion, .os-fade-up, .os-line-grow, .os-canvas-swap { animation: none !important; transform: none !important; } }
\`;
const MotionStyles = () => <style>{motionStyles}</style>;
const Cover = () => <div><MotionStyles /><h1>Defined only</h1></div>;
const Proof = () => <div />;
const Close = () => <div />;
export default [Cover, Proof, Close] satisfies Page[];
`);

    expect(audit.pass).toBe(false);
    expect(audit.appliedMotionCount).toBe(0);
    expect(audit.issues.join('\n')).toContain('No applied motion markers');
  });
});
