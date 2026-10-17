import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize, Minus, Plus } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { PreviewFallback, PreviewFrame } from './preview-frame';
import { PreviewLoading } from './preview-loading';
import type { PreviewRendererProps } from './types';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const assetRoot = `${import.meta.env.BASE_URL}file-preview/pdfjs/${pdfjs.version}/`;
const options = {
  cMapUrl: `${assetRoot}cmaps/`,
  standardFontDataUrl: `${assetRoot}standard_fonts/`,
  wasmUrl: `${assetRoot}wasm/`,
};

export default function PdfPreview({ url, downloadUrl }: PreviewRendererProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [passwordRequired, setPasswordRequired] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(1, Math.floor(entry.contentRect.width - 32)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const goToPage = (next: number) => {
    if (!Number.isFinite(next)) return;
    setPage(Math.max(1, Math.min(pages, Math.trunc(next))));
    viewport.current?.scrollTo({ top: 0, left: 0 });
  };
  const failure = (
    <PreviewFrame>
      <PreviewFallback
        downloadUrl={downloadUrl}
        mediaError
        message={t('files.pdfError')}
      />
    </PreviewFrame>
  );

  return (
    <div ref={container} className="flex h-full min-h-0 min-w-0 flex-col">
      {passwordRequired ? (
        <PreviewFrame>
          <PreviewFallback
            downloadUrl={downloadUrl}
            mediaError
            message={t('files.pdfPassword')}
          />
        </PreviewFrame>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('files.previousPage')}
                aria-label={t('files.previousPage')}
                disabled={page <= 1 || !pages}
                onClick={() => goToPage(page - 1)}
              >
                <ChevronLeft />
              </Button>
              <Input
                key={page}
                type="number"
                min={1}
                max={pages || 1}
                defaultValue={page}
                disabled={!pages}
                aria-label={t('files.pageNumber')}
                className="h-8 w-14 px-1 text-center text-xs tabular-nums"
                onBlur={(event) => {
                  const next = event.currentTarget.valueAsNumber;
                  goToPage(next);
                  event.currentTarget.value = String(
                    Number.isFinite(next)
                      ? Math.max(1, Math.min(pages, Math.trunc(next)))
                      : page,
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <span
                className="px-1 text-xs text-muted-foreground tabular-nums"
                aria-live="polite"
              >
                / {pages || '—'}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('files.nextPage')}
                aria-label={t('files.nextPage')}
                disabled={!pages || page >= pages}
                onClick={() => goToPage(page + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('imagePreview.zoomOut')}
                aria-label={t('imagePreview.zoomOut')}
                disabled={!pages || zoom <= 0.5}
                onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
              >
                <Minus />
              </Button>
              <span className="w-10 text-center text-xs tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('imagePreview.zoomIn')}
                aria-label={t('imagePreview.zoomIn')}
                disabled={!pages || zoom >= 3}
                onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('files.fitWidth')}
                aria-label={t('files.fitWidth')}
                disabled={!pages}
                onClick={() => setZoom(1)}
              >
                <Maximize />
              </Button>
            </div>
          </div>
          <ScrollArea
            className="min-h-0 flex-1 bg-muted/30"
            viewportProps={{ ref: viewport }}
          >
            <Document
              file={url}
              options={options}
              suspense={false}
              loading={<PreviewLoading />}
              error={failure}
              onLoadSuccess={({ numPages }) => setPages(numPages)}
              onPassword={() => setPasswordRequired(true)}
              onItemClick={({ pageNumber }) => goToPage(pageNumber)}
              externalLinkTarget="_blank"
              externalLinkRel="noopener noreferrer"
              className="min-w-full p-4"
            >
              {width > 0 && (
                <Page
                  suspense={false}
                  pageNumber={page}
                  width={width}
                  scale={zoom}
                  devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
                  loading={<PreviewLoading />}
                  error={failure}
                  className="mx-auto w-fit bg-white text-black shadow-sm"
                />
              )}
            </Document>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </>
      )}
    </div>
  );
}
