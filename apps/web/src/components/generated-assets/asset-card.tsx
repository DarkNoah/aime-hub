import { lazy, Suspense, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Download,
  Expand,
  File,
  Music2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GeneratedAsset } from '@aime/shared/assets';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { filesApi } from '@/components/file-manager/api';
import { cn } from '@/lib/utils';

const ImageLightbox = lazy(
  () => import('@/components/image-viewer/image-lightbox'),
);

export function AssetCard({
  asset,
  selected,
  onSelect,
}: {
  asset: GeneratedAsset;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const openFile = useWorkspaceFile();
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const url = filesApi.raw(asset.threadId, asset.path);
  const downloadUrl = filesApi.raw(asset.threadId, asset.path, true);
  const dimensions =
    asset.metadata.width && asset.metadata.height
      ? { width: asset.metadata.width, height: asset.metadata.height }
      : undefined;
  const size =
    asset.size < 1024 * 1024
      ? `${Math.round(asset.size / 1024)} KB`
      : `${(asset.size / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <>
      <article
        data-asset-id={asset.id}
        className={cn(
          'group relative isolate w-full min-w-0 overflow-hidden rounded-lg border bg-card transition-colors hover:border-primary/50',
          selected && 'border-primary bg-primary/5',
        )}
      >
        {/* Sibling controls stay above this full-card selection target. */}
        <button
          type="button"
          className="absolute inset-0 z-10 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={t('assets.select', { name: asset.name })}
          aria-pressed={selected}
          onClick={() => onSelect(!selected)}
        />
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-2 right-2 z-20 flex size-6 items-center justify-center rounded-full border shadow-sm transition-opacity',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background/90 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100',
          )}
        >
          {selected && <Check className="size-3.5" />}
        </span>
        <div
          className="overflow-hidden bg-muted/40"
          style={
            asset.kind === 'image' && dimensions
              ? { aspectRatio: `${dimensions.width} / ${dimensions.height}` }
              : undefined
          }
        >
          {failed ? (
            <p role="status" className="p-4 text-xs text-muted-foreground">
              {t('assets.mediaUnavailable')}
            </p>
          ) : asset.kind === 'image' ? (
            <img
              src={url}
              alt={asset.name}
              loading="lazy"
              decoding="async"
              width={dimensions?.width}
              height={dimensions?.height}
              className="block h-auto w-full"
              onError={() => setFailed(true)}
            />
          ) : asset.kind === 'video' ? (
            <video
              src={url}
              controls
              preload="metadata"
              aria-label={asset.name}
              onError={() => setFailed(true)}
              className="relative z-20 w-full"
            />
          ) : asset.kind === 'audio' ? (
            <div className="space-y-3 p-3">
              <Music2
                aria-hidden="true"
                className="mx-auto my-4 size-8 text-muted-foreground"
              />
              <audio
                src={url}
                controls
                preload="none"
                aria-label={asset.name}
                onError={() => setFailed(true)}
                className="relative z-20 h-9 w-full min-w-0"
              />
            </div>
          ) : (
            <File
              aria-hidden="true"
              className="mx-auto my-8 size-8 text-muted-foreground"
            />
          )}
        </div>
        <div className="space-y-2 p-2.5">
          <button
            type="button"
            className="relative z-20 flex w-full min-w-0 items-center gap-1 rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            title={asset.path}
            aria-label={t('files.openPreview', { path: asset.path })}
            disabled={!openFile}
            onClick={() => openFile?.(asset.path)}
          >
            <span className="truncate">{asset.path}</span>
            <ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
          </button>
          <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {dimensions && (
              <span>
                {dimensions.width} × {dimensions.height}
              </span>
            )}
            <span>{size}</span>
            <time
              dateTime={asset.createdAt}
              title={new Date(asset.createdAt).toLocaleString(i18n.language)}
            >
              {new Date(asset.createdAt).toLocaleDateString(i18n.language, {
                month: 'short',
                day: 'numeric',
              })}
            </time>
          </div>
          <div className="flex items-center gap-1">
            <Badge variant="secondary" className="mr-auto text-[11px]">
              {t(`assets.kind.${asset.kind}`)}
            </Badge>
            {asset.kind === 'image' && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="relative z-20 text-muted-foreground"
                disabled={failed}
                aria-label={t('imagePreview.open', { name: asset.name })}
                title={t('imagePreview.open', { name: asset.name })}
                onClick={() => setPreview(true)}
              >
                <Expand className="size-4" />
              </Button>
            )}
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="relative z-20 text-muted-foreground"
            >
              <a
                href={downloadUrl}
                download={asset.name}
                aria-label={t('assets.download', { name: asset.name })}
                title={t('assets.download', { name: asset.name })}
              >
                <Download className="size-4" />
              </a>
            </Button>
          </div>
        </div>
      </article>
      {preview && (
        <Suspense fallback={null}>
          <ImageLightbox
            src={url}
            name={asset.name}
            downloadUrl={downloadUrl}
            dimensions={dimensions}
            close={() => setPreview(false)}
          />
        </Suspense>
      )}
    </>
  );
}
