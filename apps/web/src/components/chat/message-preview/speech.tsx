import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { AudioLines, ChevronDown, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getStatusBadge, ToolOutput } from '@/components/ai-elements/tool';
import { AudioClip } from '@/components/audio/audio-clip';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import type { TranslationKey } from '@/i18n/config';
import { parseSpeechOutput } from './speech-output';
import type { PreviewPart } from './selection';

const settings: [string, TranslationKey][] = [
  ['voice', 'chat.speech.voiceId'],
  ['language', 'chat.speech.language'],
  ['speed', 'chat.speech.speed'],
  ['instructions', 'chat.speech.instruct'],
  ['ref_audio', 'chat.speech.referenceAudio'],
  ['ref_text', 'chat.speech.referenceText'],
];

export function SpeechPreview({
  part,
  threadId,
}: {
  part: PreviewPart;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(
    () => parseSpeechOutput(output, threadId),
    [output, threadId],
  );
  if (!isToolUIPart(part)) return null;
  const input =
    part.input && typeof part.input === 'object'
      ? (part.input as Record<string, unknown>)
      : {};
  const speechInput = input.input ?? input.text;
  const text = typeof speechInput === 'string' ? speechInput : '';
  const queued =
    !!output &&
    typeof output === 'object' &&
    'status' in output &&
    output.status === 'queued';
  const path = queued
    ? undefined
    : (result?.path ??
      (typeof input.save_path === 'string' ? input.save_path : undefined));
  const parameters = settings.flatMap(([key, label]) => {
    // Keep historical tool calls readable after the parameter rename.
    const value =
      key === 'voice'
        ? (input.voice ?? input.voice_id)
        : key === 'instructions'
          ? (input.instructions ?? input.instruct)
          : input[key];
    return (typeof value === 'string' && value.trim()) ||
      (typeof value === 'number' && Number.isFinite(value))
      ? [{ key, label, value: key === 'speed' ? `${value}×` : String(value) }]
      : [];
  });
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available';
  const error =
    part.errorText ||
    (result?.failed ? result.message || t('chat.speech.failed') : undefined);

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <AudioLines className="size-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-medium">{t('tools.speech')}</h3>
        {getStatusBadge(result?.failed ? 'output-error' : part.state)}
      </div>
      {result?.audio.map(
        (clip, index) =>
          clip.type === 'media' && (
            <AudioClip
              key={index}
              src={clip.source}
              filename={
                clip.filename?.split('/').at(-1) ||
                path?.split('/').at(-1) ||
                t('chat.readFile.attachment')
              }
              mediaType={clip.mediaType}
              sampleRate={result.sampleRate}
              onOpen={openFile && path ? () => openFile(path) : undefined}
            />
          ),
      )}
      {queued && (
        <p className="text-sm text-muted-foreground">
          {t('chat.speech.queued')}
        </p>
      )}
      {pending && (
        <div role="status" className="space-y-3 rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">
            {t('chat.speech.generating')}
          </p>
          <Skeleton className="h-1.5 w-full motion-reduce:animate-none" />
          <Skeleton className="h-8 w-8 rounded-full motion-reduce:animate-none" />
        </div>
      )}
      {error && <ToolOutput output={undefined} errorText={error} />}
      {text && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {t('chat.speech.text')}
            </h4>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('chat.speech.copyText')}
              title={t('chat.speech.copyText')}
              className="text-muted-foreground"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  toast.success(t('chat.speech.textCopied'));
                } catch {
                  toast.error(t('chat.preview.copyFailed'));
                }
              }}
            >
              <Copy className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">
            {text}
          </p>
        </section>
      )}
      {!result?.failed && result?.message && (
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
          {result.message}
        </p>
      )}
      {(result?.model || parameters.length > 0 || path) && (
        <Collapsible className="border-t pt-3">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('chat.speech.settings')}
            <ChevronDown
              className="size-3.5 group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <dl className="space-y-3 text-sm">
              {result?.model && (
                <div className="space-y-1">
                  <dt className="text-xs text-muted-foreground">
                    {t('chat.speech.model')}
                  </dt>
                  <dd className="[overflow-wrap:anywhere]">{result.model}</dd>
                </div>
              )}
              {parameters.map(({ key, label, value }) => (
                <div key={key} className="space-y-1">
                  <dt className="text-xs text-muted-foreground">{t(label)}</dt>
                  <dd className="whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {path && <WorkspaceFileLink path={path} />}
          </CollapsibleContent>
        </Collapsible>
      )}
      {output !== undefined && !result && !queued && (
        <ToolOutput output={output} errorText={undefined} />
      )}
    </div>
  );
}
