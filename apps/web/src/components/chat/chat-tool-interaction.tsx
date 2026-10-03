import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleHelp, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import {
  userQuestionSchema,
  type ToolInteraction,
  type ToolResponse,
} from '@aime/shared/threads';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { chatErrorKey } from './api';

export type ToolInteractionProps = {
  interaction?: ToolInteraction;
  tool?: ToolUIPart | DynamicToolUIPart;
  disabled?: boolean;
  onRespond?: (interactionId: string, response: ToolResponse) => Promise<void>;
};

export function ChatToolInteraction({
  interaction,
  tool,
  disabled,
  onRespond,
}: ToolInteractionProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<ToolResponse>();
  const [error, setError] = useState<
    ReturnType<typeof chatErrorKey> | 'chat.toolInteraction.invalidJson'
  >();
  const sending = useRef(false);
  // Keep the request ID when retrying an acknowledgement lost to a disconnect.
  const request = useRef<{ signature: string; id: string } | null>(null);
  const toolName =
    interaction?.toolName ??
    (tool?.type === 'dynamic-tool' ? tool.toolName : tool?.type.slice(5));
  const question =
    toolName === 'ask_user'
      ? userQuestionSchema.safeParse(interaction?.suspendPayload ?? tool?.input)
          .data
      : undefined;
  const multi = question?.selectionMode === 'multi_select';
  const approval = interaction?.kind === 'approval';
  const response = interaction?.response ?? submitted;
  const hasOutput = tool?.state === 'output-available';
  const rejected =
    response?.action === 'decline' || tool?.state === 'output-denied';
  const done = !!response || hasOutput || rejected;
  const actionable = !!interaction && !done && !!onRespond;
  const unavailable = disabled || pending || !actionable;
  const answer = multi
    ? [...selected, ...(text.trim() ? [text.trim()] : [])]
    : text.trim() || selected[0] || '';
  const answered =
    response?.action === 'resume'
      ? response.data
      : hasOutput
        ? tool.output
        : undefined;
  const answerText =
    typeof answered === 'string'
      ? answered
      : Array.isArray(answered)
        ? answered.join(', ')
        : answered &&
            typeof answered === 'object' &&
            'content' in answered &&
            typeof answered.content === 'string'
          ? answered.content
          : answered === undefined
            ? ''
            : JSON.stringify(answered);
  let schema = interaction?.resumeSchema;
  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(schema);
    } catch {
      /* Display an unrecognized schema as provided. */
    }
  }
  const plainText =
    !!schema &&
    typeof schema === 'object' &&
    'type' in schema &&
    schema.type === 'string';

  async function submit(action: Omit<ToolResponse, 'id'>) {
    if (unavailable || sending.current || !interaction || !onRespond) return;
    sending.current = true;
    setPending(true);
    setError(undefined);
    const signature = JSON.stringify(action);
    if (request.current?.signature !== signature)
      request.current = { signature, id: nanoid() };
    const value = { ...action, id: request.current.id } as ToolResponse;
    try {
      await onRespond(interaction.id, value);
      setSubmitted(value);
      toast.success(t('chat.toolInteraction.sent'));
    } catch (cause) {
      const key = chatErrorKey(cause);
      setError(key);
      toast.error(t(key));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  function submitAnswer() {
    let data: ToolResponse & { action: 'resume' };
    try {
      data = {
        id: '',
        action: 'resume',
        data: question ? answer : plainText ? text : JSON.parse(text),
      };
    } catch {
      setError('chat.toolInteraction.invalidJson');
      return;
    }
    void submit(data);
  }

  return (
    <Confirmation
      approval={{
        id: interaction?.id ?? tool?.toolCallId ?? inputId,
        ...(done ? { approved: !rejected } : {}),
      }}
      state={done ? 'approval-responded' : 'approval-requested'}
      role="group"
      aria-label={question?.question ?? toolName}
      className="my-3 gap-4 rounded-xl border-border bg-card p-4 leading-normal sm:p-5"
    >
      <div className="flex w-full items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {approval ? (
            <ShieldCheck className="size-4 shrink-0 text-primary" />
          ) : (
            <CircleHelp className="size-4 shrink-0 text-primary" />
          )}
          <span>
            {t(
              approval
                ? 'chat.toolInteraction.approvalTitle'
                : 'chat.toolInteraction.questionTitle',
            )}
          </span>
        </div>
        <Badge
          variant={rejected ? 'outline' : 'secondary'}
          className="shrink-0"
        >
          {t(
            rejected
              ? 'chat.toolInteraction.declined'
              : done
                ? 'chat.toolInteraction.completed'
                : 'chat.toolInteraction.waiting',
          )}
        </Badge>
      </div>
      <ConfirmationTitle className="w-full whitespace-pre-wrap text-sm font-medium leading-6 text-foreground">
        {question?.question ??
          t(
            approval
              ? 'chat.toolInteraction.approvalPrompt'
              : 'chat.toolInteraction.resumePrompt',
            { tool: toolName ?? '' },
          )}
      </ConfirmationTitle>
      {!question && (
        <details
          open={approval}
          className="w-full min-w-0 text-xs text-muted-foreground"
        >
          <summary className="cursor-pointer py-1">
            {t('chat.toolInteraction.details')}
          </summary>
          <InteractionData
            value={
              interaction?.suspendPayload ?? interaction?.input ?? tool?.input
            }
          />
          {!approval && schema !== undefined && (
            <InteractionData value={schema} />
          )}
        </details>
      )}
      <ConfirmationRequest>
        <form
          className="w-full space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submitAnswer();
          }}
        >
          {!approval && (
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
                    const checked = selected.includes(option.label);
                    return (
                      <Button
                        key={`${index}:${option.label}`}
                        type="button"
                        variant="outline"
                        aria-pressed={checked}
                        disabled={unavailable}
                        className={cn(
                          'h-auto w-full justify-start gap-3 whitespace-normal px-3 py-3 text-left',
                          checked && 'border-primary bg-primary/5',
                        )}
                        onClick={() => {
                          setSelected((current) =>
                            multi
                              ? current.includes(option.label)
                                ? current.filter(
                                    (value) => value !== option.label,
                                  )
                                : [...current, option.label]
                              : [option.label],
                          );
                          if (!multi) setText('');
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
                      : !question && !plainText
                        ? 'chat.toolInteraction.resumeData'
                        : 'chat.toolInteraction.answer',
                  )}
                </Label>
                <Textarea
                  id={inputId}
                  value={text}
                  disabled={unavailable}
                  maxLength={60000}
                  className="min-h-20 resize-y"
                  placeholder={t(
                    question
                      ? 'chat.toolInteraction.placeholder'
                      : plainText
                        ? 'chat.toolInteraction.placeholder'
                        : 'chat.toolInteraction.jsonPlaceholder',
                  )}
                  onChange={(event) => {
                    setText(event.target.value);
                    if (!multi && event.target.value) setSelected([]);
                  }}
                />
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          )}
          <ConfirmationActions className="w-full flex-wrap">
            {approval ? (
              <>
                <ConfirmationAction
                  variant="outline"
                  disabled={unavailable}
                  onClick={() => void submit({ action: 'decline' })}
                >
                  <X />
                  {t('chat.toolInteraction.decline')}
                </ConfirmationAction>
                <ConfirmationAction
                  disabled={unavailable}
                  onClick={() => void submit({ action: 'approve' })}
                >
                  {pending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Check />
                  )}
                  {t('chat.toolInteraction.approve')}
                </ConfirmationAction>
              </>
            ) : (
              <ConfirmationAction
                type="submit"
                disabled={
                  unavailable ||
                  !(question ? answer.length : text.trim().length)
                }
              >
                {pending && <LoaderCircle className="animate-spin" />}
                {t(
                  pending
                    ? 'chat.toolInteraction.submitting'
                    : 'chat.toolInteraction.submit',
                )}
              </ConfirmationAction>
            )}
          </ConfirmationActions>
        </form>
      </ConfirmationRequest>
      <ConfirmationAccepted>
        <p className="flex items-start gap-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
          <Check className="mt-1 size-4 shrink-0" />
          {answerText || t('chat.toolInteraction.approved')}
        </p>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <X className="size-4 shrink-0" />
          {t('chat.toolInteraction.declined')}
        </p>
      </ConfirmationRejected>
      {!done && !interaction && (
        <p className="text-xs text-muted-foreground">
          {t(
            tool?.state === 'output-error'
              ? 'chat.toolInteraction.failed'
              : 'chat.toolInteraction.unavailable',
          )}
        </p>
      )}
    </Confirmation>
  );
}

function InteractionData({ value }: { value: unknown }) {
  if (value === undefined) return null;
  return (
    <ScrollArea
      className="my-2 min-w-0 rounded-lg bg-muted"
      viewportProps={{ className: 'max-h-52' }}
    >
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-5 text-foreground">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </ScrollArea>
  );
}
