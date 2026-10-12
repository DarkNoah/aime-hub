import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ChevronDown, CircleSlash, X } from 'lucide-react';
import type { AvailableAgent } from '@aime/shared/agents';
import {
  ModelSelector as SelectorDialog,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export function AgentSelector({
  value,
  onValueChange,
  agents,
  defaultAgentId,
  disabled,
  allowDefault = true,
  compact = false,
  label,
  id,
}: {
  value: string | null;
  onValueChange: (id: string | null) => void;
  agents: AvailableAgent[];
  defaultAgentId?: string;
  disabled?: boolean;
  allowDefault?: boolean;
  compact?: boolean;
  label: string;
  id?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const fallback = agents.find((agent) => agent.id === defaultAgentId);
  const selected = agents.find((agent) => agent.id === value);
  const defaultLabel = t('agents.useDefault');
  const selectedLabel = value
    ? (selected?.name ?? t('agents.selectionUnavailable'))
    : allowDefault
      ? defaultLabel
      : t('agents.selectTitle');
  const query = search.trim().toLowerCase();
  const visible = agents.filter((agent) =>
    `${agent.name} ${agent.description} ${agent.id}`
      .toLowerCase()
      .includes(query),
  );
  function select(next: string | null) {
    if (disabled) return;
    onValueChange(next);
    setOpen(false);
  }
  return (
    <SelectorDialog
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch('');
      }}
    >
      <ModelSelectorTrigger asChild>
        <Button
          id={id}
          type="button"
          variant={compact ? 'ghost' : 'outline'}
          disabled={disabled}
          className={cn(
            'w-full min-w-0 justify-between gap-2 px-3 font-normal',
            compact &&
              'h-8 gap-1.5 px-2 text-xs text-muted-foreground has-[>svg]:px-2',
          )}
          aria-label={`${label}: ${selectedLabel}`}
          title={
            !value && allowDefault && fallback
              ? `${defaultLabel} · ${fallback.name}`
              : selectedLabel
          }
        >
          <Bot className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <ModelSelectorName>{selectedLabel}</ModelSelectorName>
          <ChevronDown
            className={cn(
              'shrink-0 text-muted-foreground',
              compact && 'size-3',
            )}
            aria-hidden="true"
          />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent
        title={t('agents.selectTitle')}
        showCloseButton={false}
        className="max-h-[85dvh] gap-0 overflow-hidden"
        commandProps={{
          label: t('agents.selectSearch'),
          shouldFilter: false,
          loop: true,
          defaultValue: selected?.id ?? '__default__',
          className: 'min-h-0',
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInput.current?.focus();
        }}
      >
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            aria-label={t('common.close')}
          >
            <X aria-hidden="true" />
          </Button>
        </DialogClose>
        <ModelSelectorInput
          ref={searchInput}
          value={search}
          onValueChange={setSearch}
          placeholder={t('agents.selectSearch')}
          aria-label={t('agents.selectSearch')}
          className="pr-9"
        />
        <ModelSelectorList className="max-h-none overflow-hidden" label={label}>
          <ScrollArea
            viewportProps={{
              className: 'max-h-[min(52dvh,420px)] scroll-py-2 [&>div]:block!',
            }}
          >
            <div className="p-2">
              {allowDefault && !query && (
                <ModelSelectorItem
                  value="__default__"
                  onSelect={() => select(null)}
                  className="min-h-11 cursor-pointer gap-3 rounded-lg px-3"
                >
                  <CircleSlash aria-hidden="true" />
                  <ModelSelectorName>{defaultLabel}</ModelSelectorName>
                  {value === null && (
                    <Check
                      className="text-primary"
                      aria-label={t('modelSelector.selected')}
                    />
                  )}
                </ModelSelectorItem>
              )}
              {visible.map((agent) => (
                <ModelSelectorItem
                  key={agent.id}
                  value={agent.id}
                  onSelect={() => select(agent.id)}
                  className="min-h-14 cursor-pointer gap-3 rounded-lg px-3 py-2.5"
                >
                  <Bot aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <ModelSelectorName className="block font-medium">
                      {agent.name}
                    </ModelSelectorName>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {agent.description || agent.id}
                    </span>
                  </span>
                  {value === agent.id && (
                    <Check
                      className="text-primary"
                      aria-label={t('modelSelector.selected')}
                    />
                  )}
                </ModelSelectorItem>
              ))}
              {visible.length === 0 && (
                <p
                  role="status"
                  className="p-8 text-center text-sm text-muted-foreground"
                >
                  {t(query ? 'agents.noMatches' : 'agents.empty')}
                </p>
              )}
            </div>
          </ScrollArea>
        </ModelSelectorList>
      </ModelSelectorContent>
    </SelectorDialog>
  );
}
