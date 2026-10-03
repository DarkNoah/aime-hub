import { ChevronDown, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { Tool, ToolContent } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';

export function ChatBackgroundTask({
  toolName,
  result,
}: {
  toolName: string;
  result: unknown;
}) {
  const { t } = useTranslation();
  return (
    <Tool defaultOpen={false} className="mb-0">
      <Item
        asChild
        size="sm"
        className="w-full cursor-pointer text-left hover:bg-muted/50"
      >
        <CollapsibleTrigger>
          <ItemMedia>
            <Wrench
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>{t('chat.backgroundTask', { toolName })}</ItemTitle>
          </ItemContent>
          <Badge variant="secondary">{t('chat.toolDone')}</Badge>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
      </Item>
      <ToolContent className="pt-0">
        <div className="space-y-2">
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground">
            {t('chat.toolResult')}
          </h4>
          <ScrollArea
            className="min-w-0 rounded-md bg-muted/50"
            viewportProps={{ className: 'max-h-56' }}
          >
            <CodeBlock
              code={
                typeof result === 'string'
                  ? result
                  : (JSON.stringify(result, null, 2) ?? '')
              }
              language="json"
              className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
            />
          </ScrollArea>
        </div>
      </ToolContent>
    </Tool>
  );
}
