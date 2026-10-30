import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Bot } from 'lucide-react';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import { useAvailableAgents } from '@/features/agents/use-available-agents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { groupChatApi, groupChatErrorKey } from '../api';

export function RoomAgentPicker({
  roomId,
  projectId,
  agents,
  onSaved,
  onClose,
}: {
  roomId: string;
  projectId?: string;
  agents: GroupChatAgent[];
  onSaved: (agent: GroupChatAgent) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const catalog = useAvailableAgents(projectId, true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const joined = new Set(
    agents
      .filter((agent) => agent.role !== 'bot')
      .map((agent) => agent.settings.agentId ?? catalog.data?.defaultAgentId),
  );
  const choices = catalog.data?.agents ?? [];
  async function add() {
    if (pending) return;
    setPending(true);
    try {
      for (const item of choices.filter(
        (item) => selected.has(item.id) && !joined.has(item.id),
      )) {
        const saved = await groupChatApi.addAgent(roomId, {
          name: item.name,
          settings: { agentId: item.id, model: null, reasoningEffort: 'auto' },
          enabled: true,
        });
        onSaved(saved);
        setSelected((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
      toast.success(t('groupChat.agentSaved'));
      onClose();
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={!pending}
      >
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>{t('groupChat.addAgent')}</DialogTitle>
          <DialogDescription>{t('groupChat.pickAgentsHint')}</DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="min-h-0"
          viewportProps={{ className: 'max-h-[55dvh]' }}
        >
          <div className="space-y-2 px-6 pb-4">
            {catalog.loading && (
              <p role="status" className="py-6 text-sm text-muted-foreground">
                {t('chat.loading')}
              </p>
            )}
            {catalog.error && (
              <Button variant="outline" onClick={catalog.retry}>
                {t('agents.retry')}
              </Button>
            )}
            {!catalog.loading && !catalog.error && !choices.length && (
              <p className="py-6 text-sm text-muted-foreground">
                {t('groupChat.noAvailableAgents')}
              </p>
            )}
            {choices.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/50 has-[[data-state=checked]]:border-primary/40 has-[[data-state=checked]]:bg-primary/5 has-disabled:cursor-default"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={joined.has(item.id) || selected.has(item.id)}
                  disabled={pending || joined.has(item.id)}
                  aria-label={item.name}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })
                  }
                />
                <Bot
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-sm font-medium">{item.name}</span>
                  {item.description && (
                    <span className="block line-clamp-2 text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </span>
                {joined.has(item.id) && (
                  <Badge variant="secondary">
                    {t('groupChat.agentJoined')}
                  </Badge>
                )}
              </label>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('agents.cancel')}
          </Button>
          <Button
            onClick={() => void add()}
            disabled={
              pending ||
              !choices.some(
                (item) => selected.has(item.id) && !joined.has(item.id),
              )
            }
          >
            {t(pending ? 'agents.saving' : 'groupChat.addSelectedAgents')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
