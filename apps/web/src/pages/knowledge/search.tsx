import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type {
  KnowledgeBase,
  KnowledgeHit,
  KnowledgeMetadata,
  KnowledgeTags,
} from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { KnowledgeHitBadges } from '@/components/knowledge/hit-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { MetadataEditor } from './metadata-editor';
import { knowledgeError } from './errors';

export function KnowledgeSearch({
  base,
  tags,
  metadata,
  onMetadataChange,
  onPreview,
}: {
  base: KnowledgeBase;
  tags: KnowledgeTags;
  metadata: KnowledgeMetadata;
  onMetadataChange: (value: KnowledgeMetadata) => void;
  onPreview: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<ReturnType<typeof knowledgeError>>();
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previewing = useRef(false);

  useEffect(() => () => request.current?.abort(), []);

  function close() {
    request.current?.abort();
    setSearching(false);
    setOpen(false);
  }

  async function search() {
    const text = query.trim();
    if (!text || !base.enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    previewing.current = false;
    setSubmittedQuery(text);
    setOpen(true);
    setSearching(true);
    setHits([]);
    setError(undefined);
    try {
      const result = await api.knowledge.search(
        { id: base.id, query: text, topK: 8, tags, metadata },
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setHits(result);
    } catch (e) {
      if (!controller.signal.aborted) {
        const message = knowledgeError(e);
        setError(message);
        toast.error(t(message));
      }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  return (
    <>
      <form
        role="search"
        className="ml-auto w-full sm:w-80"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <InputGroup>
          <InputGroupInput
            ref={input}
            aria-label={t('knowledge.query')}
            placeholder={t('knowledge.query')}
            value={query}
            maxLength={2000}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing)
                event.preventDefault();
            }}
          />
          <InputGroupAddon align="inline-end" className="gap-1">
            {base.fields.length > 0 && (
              <MetadataFilters
                fields={base.fields}
                metadata={metadata}
                onChange={onMetadataChange}
              />
            )}
            <InputGroupButton
              type="submit"
              size="icon-sm"
              aria-label={t('knowledge.search')}
              title={t(
                base.enabled ? 'knowledge.search' : 'knowledge.disabled',
              )}
              disabled={!query.trim() || searching || !base.enabled}
            >
              <Search />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          className="flex max-h-[85dvh] flex-col sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!previewing.current) input.current?.focus();
          }}
        >
          <DialogHeader className="min-w-0 pr-6 text-left">
            <DialogTitle className="flex items-center gap-2">
              {t('knowledge.searchResults')}
              {!searching && !error && (
                <Badge variant="secondary">{hits.length}</Badge>
              )}
            </DialogTitle>
            <p
              title={submittedQuery}
              className="line-clamp-2 break-words text-sm font-medium [overflow-wrap:anywhere]"
            >
              {submittedQuery}
            </p>
            <DialogDescription>
              {t('knowledge.searchResultsHint')}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea
            className="min-h-0 flex-1"
            viewportProps={{ className: 'max-h-[60dvh]' }}
          >
            <div className="space-y-4 pr-3" aria-busy={searching}>
              {searching ? (
                <div role="status" className="space-y-6 py-3">
                  <span className="sr-only">{t('knowledge.searching')}</span>
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="space-y-3" aria-hidden="true">
                      <Skeleton className="h-5 w-1/3" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-4/5" />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div role="alert" className="space-y-4 py-10 text-center">
                  <p className="text-sm text-destructive">{t(error)}</p>
                  <Button variant="outline" onClick={() => void search()}>
                    {t('knowledge.retry')}
                  </Button>
                </div>
              ) : hits.length ? (
                hits.map((hit) => (
                  <div
                    key={hit.id}
                    className="space-y-2 border-b pb-4 last:border-0 last:pb-0"
                  >
                    <button
                      type="button"
                      className="text-left text-sm font-medium hover:underline [overflow-wrap:anywhere]"
                      onClick={() => {
                        previewing.current = true;
                        close();
                        onPreview(hit.documentId);
                      }}
                    >
                      {hit.name}
                    </button>
                    <KnowledgeHitBadges hit={hit} />
                    <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                      {hit.text}
                    </p>
                  </div>
                ))
              ) : (
                <p
                  role="status"
                  className="py-12 text-center text-sm text-muted-foreground"
                >
                  {t('knowledge.noResults')}
                </p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MetadataFilters({
  fields,
  metadata,
  onChange,
}: {
  fields: KnowledgeBase['fields'];
  metadata: KnowledgeMetadata;
  onChange: (value: KnowledgeMetadata) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<KnowledgeMetadata | undefined>(metadata);
  const [editorKey, setEditorKey] = useState(0);
  const count = Object.keys(metadata).length;
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (value) {
          setDraft(metadata);
          setEditorKey((key) => key + 1);
        }
        setOpen(value);
      }}
    >
      <PopoverTrigger asChild>
        <InputGroupButton
          size={count ? 'sm' : 'icon-sm'}
          variant={count ? 'secondary' : 'ghost'}
          aria-label={t('knowledge.moreFilters')}
          title={t('knowledge.moreFilters')}
        >
          <SlidersHorizontal />
          {count > 0 && (
            <Badge variant="secondary" className="h-5 min-w-5 px-1">
              {count}
            </Badge>
          )}
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className="w-80 max-w-[calc(100vw-2rem)] space-y-4"
      >
        <PopoverHeader>
          <PopoverTitle>{t('knowledge.moreFilters')}</PopoverTitle>
          <PopoverDescription>
            {t('knowledge.metadataFilterHint')}
          </PopoverDescription>
        </PopoverHeader>
        <ScrollArea viewportProps={{ className: 'max-h-[min(50dvh,24rem)]' }}>
          <div className="pr-3">
            <MetadataEditor
              key={editorKey}
              fields={fields}
              initial={metadata}
              filtering
              onChange={setDraft}
            />
          </div>
        </ScrollArea>
        <div className="flex justify-between gap-2 border-t pt-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange({});
              setOpen(false);
            }}
          >
            {t('knowledge.clearFilters')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!draft}
            onClick={() => {
              if (!draft) return;
              if (draft !== metadata) onChange(draft);
              setOpen(false);
            }}
          >
            {t('knowledge.applyFilters')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
