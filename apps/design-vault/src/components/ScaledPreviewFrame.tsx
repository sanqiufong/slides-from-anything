"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

type ScaledPreviewFrameProps = {
  src: string;
  title: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  canvasWidth?: number;
  canvasHeight?: number;
  tabIndex?: number;
};

export function ScaledPreviewFrame({
  src,
  title,
  ariaLabel,
  className,
  style,
  canvasWidth = 800,
  canvasHeight = 500,
  tabIndex,
}: ScaledPreviewFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setScale(Math.min(1, rect.width / canvasWidth, rect.height / canvasHeight));
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasHeight, canvasWidth]);

  return (
    <div
      ref={containerRef}
      className={["relative overflow-hidden bg-surface-muted", className].filter(Boolean).join(" ")}
      style={{
        aspectRatio: `${canvasWidth} / ${canvasHeight}`,
        ...style,
      }}
    >
      <iframe
        aria-label={ariaLabel}
        className="pointer-events-none absolute left-1/2 top-1/2 border-0"
        loading="lazy"
        src={src}
        style={{
          width: canvasWidth,
          height: canvasHeight,
          opacity: scale > 0 ? 1 : 0,
          transform: `translate(-50%, -50%) scale(${scale || 1})`,
          transformOrigin: "center",
        }}
        tabIndex={tabIndex}
        title={title}
      />
    </div>
  );
}
