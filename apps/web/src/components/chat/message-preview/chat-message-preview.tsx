import { Braces, ChevronDown, ScanText, X } from 'lucide-react';
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

export function ChatMessagePreview({
  part,
  onClose,
}: {
  part: PreviewPart | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b px-3">
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
            <MessagePartPreview part={part} />
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
              <CollapsibleContent className="pt-2">
                <CodeBlock
                  code={JSON.stringify(part, null, 2)}
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
