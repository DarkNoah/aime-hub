import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { UserQuestion } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { QuestionDraft } from './question-answer';

export function ChatQuestionFields({
  question,
  json = false,
  draft,
  disabled,
  onChange,
}: {
  question?: UserQuestion;
  json?: boolean;
  draft: QuestionDraft;
  disabled: boolean;
  onChange: (draft: QuestionDraft) => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const multi = question?.selectionMode === 'multi_select';
  return (
    <>
      {!!question?.options?.length && (
        <div
          className="space-y-2"
          role="group"
          aria-label={t(
            multi
              ? 'chat.toolInteraction.chooseMany'
              : 'chat.toolInteraction.chooseOne',
          )}
        >
          <p className="text-xs text-muted-foreground">
            {t(
              multi
                ? 'chat.toolInteraction.chooseMany'
                : 'chat.toolInteraction.chooseOne',
            )}
          </p>
          {question.options.map((option, index) => {
            const checked = draft.selected.includes(option.label);
            return (
              <Button
                key={`${index}:${option.label}`}
                type="button"
                variant="outline"
                aria-pressed={checked}
                disabled={disabled}
                className={cn(
                  'h-auto w-full justify-start gap-3 whitespace-normal px-3 py-3 text-left',
                  checked && 'border-primary bg-primary/5',
                )}
                onClick={() => {
                  const selected = !multi
                    ? [option.label]
                    : checked
                      ? draft.selected.filter((label) => label !== option.label)
                      : [...draft.selected, option.label];
                  onChange({
                    ...draft,
                    selected,
                    text: multi ? draft.text : '',
                  });
                }}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center border',
                    multi ? 'rounded' : 'rounded-full',
                    checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/50',
                  )}
                >
                  {checked && <Check className="size-3" />}
                </span>
                <span className="min-w-0 space-y-1">
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="block text-xs font-normal leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </Button>
            );
          })}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor={inputId}>
          {t(
            question?.options?.length
              ? 'chat.toolInteraction.otherAnswer'
              : json
                ? 'chat.toolInteraction.resumeData'
                : 'chat.toolInteraction.answer',
          )}
        </Label>
        <Textarea
          id={inputId}
          value={draft.text}
          disabled={disabled}
          maxLength={60000}
          className="min-h-20 resize-y"
          placeholder={t(
            json
              ? 'chat.toolInteraction.jsonPlaceholder'
              : 'chat.toolInteraction.placeholder',
          )}
          onChange={(event) => {
            const text = event.target.value;
            onChange({
              ...draft,
              text,
              selected: !multi && text ? [] : draft.selected,
            });
          }}
        />
      </div>
    </>
  );
}
