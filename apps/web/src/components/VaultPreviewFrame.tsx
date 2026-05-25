import { useEffect, useRef, useState } from 'react';

interface Props {
  src: string;
  title: string;
  className?: string;
  width?: number;
  height?: number;
  sandbox?: string;
}

export function VaultPreviewFrame({
  src,
  title,
  className,
  width = 800,
  height = 500,
  sandbox,
}: Props) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setScale(Math.min(1, rect.width / width, rect.height / height));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [height, width]);

  return (
    <span
      ref={containerRef}
      className={`vault-preview-frame-wrap${className ? ` ${className}` : ''}`}
    >
      <iframe
        className="vault-preview-frame"
        src={src}
        title={title}
        tabIndex={-1}
        loading="lazy"
        sandbox={sandbox}
        style={{
          width,
          height,
          opacity: scale > 0 ? 1 : 0,
          transform: `translate(-50%, -50%) scale(${scale || 1})`,
        }}
      />
    </span>
  );
}
