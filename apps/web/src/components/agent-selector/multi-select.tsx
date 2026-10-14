import { useId, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AvailableAgent } from '@aime/shared/agents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AgentDetails } from './agent-details';

export function AgentMultiSelect({
  value,
  onValueChange,
  agents,
  label,
  disabled,
}: {
  value: string[];
  onValueChange: (ids: string[]) => void;
  agents: AvailableAgent[];
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = new Set(value);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const missing = value
    .filter((agentId) => !byId.has(agentId))
    .map((agentId) => ({
      id: agentId,
      name: agentId,
      description: t('agents.unavailable'),
    }));
  const query = search.trim().toLowerCase();
  const visible = [...agents, ...missing].filter((agent) =>
    `${agent.name} ${agent.id} ${agent.description}`
      .toLowerCase()
      .includes(query),
  );
  const remove = (agentId: string) =>
    onValueChange(value.filter((item) => item !== agentId));

  return (
    <div className="space-y-3">
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setSearch('');
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="w-full justify-between gap-3 font-normal"
            aria-label={label}
          >
            <span className="truncate">{label}</span>
            <span className="ml-auto flex items-center gap-2">
              {value.length > 0 ? (
                <Badge variant="secondary">{value.length}</Badge>
              ) : null}
              <ChevronDown className="size-4 text-muted-foreground" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInput.current?.focus();
          }}
        >
          <div className="relative border-b p-2">
            <Search
              className="pointer-events-none absolute left-5 top-4.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              ref={searchInput}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('agents.selectSearch')}
              aria-label={t('agents.selectSearch')}
              className="pl-9"
            />
          </div>
          <ScrollArea
            viewportProps={{
              className:
                'max-h-[min(24rem,calc(var(--radix-popover-content-available-height)-4rem))] [&>div]:block!',
            }}
          >
            <div role="group" aria-label={label} className="space-y-2 p-2">
              {visible.map((agent) => (
                <Label
                  key={agent.id}
                  htmlFor={`${id}-${agent.id}`}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 focus-within:ring-2 focus-within:ring-ring/30 has-[[data-state=checked]]:border-primary/40 has-[[data-state=checked]]:bg-primary/5"
                >
                  <Checkbox
                    id={`${id}-${agent.id}`}
                    checked={selected.has(agent.id)}
                    disabled={disabled}
                    className="mt-0.5"
                    aria-label={agent.name}
                    onCheckedChange={(checked) => {
                      if (checked) onValueChange([...value, agent.id]);
                      else remove(agent.id);
                    }}
                  />
                  <AgentDetails agent={agent} />
                </Label>
              ))}
              {visible.length === 0 ? (
                <p
                  role="status"
                  className="p-5 text-center text-sm text-muted-foreground"
                >
                  {t(query ? 'agents.noMatches' : 'agents.empty')}
                </p>
              ) : null}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
      {value.map((agentId) => {
        const agent = byId.get(agentId);
        return (
          <Card
            key={agentId}
            className="flex-row items-start gap-3 rounded-lg p-3"
          >
            <AgentDetails
              agent={
                agent ?? {
                  id: agentId,
                  name: agentId,
                  description: t('agents.unavailable'),
                }
              }
            />
            {!agent ? (
              <Badge variant="destructive">{t('agents.unavailable')}</Badge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={t('agents.removeSubagent', {
                name: agent?.name ?? agentId,
              })}
              onClick={() => remove(agentId)}
            >
              <X />
            </Button>
          </Card>
        );
      })}
    </div>
  );
}
