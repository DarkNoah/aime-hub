import { useTranslation } from 'react-i18next';
import type { AvailableAgent, BaseAgent } from '@aime/shared/agents';
import { AgentDetails } from '@/components/agent-selector/agent-details';
import { Card } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';

export function CodeAgentSheet({
  agent,
  agents,
  onClose,
  restoreFocus,
}: {
  agent: BaseAgent;
  agents: AvailableAgent[];
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="w-full sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <header className="space-y-2 px-6 pt-6 pr-12">
          <SheetTitle>{agent.name}</SheetTitle>
          <SheetDescription>{t('agents.codeHint')}</SheetDescription>
        </header>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: '[&>div]:block!' }}
        >
          <div className="space-y-6 px-6 pb-6">
            <Badge variant="secondary">{t('agents.code')}</Badge>
            <p className="text-sm text-muted-foreground">{agent.description}</p>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('agents.model')}</h3>
              <p className="text-sm">
                {agent.model ?? t('agents.followModel')}
              </p>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">
                {t('agents.instructions')}
              </h3>
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-sm leading-6">
                {agent.instructions}
              </pre>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('agents.tools')}</h3>
              <p className="text-sm text-muted-foreground">
                {t('agents.toolsManaged')}
              </p>
              {agent.disabledTools.length > 0 && (
                <Badge variant="outline">
                  {t('agents.toolsExcluded', {
                    count: agent.disabledTools.length,
                  })}
                </Badge>
              )}
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('agents.skills')}</h3>
              <Badge variant="secondary">{t('agents.skillsAuto')}</Badge>
              <p className="text-sm text-muted-foreground">
                {t('agents.skillsAutoHint')}
              </p>
            </section>
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{t('agents.subagents')}</h3>
                <Badge variant="secondary">
                  {Object.keys(agent.agents).length}
                </Badge>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('agents.subagentsHint')}
              </p>
              {[...new Set(Object.values(agent.agents))].map((reference) => (
                <Card key={reference} className="gap-0 rounded-lg p-3">
                  <AgentDetails
                    agent={
                      agents.find((item) => item.id === reference) ?? {
                        id: reference,
                        name: reference,
                        description: '',
                      }
                    }
                  />
                </Card>
              ))}
              {Object.keys(agent.agents).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('agents.noSubagents')}
                </p>
              ) : null}
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
