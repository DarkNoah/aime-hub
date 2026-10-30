import { lazy, Suspense, useEffect, useState } from 'react';
import type { FilePreview as Preview } from '@aime/shared/files';
import {
  Download,
  Eye,
  Loader2,
  Pencil,
  RotateCcw,
  RotateCw,
  Save,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fileErrorKey } from './api';
import { FilePreviewContent } from './preview/file-preview-content';
import { PreviewLoading } from './preview/preview-loading';
import type { WorkspaceFileClient } from './workspace-client';
import type { FileEdits } from './use-file-edits';
import { DiscardEditsDialog } from './discard-edits-dialog';
import { useFileWrap } from './use-file-wrap';
import { getPreviewKind } from './preview/preview-kind';

const TextEditor = lazy(() => import('./preview/text-editor'));
type PreviewMode = 'rendered' | 'source' | 'edit';

export function FilePreview({
  client,
  path,
  line,
  revision,
  edits,
}: {
  client: WorkspaceFileClient;
  path: string;
  line?: number;
  revision: number;
  edits: FileEdits;
}) {
  const { t } = useTranslation();
  const [wrap, setWrap] = useFileWrap();
  const [loaded, setData] = useState<Preview | null>(null);
  const edit = edits.get(path);
  const hasEdit = !!edit;
  const [view, setView] = useState<{ mode: PreviewMode; line?: number }>({
    mode: hasEdit ? 'edit' : line ? 'source' : 'rendered',
    line,
  });
  const [resetting, setResetting] = useState(false);
  const dirty = !!edit && edit.text !== edit.base.text;
  const data = edit?.base ?? loaded;
  const [error, setError] = useState<ReturnType<typeof fileErrorKey> | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (hasEdit) return;
    const controller = new AbortController();
    void client
      .preview(path, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(fileErrorKey(cause));
      });
    return () => controller.abort();
  }, [client, path, revision, retry, hasEdit]);
  function reload() {
    edits.discard(path);
    setView({ mode: line ? 'source' : 'rendered', line });
    setData(null);
    setError(null);
    setResetting(false);
    setRetry((value) => value + 1);
  }
  if (error && !edit)
    return (
      <div role="alert" className="p-5 text-sm">
        <p>{t(error)}</p>
        <Button
          className="mt-3"
          variant="outline"
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('files.retry')}
        </Button>
      </div>
    );
  if (!data) return <PreviewLoading />;
  const editable = data.kind === 'text' && !data.truncated && !!data.version;
  const markdown = getPreviewKind(data) === 'markdown';
  // A newly selected search result should reveal its source line.
  const mode = markdown && line && line !== view.line ? 'source' : view.mode;
  const editing = mode === 'edit';
  const url = `${client.raw(path)}&v=${encodeURIComponent(data.modifiedAt)}&retry=${retry}`;
  const content =
    editing && edit ? (
      <Suspense fallback={<PreviewLoading />}>
        <TextEditor
          text={edit.text}
          line={line}
          disabled={edit.saving}
          wrap={wrap}
          onChange={(text) => edits.change(path, text)}
        />
      </Suspense>
    ) : (
      <FilePreviewContent
        key={path}
        data={edit ? { ...data, text: edit.text } : data}
        url={url}
        downloadUrl={client.raw(path, true)}
        line={line}
        wrap={wrap}
        source={markdown && mode === 'source'}
      />
    );
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (
          editable &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault();
          void edits.save(path);
        }
      }}
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1">
        <span
          title={path}
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        >
          {path}
        </span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {data.size < 1024
            ? `${data.size} B`
            : data.size < 1024 * 1024
              ? `${(data.size / 1024).toFixed(1)} KB`
              : `${(data.size / 1024 / 1024).toFixed(1)} MB`}
        </Badge>
        {dirty && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t('files.unsaved')}
          </Badge>
        )}
        {data.kind === 'text' && (!markdown || mode !== 'rendered') && (
          <label className="mx-1 inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              size="sm"
              checked={wrap}
              onCheckedChange={setWrap}
              aria-label={t('files.wordWrap')}
            />
            {t('files.wordWrap')}
          </label>
        )}
        {editable && (
          <>
            {!markdown && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(editing ? 'files.renderedPreview' : 'files.edit')}
                title={t(editing ? 'files.renderedPreview' : 'files.edit')}
                onClick={() => {
                  if (!editing) edits.start(data);
                  setView({ mode: editing ? 'rendered' : 'edit', line });
                }}
              >
                {editing ? (
                  <Eye className="size-3.5" />
                ) : (
                  <Pencil className="size-3.5" />
                )}
              </Button>
            )}
            {edit && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={edit.saving}
                  aria-label={t('files.discard')}
                  title={t('files.discard')}
                  onClick={() => (dirty ? setResetting(true) : reload())}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!dirty || edit.saving}
                  onClick={() => void edits.save(path)}
                  title={t('files.saveShortcut')}
                >
                  {edit.saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {t(edit.saving ? 'files.saving' : 'files.save')}
                </Button>
              </>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('files.refreshPreview')}
          title={t('files.refreshPreview')}
          disabled={edit?.saving}
          onClick={() => (dirty ? setResetting(true) : reload())}
        >
          <RotateCw className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <a
            href={client.raw(path, true)}
            download
            aria-label={t('files.download')}
            title={t('files.download')}
          >
            <Download className="size-3.5" />
          </a>
        </Button>
      </div>
      {data.truncated && (
        <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t('files.previewLimit')}
        </p>
      )}
      {edit?.error && (
        <p
          role="alert"
          className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {t(edit.error)}
        </p>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        {markdown ? (
          <Tabs
            value={mode}
            onValueChange={(value) => {
              if (
                value !== 'rendered' &&
                value !== 'source' &&
                value !== 'edit'
              )
                return;
              if (value === 'edit') {
                if (!editable) return;
                edits.start(data);
              }
              setView({ mode: value, line });
            }}
            className="h-full min-h-0 min-w-0 gap-0"
          >
            <div className="shrink-0 border-b px-3 py-2">
              <TabsList aria-label={t('files.previewMode')} className="h-8">
                <TabsTrigger value="rendered" className="text-xs">
                  {t('files.renderedPreview')}
                </TabsTrigger>
                <TabsTrigger value="source" className="text-xs">
                  {t('files.markdownSource')}
                </TabsTrigger>
                <TabsTrigger
                  value="edit"
                  className="text-xs"
                  disabled={!editable}
                >
                  {t('files.editMode')}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent key={mode} value={mode} className="min-h-0 min-w-0">
              {content}
            </TabsContent>
          </Tabs>
        ) : (
          content
        )}
      </div>
      <DiscardEditsDialog
        open={resetting}
        onCancel={() => setResetting(false)}
        onDiscard={reload}
      />
    </div>
  );
}
