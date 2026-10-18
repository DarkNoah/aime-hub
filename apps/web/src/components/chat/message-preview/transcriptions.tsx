import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import {
  Captions,
  Copy,
  ExternalLink,
  FileAudio,
  FileCheck2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getStatusBadge, ToolOutput } from '@/components/ai-elements/tool';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  parseTranscriptionsOutput,
  transcriptionTimestamp,
} from './transcriptions-output';
import { webPreviewLink } from './web-link';
import type { PreviewPart } from './selection';

export function TranscriptionsPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const input =
    isToolUIPart(part) && part.input && typeof part.input === 'object'
      ? (part.input as Record<string, unknown>)
      : {};
  const result = useMemo(
    () => parseTranscriptionsOutput(output, input.response_format),
    [output, input.response_format],
  );
  if (!isToolUIPart(part)) return null;
  const source =
    typeof input.file === 'string'
      ? input.file
      : typeof input.audio === 'string'
        ? input.audio
        : undefined;
  const sourceLink = source ? webPreviewLink(source) : null;
  const savePath =
    typeof input.save_path === 'string' ? input.save_path : undefined;
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available';
  const error =
    part.errorText ||
    (part.state === 'output-error' || result?.failed
      ? result?.message || t('chat.transcriptions.failed')
      : undefined);
  const complete = part.state === 'output-available' && !!result && !error;
  const language = result?.language;
  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      toast.success(t('chat.transcriptions.copied'));
    } catch {
      toast.error(t('chat.preview.copyFailed'));
    }
  };
  const transcript = result?.text.trim() ? (
    <p className="max-w-prose whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">
      {result.text}
    </p>
  ) : (
    <p role="status" className="py-6 text-sm leading-6 text-muted-foreground">
      {t('chat.transcriptions.empty')}
    </p>
  );

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Captions className="size-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-medium">{t('tools.transcriptions')}</h3>
        {getStatusBadge(error ? 'output-error' : part.state)}
      </div>
      {source && (
        <section
          aria-label={t('chat.transcriptions.source')}
          className="min-w-0 space-y-1 rounded-lg bg-muted/50 p-3"
        >
          <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <FileAudio className="size-3.5" aria-hidden="true" />
            {t('chat.transcriptions.source')}
          </h4>
          {sourceLink ? (
            <a
              href={sourceLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2 rounded py-1 text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {source}
              </span>
              <ExternalLink
                className="mt-1 size-3.5 shrink-0"
                aria-hidden="true"
              />
            </a>
          ) : /^[a-z][a-z\d+.-]*:/i.test(source) ? (
            <p className="text-sm [overflow-wrap:anywhere]">{source}</p>
          ) : (
            <WorkspaceFileLink path={source} />
          )}
        </section>
      )}
      {pending && !error && (
        <div role="status" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('chat.transcriptions.loading')}
          </p>
          <div aria-hidden="true" className="space-y-2">
            <Skeleton className="h-3 w-4/5 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-full motion-reduce:animate-none" />
            <Skeleton className="h-3 w-3/5 motion-reduce:animate-none" />
          </div>
        </div>
      )}
      {complete && (
        <section
          aria-label={t('chat.transcriptions.result')}
          className="min-w-0 space-y-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {result.format === 'verbose_json'
                ? 'JSON · verbose'
                : result.format.toUpperCase()}
            </Badge>
            {result.truncated && (
              <Badge variant="secondary">
                {t('chat.transcriptions.truncated')}
              </Badge>
            )}
            {language && (
              <Badge
                variant="secondary"
                className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
              >
                {t('chat.transcriptions.language', { language })}
              </Badge>
            )}
            {result.duration !== undefined && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('chat.transcriptions.duration', {
                  duration: transcriptionTimestamp(result.duration),
                })}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto text-muted-foreground"
              disabled={!result.text.trim()}
              aria-label={t(
                result.truncated
                  ? 'chat.transcriptions.copyExcerpt'
                  : 'chat.transcriptions.copy',
              )}
              title={t(
                result.truncated
                  ? 'chat.transcriptions.copyExcerpt'
                  : 'chat.transcriptions.copy',
              )}
              onClick={copy}
            >
              <Copy className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          {result.truncated && (
            <p className="text-xs leading-5 text-muted-foreground">
              {t('chat.transcriptions.truncatedHint')}
            </p>
          )}
          {result.cues.length > 0 ? (
            <Tabs
              key={part.toolCallId}
              defaultValue="timeline"
              className="min-w-0 gap-4"
            >
              <TabsList aria-label={t('chat.transcriptions.view')}>
                <TabsTrigger value="timeline">
                  {t('chat.transcriptions.timeline')}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {result.cues.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="text">
                  {t('chat.transcriptions.text')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="timeline">
                <ol className="divide-y">
                  {result.cues.map((cue, index) => (
                    <li
                      key={index}
                      className="space-y-1.5 py-3 first:pt-0 [content-visibility:auto] [contain-intrinsic-size:auto_88px]"
                    >
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                        <time>{transcriptionTimestamp(cue.start)}</time>
                        <span aria-hidden="true">→</span>
                        <time>{transcriptionTimestamp(cue.end)}</time>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">
                        {cue.text}
                      </p>
                    </li>
                  ))}
                </ol>
              </TabsContent>
              <TabsContent value="text">{transcript}</TabsContent>
            </Tabs>
          ) : (
            transcript
          )}
          {savePath && (
            <section
              aria-label={t('chat.transcriptions.saved')}
              className="space-y-1 border-t pt-3"
            >
              <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <FileCheck2 className="size-3.5" aria-hidden="true" />
                {t('chat.transcriptions.saved')}
              </h4>
              <WorkspaceFileLink path={savePath} />
            </section>
          )}
        </section>
      )}
      {error || (!pending && !result && output !== undefined) ? (
        <ToolOutput output={error ? undefined : output} errorText={error} />
      ) : null}
    </div>
  );
}
