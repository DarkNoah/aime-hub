import { Braces, ChevronDown, ScanText, X } from 'lucide-react';
import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { transcriptionExcerpt } from '@aime/shared/audio';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { MessagePartPreview } from './renderers';
import type { PreviewPart } from './selection';
import { getToolName } from '../tool-renderers/registry';

export function ChatMessagePreview({
  part,
  threadId,
  onClose,
}: {
  part: PreviewPart | null;
  threadId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const raw = useMemo(() => {
    if (!part) return null;
    const text = JSON.stringify(part, null, 2);
    const name = isToolUIPart(part) ? getToolName(part) : undefined;
    return name === 'transcriptions' || name === 'transcribe'
      ? transcriptionExcerpt(text)
      : { text, truncated: false };
  }, [part]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        <ScanText
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {t('chat.preview.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>
      {part ? (
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: '[&>div]:!block' }}
        >
          <div className="min-w-0 space-y-5 p-4">
            <Badge
              variant="outline"
              className="max-w-full whitespace-normal break-all"
            >
              {part.type}
            </Badge>
            <MessagePartPreview part={part} threadId={threadId} />
            <Collapsible className="group border-t pt-3">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground"
                >
                  <Braces className="size-4" aria-hidden="true" />
                  {t('chat.preview.raw')}
                  <ChevronDown
                    className="ml-auto size-4 transition-transform group-data-[state=open]:rotate-180"
                    aria-hidden="true"
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                {raw?.truncated && (
                  <Badge variant="secondary">
                    {t('chat.transcriptions.truncated')}
                  </Badge>
                )}
                <CodeBlock
                  code={raw?.text ?? ''}
                  language="json"
                  className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>
      ) : (
        <div className="m-auto flex max-w-xs flex-col items-center gap-3 p-6 text-center text-muted-foreground">
          <ScanText className="size-8 opacity-60" aria-hidden="true" />
          <p className="text-sm leading-6">{t('chat.preview.empty')}</p>
        </div>
      )}
    </div>
  );
}
