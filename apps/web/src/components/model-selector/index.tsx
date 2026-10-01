import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Check, ChevronDown, CircleSlash, Plug, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { groupModelOptions, modelOptions } from './model-options';
import { useAvailableModels } from '@/features/models/use-available-models';
import { cn } from '@/lib/utils';

export type { ModelOption } from './model-options';

export type ModelSelectorProps = {
  id?: string;
  label: string;
  imageOnly?: boolean;
  textOnly?: boolean;
  compact?: boolean;
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  noneLabel?: string;
  emptyHint?: string;
};

export function ModelSelector({
  id,
  label,
  imageOnly = false,
  textOnly = false,
  compact = false,
  value,
  onValueChange,
  disabled = false,
  noneLabel,
  emptyHint,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const { providers, models, loading, error, refresh } = useAvailableModels();
  const options = useMemo(
    () =>
      modelOptions(
        providers,
        textOnly
          ? models.filter((model) => model.modalitiesOutput.includes('text'))
          : models,
        imageOnly,
      ),
    [providers, models, imageOnly, textOnly],
  );
  const noneText = noneLabel ?? t('modelSelector.none');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  const groups = groupModelOptions(options, search);
  const selectedLabel =
    (loading ? t('modelSelector.loading') : undefined) ??
    selected?.label ??
    (value ? t('modelSelector.unavailable', { reference: value }) : noneText);

  function select(next: string | null) {
    if (disabled || loading || error) return;
    onValueChange(next);
    setOpen(false);
  }

  return (
    <Dialog
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch('');
      }}
    >
      <DialogTrigger asChild>
        <Button
          id={id}
          type="button"
          variant={compact ? 'ghost' : 'outline'}
          disabled={disabled}
          className={cn(
            'w-full min-w-0 justify-between px-3 font-normal',
            compact && 'h-8 gap-1.5 px-2 text-xs text-muted-foreground',
          )}
          aria-label={`${label}: ${selectedLabel}`}
          title={selectedLabel}
        >
          <span
            className={cn(
              'flex min-w-0 items-center gap-2',
              compact && 'gap-1.5',
            )}
          >
            <Box
              className="shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="truncate">
              {selected?.displayName ?? selectedLabel}
            </span>
          </span>
          <ChevronDown
            className={cn(
              'shrink-0 text-muted-foreground',
              compact && 'size-3',
            )}
            aria-hidden="true"
          />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInput.current?.focus();
        }}
      >
        <DialogHeader className="relative shrink-0 px-5 pt-5 pb-4 text-left">
          <DialogTitle className="pr-10 text-base">
            {t('modelSelector.title', { label })}
          </DialogTitle>
          <DialogDescription className="pr-8 text-xs leading-5">
            {t('modelSelector.hint')}
          </DialogDescription>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3"
              aria-label={t('common.close')}
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>
        <Command
          label={t('modelSelector.search')}
          shouldFilter={false}
          loop
          defaultValue={selected?.value ?? '__none__'}
          className="min-h-0 rounded-none bg-transparent **:data-[slot=command-input-wrapper]:h-12"
        >
          <CommandInput
            ref={searchInput}
            value={search}
            onValueChange={setSearch}
            placeholder={t('modelSelector.search')}
            aria-label={t('modelSelector.search')}
            className="h-12"
          />
          <CommandList
            className="max-h-[min(52dvh,420px)] scroll-py-2 p-2"
            label={label}
          >
            {!loading && !error && !search.trim() && (
              <CommandItem
                value="__none__"
                onSelect={() => select(null)}
                className="min-h-11 cursor-pointer rounded-lg px-3"
              >
                <CircleSlash aria-hidden="true" />
                <span className="flex-1">{noneText}</span>
                {value === null && (
                  <Check
                    className="text-primary"
                    aria-label={t('modelSelector.selected')}
                  />
                )}
              </CommandItem>
            )}
            {!loading &&
              !error &&
              groups.map((group) => (
                <CommandGroup
                  key={group.id}
                  heading={
                    <span className="flex items-center gap-2">
                      <Plug className="size-3.5" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">
                        {group.name}
                      </span>
                      <span className="tabular-nums">
                        {group.models.length}
                      </span>
                    </span>
                  }
                >
                  {group.models.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      onSelect={() => select(option.value)}
                      className="min-h-14 cursor-pointer gap-3 rounded-lg px-3 py-2.5"
                    >
                      <Box aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {option.displayName}
                        </span>
                        <span
                          className="mt-0.5 block truncate font-mono text-xs text-muted-foreground"
                          title={option.id}
                        >
                          {option.id}
                        </span>
                      </span>
                      {value === option.value && (
                        <Check
                          className="text-primary"
                          aria-label={t('modelSelector.selected')}
                        />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            {loading && (
              <p
                role="status"
                className="p-8 text-center text-sm text-muted-foreground"
              >
                {t('modelSelector.loading')}
              </p>
            )}
            {error && (
              <div className="space-y-3 p-8 text-center">
                <p role="alert" className="text-sm text-destructive">
                  {t(error)}
                </p>
                <Button variant="outline" onClick={() => void refresh()}>
                  {t('modelSelector.retry')}
                </Button>
              </div>
            )}
            {!loading && !error && groups.length === 0 && (
              <div role="status" className="px-4 py-10 text-center">
                <Box
                  className="mx-auto mb-3 size-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium">
                  {t(
                    options.length
                      ? 'modelSelector.noResults'
                      : 'modelSelector.empty',
                  )}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {options.length
                    ? t('modelSelector.searchHint')
                    : (emptyHint ?? t('modelSelector.emptyHint'))}
                </p>
              </div>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
