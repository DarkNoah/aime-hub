import { useContext, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleHelp, LoaderCircle, ShieldCheck, X } from 'lucide-react';
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
import { ChatQuestionFields } from './chat-question-fields';
import {
  ChatQuestionDrafts,
  emptyQuestionDraft,
  formatQuestionAnswer,
  questionAnswer,
} from './question-answer';
import { useToolResponse } from './tool-renderers/use-tool-response';
import { getToolName } from './tool-renderers/registry';

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
  const draftCache = useContext(ChatQuestionDrafts);
  const toolName = interaction?.toolName ?? getToolName(tool);
  const draftId =
    toolName === 'ask_user'
      ? (interaction?.toolCallId ?? tool?.toolCallId)
      : undefined;
  const [draft, setDraft] = useState(
    () => (draftId && draftCache?.get(draftId)) || emptyQuestionDraft,
  );
  const { response, pending, error, setError, submit } = useToolResponse({
    interaction,
    disabled:
      disabled ||
      tool?.state === 'output-available' ||
      tool?.state === 'output-denied',
    onRespond,
  });
  const question =
    toolName === 'ask_user'
      ? userQuestionSchema.safeParse(interaction?.suspendPayload ?? tool?.input)
          .data
      : undefined;
  const approval = interaction?.kind === 'approval';
  const hasOutput = tool?.state === 'output-available';
  const rejected =
    response?.action === 'decline' || tool?.state === 'output-denied';
  const done = !!response || hasOutput || rejected;
  const actionable = !!interaction && !done && !!onRespond;
  const unavailable = disabled || pending || !actionable;
  const answer = questionAnswer(question, draft);
  const answered =
    response?.action === 'resume'
      ? response.data
      : hasOutput
        ? tool.output
        : undefined;
  const answerText = formatQuestionAnswer(answered);
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

  function submitAnswer() {
    try {
      void submit({
        action: 'resume',
        data: question
          ? answer
          : plainText
            ? draft.text
            : JSON.parse(draft.text),
      });
    } catch {
      setError('chat.toolInteraction.invalidJson');
    }
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
            <ChatQuestionFields
              question={question}
              json={!question && !plainText}
              draft={draft}
              disabled={!!unavailable}
              onChange={(next) => {
                if (draftId) draftCache?.set(draftId, next);
                setDraft(next);
              }}
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          )}
          <ConfirmationActions className="w-full flex-wrap">
            {(approval || question) && (
              <ConfirmationAction
                variant="outline"
                disabled={unavailable}
                onClick={() => void submit({ action: 'decline' })}
              >
                <X />
                {t('chat.toolInteraction.decline')}
              </ConfirmationAction>
            )}
            {approval ? (
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
            ) : (
              <ConfirmationAction
                type="submit"
                disabled={
                  unavailable ||
                  !(question ? answer.length : draft.text.trim().length)
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
