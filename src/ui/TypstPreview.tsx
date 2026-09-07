import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../error';
import { typstRenderKey, type TypstAddonRecord } from '../model';

interface TypstPreviewProps {
  record: TypstAddonRecord;
  emptyLabel?: string;
  onSettled?: () => void;
}

const PAGE_GAP = 28;

const addPageSeparation = (svg: SVGSVGElement) => {
  const pages = Array.from(svg.querySelectorAll<SVGGElement>('.typst-page'));
  if (!pages.length) return;

  pages.forEach((page, index) => {
    const width = Number(page.dataset.pageWidth);
    const height = Number(page.dataset.pageHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;

    const transform = page.getAttribute('transform') ?? '';
    const translated = transform.match(
      /translate\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)/,
    );
    if (translated) {
      const nextY = Number(translated[2]) + index * PAGE_GAP;
      page.setAttribute(
        'transform',
        transform.replace(translated[0], `translate(${translated[1]}, ${nextY})`),
      );
    }

    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('class', 'typst-preview-page-background');
    background.setAttribute('width', String(width));
    background.setAttribute('height', String(height));
    background.setAttribute('fill', '#fff');
    page.prepend(background);
  });

  if (pages.length < 2) return;
  const extraHeight = (pages.length - 1) * PAGE_GAP;
  const originalHeight = Number(svg.dataset.height || svg.getAttribute('height'));
  if (Number.isFinite(originalHeight)) {
    const nextHeight = originalHeight + extraHeight;
    svg.setAttribute('height', String(nextHeight));
    svg.dataset.height = String(nextHeight);
  }

  const viewBox = svg.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    viewBox[3] += extraHeight;
    svg.setAttribute('viewBox', viewBox.join(' '));
  }
};

const sanitizeTypstSvg = (value: string): string => {
  // typst.ts emits an HTML-embeddable SVG. Its helper script is valid in HTML,
  // but script characters such as `&&` make strict XML parsing reject the
  // otherwise valid SVG before we have a chance to remove the script.
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  const svg = parsed.querySelector('svg');
  if (!svg) {
    throw new Error('Typst 返回了无效的 SVG');
  }

  svg.querySelectorAll('script, iframe, object, embed').forEach((element) => element.remove());
  [svg, ...Array.from(svg.querySelectorAll('*'))].forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const content = attribute.value.trim().toLowerCase();
      if (
        name.startsWith('on') ||
        ((name === 'href' || name === 'xlink:href') &&
          (content.startsWith('javascript:') || content.startsWith('vbscript:')))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  addPageSeparation(svg);

  return svg.outerHTML;
};

export const TypstPreview = ({
  record,
  emptyLabel = '暂无 Typst 内容',
  onSettled,
}: TypstPreviewProps) => {
  const requestId = useRef(0);
  const onSettledRef = useRef(onSettled);
  const [svg, setSvg] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [settledKey, setSettledKey] = useState<string>();
  const renderKey = typstRenderKey(record);

  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    if (!record.source.trim()) {
      setError(undefined);
      setLoading(false);
      setSvg(undefined);
      setSettledKey(renderKey);
      return;
    }

    const currentRequest = ++requestId.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      import('../typst')
        .then(({ renderTypst }) => renderTypst(record))
        .then((result) => {
          if (requestId.current !== currentRequest) return;
          setSvg(sanitizeTypstSvg(result));
          setError(undefined);
          setSettledKey(renderKey);
        })
        .catch((reason) => {
          if (requestId.current === currentRequest) {
            setError(errorMessage(reason));
            setSettledKey(renderKey);
          }
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    }, 350);

    return () => window.clearTimeout(timer);
  }, [record, renderKey]);

  useEffect(() => {
    if (settledKey === renderKey) onSettledRef.current?.();
  }, [renderKey, settledKey]);

  return (
    <div className="preview-shell" aria-live="polite">
      {svg ? (
        <div
          className="preview-document"
          aria-label="Typst 预览"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
      {!svg && !loading ? <div className="preview-empty">{emptyLabel}</div> : null}
      {loading ? <div className="preview-loading">正在编译 Typst…</div> : null}
      {error ? <pre className="preview-error">{error}</pre> : null}
    </div>
  );
};
