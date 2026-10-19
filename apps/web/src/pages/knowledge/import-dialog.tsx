import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Upload } from 'lucide-react';
import {
  knowledgeFileAccept,
  maxKnowledgeFileBytes,
  type KnowledgeDocument,
  type KnowledgeField,
  type KnowledgeTags,
  type KnowledgeMetadata,
  type KnowledgeDocumentDetail,
  type KnowledgeSource,
} from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { TagsEditor } from './tags-editor';
import { MetadataEditor } from './metadata-editor';
import { knowledgeError } from './errors';

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
export function ImportDialog({
  baseId,
  document,
  fields = [],
  embeddingEnabled = false,
  newVersion = false,
  locked = false,
  onClose,
  onImported,
}: {
  baseId: string;
  document?: KnowledgeDocumentDetail;
  fields?: KnowledgeField[];
  embeddingEnabled?: boolean;
  newVersion?: boolean;
  locked?: boolean;
  onClose: () => void;
  onImported: (doc: KnowledgeDocument) => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState(
    newVersion
      ? 'file'
      : document
        ? document.sourceType === 'url'
          ? 'url'
          : document.sourceType === 'file' &&
              (!document.content || document.image)
            ? 'file'
            : 'text'
        : 'file',
  );
  const [tags, setTags] = useState<KnowledgeTags | undefined>(
    document?.tags ?? {},
  );
  const [metadata, setMetadata] = useState<KnowledgeMetadata | undefined>(
    document?.metadata ?? {},
  );
  const [name, setName] = useState(document?.name ?? '');
  const [content, setContent] = useState(document?.content ?? '');
  const [url, setUrl] = useState(document?.sourceUrl ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const persist = (source: KnowledgeSource) =>
    document
      ? newVersion
        ? api.knowledge.createVersion({
            id: document.id,
            data: { source, tags, metadata, expectedVersion: document.version },
          })
        : api.knowledge.updateDocument({
            id: document.id,
            data: { source, tags, metadata, expectedVersion: document.version },
          })
      : api.knowledge.import({ id: baseId, source, tags, metadata });
  async function submit() {
    if (busy || locked || !tags || !metadata) return;
    if (
      type === 'file' &&
      files.some((f) => f.size > maxKnowledgeFileBytes || !f.size)
    ) {
      toast.error(t('knowledge.errorTooLarge'));
      return;
    }
    setBusy(true);
    try {
      if (type === 'file') {
        for (const file of files) {
          setProgress(file.name);
          onImported(
            await persist({
              type: 'file',
              name: file.name,
              data: await base64(file),
            }),
          );
          setFiles((current) => current.filter((f) => f !== file));
        }
      } else
        onImported(
          await persist(
            type === 'text'
              ? { type: 'text', name, content }
              : { type: 'url', name, url },
          ),
        );
      toast.success(
        t(embeddingEnabled ? 'knowledge.embeddingQueued' : 'knowledge.queued'),
      );
      onClose();
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setBusy(false);
      setProgress('');
    }
  }
  const valid =
    type === 'file'
      ? files.length > 0
      : type === 'text'
        ? name.trim() && content.trim()
        : url.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        <ScrollArea viewportProps={{ className: 'max-h-[90dvh]' }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-5 p-6"
          >
            <DialogHeader>
              <DialogTitle>
                {t(
                  newVersion
                    ? 'knowledge.updateVersion'
                    : document
                      ? 'knowledge.editDocument'
                      : 'knowledge.import',
                )}
              </DialogTitle>
              <DialogDescription>
                {t(
                  newVersion
                    ? 'knowledge.updateVersionHint'
                    : document
                      ? 'knowledge.editDocumentHint'
                      : 'knowledge.importHint',
                )}
              </DialogDescription>
            </DialogHeader>
            <fieldset disabled={busy || locked}>
              <Tabs value={type} onValueChange={setType}>
                <TabsList>
                  <TabsTrigger value="file" disabled={busy}>
                    {t('knowledge.file')}
                  </TabsTrigger>
                  <TabsTrigger value="text" disabled={busy}>
                    {t('knowledge.text')}
                  </TabsTrigger>
                  <TabsTrigger value="url" disabled={busy}>
                    {t('knowledge.url')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="file" className="space-y-3">
                  <div className="space-y-3 rounded-lg border border-dashed p-6">
                    <Upload className="size-6 text-muted-foreground" />
                    <Label htmlFor="kb-files">
                      {t('knowledge.chooseFiles')}
                    </Label>
                    <Input
                      id="kb-files"
                      type="file"
                      multiple={!document}
                      accept={knowledgeFileAccept}
                      disabled={busy}
                      onChange={(e) =>
                        setFiles(Array.from(e.target.files ?? []))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('knowledge.formats')}
                    </p>
                  </div>
                  <ScrollArea className="max-h-36">
                    <ul className="space-y-1 text-sm">
                      {files.map((f, i) => (
                        <li key={`${f.name}-${i}`} className="break-all">
                          {f.name} · {(f.size / 1024).toFixed(0)} KB
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="text" className="space-y-3">
                  <Label htmlFor="kb-text-title">{t('knowledge.name')}</Label>
                  <Input
                    id="kb-text-title"
                    value={name}
                    maxLength={240}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Label htmlFor="kb-text">{t('knowledge.content')}</Label>
                  <Textarea
                    id="kb-text"
                    className="min-h-64"
                    maxLength={1_000_000}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                  />
                </TabsContent>
                <TabsContent value="url" className="space-y-3">
                  <Label htmlFor="kb-url">{t('knowledge.url')}</Label>
                  <Input
                    id="kb-url"
                    type="url"
                    placeholder="https://example.com/article"
                    maxLength={4096}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <Label htmlFor="kb-url-title">
                    {t('knowledge.optionalName')}
                  </Label>
                  <Input
                    id="kb-url-title"
                    value={name}
                    maxLength={240}
                    onChange={(e) => setName(e.target.value)}
                  />
                </TabsContent>
              </Tabs>
            </fieldset>
            <TagsEditor
              initial={document?.tags}
              onChange={setTags}
              disabled={busy || locked}
            />
            <MetadataEditor
              fields={fields}
              initial={document?.metadata}
              onChange={setMetadata}
              disabled={busy || locked}
            />
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('knowledge.uploading')} {progress}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={busy}
              >
                {t('knowledge.cancel')}
              </Button>
              <Button disabled={locked || busy || !valid || !tags || !metadata}>
                {t(
                  newVersion
                    ? 'knowledge.updateVersion'
                    : document
                      ? embeddingEnabled
                        ? 'knowledge.saveAndEmbed'
                        : 'knowledge.saveAndIndex'
                      : 'knowledge.import',
                )}
              </Button>
            </DialogFooter>
          </form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
