import {
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  ChevronDown,
  ExternalLink,
  Layers2,
  LoaderCircle,
  Maximize2,
  Minus,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useFloatingPosition } from '@/components/floating-window/use-floating-position';

export type FloatingPreviewStackHandle = { minimize: () => void };

export type FloatingPreviewItem = {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  status?: ReactNode;
  closing?: boolean;
  onOpen: () => void;
  onClose: () => void;
};

function readLayout(key: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object')
      return {
        minimized: 'minimized' in value && value.minimized === true,
        selected:
          'selected' in value && typeof value.selected === 'string'
            ? value.selected
            : '',
      };
  } catch {
    /* Unavailable storage should not prevent previewing. */
  }
  return { minimized: false, selected: '' };
}

/** Shared dock for live previews. Content is mounted only for the front, expanded card. */
export function FloatingPreviewStack({
  items,
  renderPreview,
  storageKey,
  label,
  openLabel,
  closeLabel,
  minimizeLabel,
  expandLabel,
  switchLabel,
  moveLabel,
  closeIcon,
  minimizeOnOpen = false,
  ref,
  className,
}: {
  items: FloatingPreviewItem[];
  renderPreview: (item: FloatingPreviewItem) => ReactNode;
  storageKey: string;
  label: string;
  openLabel: string;
  closeLabel: string;
  minimizeLabel: string;
  expandLabel: string;
  switchLabel: string;
  moveLabel: string;
  closeIcon?: ReactNode;
  minimizeOnOpen?: boolean;
  ref?: Ref<FloatingPreviewStackHandle>;
  className?: string;
}) {
  const [layout, setLayout] = useState(() => readLayout(storageKey));
  const selected =
    items.find((item) => item.id === layout.selected) ?? items[0];
  const { containerRef, moveHandleProps } = useFloatingPosition(
    `${storageKey}:position`,
    !!selected,
  );
  useImperativeHandle(
    ref,
    () => ({
      minimize: () =>
        setLayout((previous) =>
          previous.minimized ? previous : { ...previous, minimized: true },
        ),
    }),
    [],
  );
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch {
      /* Keep controls usable. */
    }
  }, [layout, storageKey]);
  if (!selected) return null;
  const open = () => {
    if (minimizeOnOpen)
      setLayout((previous) => ({ ...previous, minimized: true }));
    selected.onOpen();
  };
  return (
    <section
      ref={containerRef}
      aria-label={label}
      className={cn(
        'fixed top-20 right-4 z-40 max-w-[calc(100vw-2rem)] transition-[width] duration-200 motion-reduce:transition-none',
        layout.minimized ? 'w-64' : 'w-80',
        className,
      )}
      data-floating-preview-stack
    >
      {items.length > 2 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 translate-y-3 scale-x-[0.94] rounded-xl bg-muted ring-1 ring-border"
        />
      )}
      {items.length > 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 translate-y-1.5 scale-x-[0.97] rounded-xl bg-card ring-1 ring-border"
        />
      )}
      <div className="relative overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
        <header className="flex h-11 items-center gap-1.5 px-2">
          <button
            type="button"
            className="flex size-7 shrink-0 touch-none items-center justify-center rounded-sm text-primary select-none outline-none focus-visible:ring-2 focus-visible:ring-ring [&&]:cursor-grab [&&]:active:cursor-grabbing"
            aria-label={moveLabel}
            title={moveLabel}
            {...moveHandleProps}
          >
            {selected.icon ?? <Layers2 className="size-4" />}
          </button>
          <button
            type="button"
            {...moveHandleProps}
            onClick={open}
            title={openLabel}
            className="min-w-0 flex-1 touch-none truncate rounded-sm text-left text-xs font-medium select-none outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring [&&]:cursor-grab [&&]:active:cursor-grabbing"
          >
            {selected.title}
          </button>
          {items.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-0.5 px-1.5 text-xs"
                  aria-label={switchLabel}
                >
                  <span>{items.length}</span>
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <ScrollArea
                  className="max-h-64"
                  viewportProps={{ style: { maxHeight: 256 } }}
                >
                  {items.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() =>
                        setLayout((previous) => ({
                          ...previous,
                          selected: item.id,
                        }))
                      }
                      className="gap-2"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {item.title}
                      </span>
                      {item.id === selected.id && (
                        <span
                          className="size-1.5 rounded-full bg-primary"
                          aria-hidden
                        />
                      )}
                    </DropdownMenuItem>
                  ))}
                </ScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={layout.minimized ? expandLabel : minimizeLabel}
            title={layout.minimized ? expandLabel : minimizeLabel}
            onClick={() =>
              setLayout((previous) => ({
                ...previous,
                minimized: !previous.minimized,
              }))
            }
          >
            {layout.minimized ? (
              <Maximize2 className="size-3.5" />
            ) : (
              <Minus className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={selected.closing}
            aria-label={closeLabel}
            title={closeLabel}
            onClick={selected.onClose}
          >
            {selected.closing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              (closeIcon ?? <X className="size-3.5" />)
            )}
          </Button>
        </header>
        {!layout.minimized && (
          <>
            <div className="relative aspect-video overflow-hidden border-y bg-muted/30">
              {renderPreview(selected)}
              <button
                type="button"
                onClick={open}
                aria-label={openLabel}
                title={openLabel}
                className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            </div>
            <footer className="flex h-9 items-center gap-2 px-3 text-[11px]">
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={selected.subtitle}
              >
                {selected.subtitle}
              </span>
              {selected.status && (
                <Badge
                  variant="secondary"
                  className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
                >
                  {selected.status}
                </Badge>
              )}
              <button
                type="button"
                onClick={open}
                aria-label={openLabel}
                title={openLabel}
                className="rounded-sm text-muted-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ExternalLink className="size-3" />
              </button>
            </footer>
          </>
        )}
      </div>
    </section>
  );
}
