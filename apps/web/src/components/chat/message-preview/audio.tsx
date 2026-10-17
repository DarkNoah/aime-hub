import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import { voiceSchema } from '@aime/shared/audio';
import { getStatusBadge, ToolOutput } from '@/components/ai-elements/tool';
import { AudioClip } from '@/components/audio/audio-clip';
import { audioApi } from '@/components/audio/api';
import { Badge } from '@/components/ui/badge';
import type { PreviewPart } from './selection';

export function TranscribePreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const output =
    part.output && typeof part.output === 'object'
      ? (part.output as Record<string, unknown>)
      : undefined;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t('tools.transcribe')}</h3>
        {getStatusBadge(output?.isError ? 'output-error' : part.state)}
      </div>
      {output?.isError !== true &&
      output?.ok !== false &&
      typeof output?.text === 'string' ? (
        <p className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {output.text}
        </p>
      ) : (
        <ToolOutput output={part.output} errorText={part.errorText} />
      )}
    </div>
  );
}

export function VoicesPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const output =
    part.output && typeof part.output === 'object'
      ? (part.output as Record<string, unknown>)
      : undefined;
  const voices = voiceSchema.array().safeParse(output?.voices);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t('voices.title')}</h3>
        {getStatusBadge(output?.isError ? 'output-error' : part.state)}
      </div>
      {output?.ok === true && voices.success ? (
        voices.data.length ? (
          voices.data.map((voice) => (
            <section
              key={voice.audioPath}
              className="space-y-2 rounded-lg border p-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{voice.name}</span>
                <Badge variant="outline">
                  {t(voice.shared ? 'voices.shared' : 'voices.personal')}
                </Badge>
              </div>
              {voice.description && (
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                  {voice.description}
                </p>
              )}
              <AudioClip
                src={audioApi.raw(voice.audioPath)}
                filename={voice.name}
                mediaType="audio/wav"
              />
              <p className="text-sm whitespace-pre-wrap">{voice.text}</p>
              <code className="block text-xs break-all text-muted-foreground">
                {voice.audioPath}
              </code>
            </section>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{t('voices.empty')}</p>
        )
      ) : (
        <ToolOutput output={part.output} errorText={part.errorText} />
      )}
    </div>
  );
}
