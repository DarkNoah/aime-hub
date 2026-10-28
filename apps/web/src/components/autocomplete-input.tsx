import { useCallback, useState } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';

export interface AutocompleteOption {
  value: string;
  label: string;
}

/** A free-text input with remotely filtered suggestions. */
export function AutocompleteInput({
  id,
  value,
  options,
  open,
  onOpenChange,
  onValueChange,
  onSelect,
  placeholder,
  required,
  status,
}: {
  id: string;
  value: string;
  options: AutocompleteOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void;
  onSelect: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  status?: string;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    // Keep the popup inside a modal's focus/pointer boundary, outside its scroll area.
    if (node) setContainer(node.closest<HTMLElement>('[role="dialog"]'));
  }, []);

  return (
    <Autocomplete.Root
      value={value}
      items={options}
      filter={null}
      itemToStringValue={(item) => item.value}
      autoHighlight
      openOnInputClick
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={onValueChange}
      required={required}
    >
      <Autocomplete.Input
        id={id}
        ref={inputRef}
        render={<Input />}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229 &&
            open &&
            !options.length
          ) {
            event.preventDefault();
          }
        }}
      />
      <Autocomplete.Status className="sr-only">{status}</Autocomplete.Status>
      <Autocomplete.Portal container={container ?? undefined}>
        <Autocomplete.Positioner
          sideOffset={4}
          align="start"
          className="z-50 w-(--anchor-width) max-w-[calc(100vw-2rem)]"
        >
          <Autocomplete.Popup className="rounded-md border bg-popover text-popover-foreground outline-none">
            {status && (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {status}
              </p>
            )}
            <ScrollArea
              viewportProps={{
                className: 'max-h-[min(16rem,var(--available-height))]',
              }}
            >
              <Autocomplete.List className="p-1 empty:p-0">
                {(item: AutocompleteOption) => (
                  <Autocomplete.Item
                    key={item.value}
                    value={item}
                    onClick={() => onSelect(item.value)}
                    className="flex cursor-default flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm px-2 py-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <span className="min-w-0 break-words">{item.label}</span>
                    <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {item.value}
                    </span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </ScrollArea>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
