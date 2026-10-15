import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KnowledgeDocumentDetail } from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { knowledgeError } from './errors';

export function DocumentSheet({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<KnowledgeDocumentDetail>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void api.knowledge
      .document({ id }, { signal: controller.signal })
      .then(setDoc)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, [id]);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="flex w-full flex-col sm:max-w-3xl">
        <div className="space-y-2 p-4">
          <SheetTitle>{doc?.name ?? t('knowledge.preview')}</SheetTitle>
          <SheetDescription>{t('knowledge.previewHint')}</SheetDescription>
        </div>
        {error ? (
          <p role="alert" className="p-4">
            {t(knowledgeError(error))}
          </p>
        ) : !doc ? (
          <p className="p-4">{t('knowledge.loading')}</p>
        ) : (
          <>
            {doc.sourceUrl && (
              <Button
                asChild
                variant="link"
                className="mx-4 justify-start truncate"
              >
                <a
                  href={doc.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {doc.sourceUrl}
                </a>
              </Button>
            )}
            <Tabs
              defaultValue="content"
              className="flex min-h-0 flex-1 flex-col px-4 pb-4"
            >
              <TabsList>
                <TabsTrigger value="content">
                  {t('knowledge.content')}
                </TabsTrigger>
                <TabsTrigger value="chunks">
                  {t('knowledge.chunks', { count: doc.chunkCount })}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="content" className="min-h-0 flex-1">
                <ScrollArea className="h-full">
                  <div className="whitespace-pre-wrap pr-4 text-sm leading-7 [overflow-wrap:anywhere]">
                    {doc.content ||
                      t(
                        doc.error
                          ? knowledgeError(doc.error)
                          : 'knowledge.notReady',
                      )}
                  </div>
                </ScrollArea>
              </TabsContent>
              <TabsContent value="chunks" className="min-h-0 flex-1">
                <ScrollArea className="h-full">
                  <div className="space-y-3 pr-4">
                    {doc.chunks.map((c) => (
                      <div
                        key={c.id}
                        className="space-y-2 rounded-lg border p-4"
                      >
                        <Badge variant="outline">#{c.position + 1}</Badge>
                        <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                          {c.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
