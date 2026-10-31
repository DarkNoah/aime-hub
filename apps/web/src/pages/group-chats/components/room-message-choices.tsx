import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LoaderCircle } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import type { GroupChatMessage } from '@aime/shared/group-chats';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { groupChatErrorKey } from '../api';

export function RoomMessageChoices({
  choices,
  submittedOptions,
  onSend,
}: {
  choices: NonNullable<GroupChatMessage['choices']>;
  submittedOptions?: string[];
  onSend: (id: string, selectedOptions: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<string[]>([]);
  const [sentOptions, setSentOptions] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const accepted = useRef(false);
  const requestIds = useRef(new Map<string, string>());
  const submitted = submittedOptions ?? sentOptions;
  const selected = submitted ?? selection;
  const disabled = pending || submitted != null;

  async function send(options: string[]) {
    if (sending.current || accepted.current || submitted || !options.length)
      return;
    sending.current = true;
    setPending(true);
    setSelection(options);
    // Canonical ordering keeps retry IDs stable even after toggling a selection.
    const ordered = choices.options.filter((option) =>
      options.includes(option),
    );
    const signature = JSON.stringify(ordered);
    const id = requestIds.current.get(signature) ?? nanoid();
    requestIds.current.set(signature, id);
    try {
      await onSend(id, ordered);
      accepted.current = true;
      setSentOptions(ordered);
      toast.success(t('groupChat.choicesSent'));
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return (
    <fieldset
      data-room-choices
      disabled={disabled}
      aria-busy={pending}
      className="mt-2 min-w-0 space-y-2"
    >
      <legend className="mb-2 text-xs text-muted-foreground">
        {t(
          choices.multiple
            ? 'groupChat.choicesMultipleHint'
            : 'groupChat.choicesSingleHint',
        )}
      </legend>
      <div className="grid min-w-0 gap-2">
        {choices.options.map((option) => {
          const checked = selected.includes(option);
          return choices.multiple ? (
            <label
              key={option}
              className={`flex min-h-10 min-w-0 items-start gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors ${checked ? 'border-primary/40 bg-primary/5' : 'border-border'} ${disabled ? 'cursor-default' : 'cursor-pointer hover:bg-accent'}`}
            >
              <Checkbox
                checked={checked}
                disabled={disabled}
                className="mt-0.5"
                onCheckedChange={(value) =>
                  setSelection((current) =>
                    value === true
                      ? [...current, option]
                      : current.filter((item) => item !== option),
                  )
                }
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{option}</span>
            </label>
          ) : (
            <Button
              key={option}
              type="button"
              variant={checked ? 'secondary' : 'outline'}
              disabled={disabled}
              aria-pressed={checked}
              className="h-auto min-h-10 w-full justify-start whitespace-normal text-left [overflow-wrap:anywhere]"
              onClick={() => void send([option])}
            >
              {checked &&
                (pending ? (
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Check className="size-4" />
                ))}
              <span className="min-w-0">{option}</span>
            </Button>
          );
        })}
      </div>
      <div aria-live="polite" className="flex min-h-7 items-center gap-2">
        {submitted ? (
          <Badge variant="secondary" className="gap-1">
            <Check className="size-3" aria-hidden="true" />
            {t('groupChat.choicesSent')}
          </Badge>
        ) : choices.multiple ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled || !selection.length}
            onClick={() => void send(selection)}
          >
            {pending && (
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t(pending ? 'groupChat.choicesSending' : 'groupChat.choicesSend')}
          </Button>
        ) : pending ? (
          <span className="text-xs text-muted-foreground">
            {t('groupChat.choicesSending')}
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}
