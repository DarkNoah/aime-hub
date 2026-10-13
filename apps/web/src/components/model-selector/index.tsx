import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Check, ChevronDown, CircleSlash, Plug, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ModelSelector as ModelSelectorDialog,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector';
import { DialogClose } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { groupModelOptions, modelOptions } from './model-options';
import { useAvailableModels } from '@/features/models/use-available-models';
import { cn } from '@/lib/utils';
import type { ModelType } from '@aime/shared/providers';

export type { ModelOption } from './model-options';

export type ModelSelectorProps = {
  id?: string;
  label: string;
  imageOnly?: boolean;
  modelType?: ModelType;
  textOnly?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  collapseOnNarrow?: boolean;
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  noneLabel?: string;
  emptyHint?: string;
  allowNone?: boolean;
};

export function ModelSelector({
  id,
  label,
  imageOnly = false,
  modelType,
  textOnly = false,
  compact = false,
  iconOnly = false,
  collapseOnNarrow = false,
  value,
  onValueChange,
  disabled = false,
  noneLabel,
  emptyHint,
  allowNone = true,
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
        modelType ?? imageOnly,
      ),
    [providers, models, imageOnly, textOnly, modelType],
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
    <ModelSelectorDialog
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
          variant={compact || iconOnly ? 'ghost' : 'outline'}
          size={iconOnly ? 'icon-sm' : 'default'}
          disabled={disabled}
          className={cn(
            iconOnly
              ? 'size-7 shrink-0 p-0 text-muted-foreground'
              : 'w-full min-w-0 justify-between px-3 font-normal',
            compact &&
              !iconOnly &&
              'h-8 gap-1.5 px-2 text-xs text-muted-foreground',
            collapseOnNarrow &&
              !iconOnly &&
              'size-7 justify-center gap-0 p-0 has-[>svg]:px-0 @xl:h-8 @xl:w-full @xl:justify-between @xl:gap-1.5 @xl:px-2',
          )}
          aria-label={`${label}: ${selectedLabel}`}
          title={selectedLabel}
        >
          {iconOnly ? (
            <Box className="size-3.5" aria-hidden="true" />
          ) : (
            <>
              <span
                className={cn(
                  'flex min-w-0 items-center gap-2',
                  compact && 'gap-1.5',
                  collapseOnNarrow && 'gap-0 @xl:gap-1.5',
                )}
              >
                <Box
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <ModelSelectorName
                  className={collapseOnNarrow ? 'hidden @xl:block' : undefined}
                >
                  {selected?.displayName ?? selectedLabel}
                </ModelSelectorName>
              </span>
              <ChevronDown
                className={cn(
                  'shrink-0 text-muted-foreground',
                  compact && 'size-3',
                  collapseOnNarrow && 'hidden @xl:block',
                )}
                aria-hidden="true"
              />
            </>
          )}
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent
        title={t('modelSelector.title', { label })}
        showCloseButton={false}
        className="max-h-[85dvh] gap-0 overflow-hidden"
        commandProps={{
          label: t('modelSelector.search'),
          shouldFilter: false,
          loop: true,
          defaultValue: selected?.value ?? '__none__',
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
          placeholder={t('modelSelector.search')}
          aria-label={t('modelSelector.search')}
          className="pr-9"
        />
        <ModelSelectorList className="max-h-none overflow-hidden" label={label}>
          <ScrollArea
            viewportProps={{
              className: 'max-h-[min(52dvh,420px)] scroll-py-2 [&>div]:block!',
            }}
          >
            <div className="p-2">
              {allowNone && !loading && !error && !search.trim() && (
                <ModelSelectorItem
                  value="__none__"
                  onSelect={() => select(null)}
                  className="min-h-11 cursor-pointer rounded-lg px-3"
                >
                  <CircleSlash aria-hidden="true" />
                  <ModelSelectorName>{noneText}</ModelSelectorName>
                  {value === null && (
                    <Check
                      className="text-primary"
                      aria-label={t('modelSelector.selected')}
                    />
                  )}
                </ModelSelectorItem>
              )}
              {!loading &&
                !error &&
                groups.map((group) => (
                  <ModelSelectorGroup
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
                      <ModelSelectorItem
                        key={option.value}
                        value={option.value}
                        onSelect={() => select(option.value)}
                        className="min-h-14 cursor-pointer gap-3 rounded-lg px-3 py-2.5"
                      >
                        <Box aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <ModelSelectorName className="block font-medium">
                            {option.displayName}
                          </ModelSelectorName>
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
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorGroup>
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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void refresh()}
                  >
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
            </div>
          </ScrollArea>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorDialog>
  );
}
