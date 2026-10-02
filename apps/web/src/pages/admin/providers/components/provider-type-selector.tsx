import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  languageModelProviders,
  providerGroups,
  type ProviderInput,
} from '@aime/shared/providers';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

const groups = {
  languageModel: Object.entries(languageModelProviders),
  other: [['mineru', 'MinerU']],
} as const;

export function ProviderTypeSelector({
  value,
  onChange,
  disabled,
}: {
  value: ProviderInput['type'];
  onChange: (type: ProviderInput['type']) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <input type="hidden" name="type" value={value} />
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="provider-type"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t('providers.type')}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{value}</span>
            <ChevronsUpDown
              className="shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-0"
        >
          <Command loop>
            <CommandInput
              placeholder={t('providers.searchTypes')}
              aria-label={t('providers.searchTypes')}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>{t('providers.noResults')}</CommandEmpty>
              {providerGroups.map((group) => (
                <CommandGroup
                  key={group}
                  heading={t(`providers.group.${group}`)}
                >
                  {groups[group].map(([key, name]) => (
                    <CommandItem
                      key={key}
                      value={key}
                      keywords={[name]}
                      onSelect={() => {
                        onChange(key as ProviderInput['type']);
                        setOpen(false);
                      }}
                      className="min-h-10"
                    >
                      <span className="min-w-0 flex-1 truncate">{key}</span>
                      {value === key && (
                        <Check aria-label={t('modelSelector.selected')} />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
