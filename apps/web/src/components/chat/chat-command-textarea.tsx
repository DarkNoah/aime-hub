import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  applySlashCommand,
  filterCommandGroups,
  getSlashCommand,
  getMentionCommand,
  insertMention,
  type SlashCommandGroup,
  type SlashCommandItem,
} from './slash-command';
import type { TranslationKey } from '@/i18n/config';
import './chat-command-textarea.css';

export function ChatCommandTextarea({
  value,
  onValueChange,
  disabled,
  placeholder,
  groups,
  loading,
  error,
  onRetry,
  onOpenChange,
  onCommand,
  trigger = '/',
  inputRef,
  ariaLabel,
  maxLength,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  groups: SlashCommandGroup[];
  loading: boolean;
  error?: TranslationKey;
  onRetry: () => void;
  onOpenChange: (open: boolean) => void;
  onCommand?: (item: SlashCommandItem) => boolean | void;
  trigger?: '/' | '@';
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  ariaLabel?: string;
  maxLength?: number;
}) {
  const { t } = useTranslation();
  const id = useId();
  const localTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? localTextarea;
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [selected, setSelected] = useState('');
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const mentionCommand =
    trigger === '@'
      ? getMentionCommand(
          value,
          selection.start,
          selection.end,
          groups.flatMap((group) =>
            group.sections.flatMap((section) =>
              section.items.flatMap((item) =>
                item.action === 'mention' ? [item.mention] : [],
              ),
            ),
          ),
        )
      : null;
  const command =
    trigger === '@'
      ? mentionCommand
      : getSlashCommand(value, selection.start, selection.end);
  const open = focused && !disabled && !dismissed && command !== null;
  const filteredGroups = filterCommandGroups(groups, command?.query ?? '');
  const matches = filteredGroups.flatMap((group) =>
    group.sections.flatMap((section) => section.items),
  );
  const selectable = matches.filter((item) => !item.disabled);
  const activeIndex = Math.max(
    0,
    selectable.findIndex((item) => item.id === selected),
  );
  const activeItem = selectable[activeIndex];
  const activeId = activeItem?.id;

  useEffect(() => {
    onOpenChange(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open)
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId]);

  function complete(item: SlashCommandItem) {
    if (!command || disabled || item.disabled) return;
    if (item.action && onCommand?.(item) === false) return;
    const next =
      item.action === 'mention' && mentionCommand
        ? insertMention(value, mentionCommand.start, command.end, item.mention)
        : applySlashCommand(value, command.end, item);
    if (maxLength !== undefined && next.text.length > maxLength) return;
    onValueChange(next.text);
    setDismissed(true);
    // The drawing dialog takes focus; leave its canvas keyboard shortcuts active.
    if (item.action === 'draw' || item.action === 'voices') return;
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(true);
      }}
    >
      <PopoverAnchor asChild>
        <PromptInputTextarea
          ref={textarea}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            setSelection({
              start: event.target.selectionStart,
              end: event.target.selectionEnd,
            });
            setDismissed(false);
            setSelected('');
            setKeyboardSelection(false);
          }}
          onSelect={(event) =>
            setSelection({
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            })
          }
          onFocus={() => {
            setFocused(true);
            setDismissed(false);
          }}
          onBlur={() => setFocused(false)}
          onCompositionStartCapture={() => {
            composing.current = true;
          }}
          onCompositionEndCapture={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            ) {
              // PromptInput's handler runs after this one; prevent IME Enter from submitting.
              if (event.key === 'Enter') event.preventDefault();
              return;
            }
            if (
              !open ||
              event.shiftKey ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey
            )
              return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(true);
            } else if (
              (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
              selectable.length
            ) {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setKeyboardSelection(true);
              setSelected(
                selectable[
                  (activeIndex + step + selectable.length) % selectable.length
                ].id,
              );
            } else if (
              (event.key === 'Enter' || event.key === 'Tab') &&
              activeItem
            ) {
              event.preventDefault();
              complete(activeItem);
            } else if (
              event.key === 'Enter' &&
              (loading || matches.length > 0)
            ) {
              event.preventDefault();
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={ariaLabel ?? t('chat.message')}
          maxLength={maxLength}
          aria-autocomplete="list"
          aria-controls={open ? `${id}-list` : undefined}
          aria-activedescendant={
            open && activeId ? `${id}-option-${activeId}` : undefined
          }
          className="max-h-44 min-h-20"
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={12}
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target === textarea.current) event.preventDefault();
        }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <div>
          <div
            id={`${id}-list`}
            ref={list}
            role="listbox"
            aria-label={t(
              trigger === '@'
                ? 'groupChat.mentionAgent'
                : 'chat.commands.title',
            )}
            className="max-h-none overflow-hidden"
          >
            {loading && matches.length === 0 ? (
              <p
                role="status"
                className="px-3 py-5 text-sm text-muted-foreground"
              >
                {t('chat.commands.loading')}
              </p>
            ) : error && matches.length === 0 ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 px-3 py-4 text-sm"
              >
                <span className="text-destructive">{t(error)}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onRetry}
                >
                  {t('chat.retry')}
                </Button>
              </div>
            ) : matches.length === 0 ? (
              <p
                role="status"
                className="px-3 py-5 text-sm text-muted-foreground"
              >
                {t(
                  trigger === '@'
                    ? command?.query
                      ? 'groupChat.mentionNoMatch'
                      : 'groupChat.mentionEmpty'
                    : command?.query
                      ? 'chat.commands.noMatch'
                      : 'chat.commands.empty',
                )}
              </p>
            ) : (
              <ScrollArea
                className="min-w-0 max-h-64"
                viewportProps={{ className: 'max-h-64 [&>div]:block!' }}
              >
                <div className="space-y-2 p-1">
                  {filteredGroups.map((group) => (
                    <div key={group.id} role="group" aria-label={group.label}>
                      {group.label && (
                        <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                          {group.label}
                        </div>
                      )}
                      {group.sections.map((section) => (
                        <div
                          key={section.id}
                          role="group"
                          aria-label={section.label}
                        >
                          {section.label && (
                            <div
                              className="truncate px-2.5 pt-2 pb-1 text-[11px] text-muted-foreground"
                              title={section.label}
                            >
                              {section.label}
                            </div>
                          )}
                          {section.items.map((item) => (
                            <Button
                              key={item.id}
                              id={`${id}-option-${item.id}`}
                              type="button"
                              variant="ghost"
                              role="option"
                              disabled={item.disabled}
                              aria-disabled={item.disabled}
                              aria-selected={item.id === activeId}
                              data-keyboard-active={
                                keyboardSelection && item.id === activeId
                              }
                              tabIndex={-1}
                              onMouseMove={() => {
                                setSelected(item.id);
                                setKeyboardSelection(false);
                              }}
                              onClick={() => complete(item)}
                              className={cn(
                                'chat-command-option relative block h-auto min-h-8 w-full min-w-0 rounded-md px-2.5 py-0 text-left font-normal whitespace-normal transition-colors',
                                item.id === activeId &&
                                  'bg-accent text-accent-foreground',
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className="chat-command-summary pointer-events-none absolute inset-0 flex min-w-0 items-center gap-2 px-2.5"
                              >
                                <span className="max-w-1/2 shrink-0 truncate">
                                  {item.action === 'mention'
                                    ? `@${item.name}`
                                    : item.action === 'agent'
                                      ? item.name
                                      : `/${item.name}`}
                                </span>
                                {item.current && (
                                  <Badge variant="secondary">
                                    {t('chat.commands.currentAgent')}
                                  </Badge>
                                )}
                                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                  {item.description}
                                </span>
                              </span>
                              <span className="chat-command-details grid min-w-0">
                                <span className="min-h-0 overflow-hidden">
                                  <span className="flex min-w-0 flex-col gap-1 py-2 [overflow-wrap:anywhere]">
                                    <span className="flex flex-wrap items-center gap-2">
                                      {item.action === 'mention'
                                        ? `@${item.name}`
                                        : item.action === 'agent'
                                          ? item.name
                                          : `/${item.name}`}
                                      {item.current && (
                                        <Badge variant="secondary">
                                          {t('chat.commands.currentAgent')}
                                        </Badge>
                                      )}
                                    </span>
                                    <span className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
                                      {item.description}
                                    </span>
                                  </span>
                                </span>
                              </span>
                            </Button>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            {t('chat.commands.hint')}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
