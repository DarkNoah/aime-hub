import { useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { CircleHelp, LoaderCircle, ScanText } from 'lucide-react';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import { getToolDisplayState } from '@aime/shared/tool-status';
import {
  userQuestionSchema,
  type AskUserAnswer,
  type ToolInteraction,
  type ToolResponse,
} from '@aime/shared/threads';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { chatErrorKey } from './api';
import { ChatQuestionFields } from './chat-question-fields';
import {
  ChatQuestionDrafts,
  emptyQuestionDraft,
  formatQuestionAnswer,
  questionAnswer,
  type QuestionDraft,
} from './question-answer';

type Tool = ToolUIPart | DynamicToolUIPart;

export function ChatQuestionGroup({
  tools,
  interactions,
  disabled,
  onSubmit,
  onPreview,
}: {
  tools: readonly Tool[];
  interactions: readonly ToolInteraction[];
  disabled?: boolean;
  onSubmit?: (interactionId: string, answers: AskUserAnswer[]) => Promise<void>;
  onPreview?: (tool: Tool) => void;
}) {
  const { t } = useTranslation();
  const draftCache = useContext(ChatQuestionDrafts);
  const [drafts, setDrafts] = useState(() => new Map(draftCache));
  const [submitted, setSubmitted] = useState<{
    anchorId: string;
    responses: Map<string, ToolResponse>;
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReturnType<typeof chatErrorKey>>();
  const sending = useRef(false);
  const requests = useRef(new Map<string, { signature: string; id: string }>());
  const byCall = new Map(interactions.map((item) => [item.toolCallId, item]));
  const anchor = tools
    .filter((tool) => !tool.state.startsWith('output-'))
    .map((tool) => byCall.get(tool.toolCallId))
    .find(
      (item) =>
        item?.kind === 'suspended' &&
        item.toolName === 'ask_user' &&
        !item.response,
    );
  // Cover the gap between the acknowledgement and the next snapshot. A new
  // suspension or a terminal snapshot is authoritative for the remaining calls.
  const acknowledged =
    onSubmit && anchor && anchor.id === submitted?.anchorId
      ? submitted?.responses
      : undefined;
  const items = tools.map((tool, index) => {
    const id = tool.toolCallId;
    const interaction = byCall.get(id);
    const response =
      interaction?.response ??
      (tool.state.startsWith('output-') ? undefined : acknowledged?.get(id));
    const question = userQuestionSchema.safeParse(
      interaction?.suspendPayload ?? tool.input,
    ).data;
    const draft = (onSubmit && drafts.get(id)) || emptyQuestionDraft;
    // Free-text answers can themselves contain JSON. Only a structured native
    // result can report an error inside its payload.
    const failed =
      getToolDisplayState(
        tool.state,
        typeof tool.output === 'object' ? tool.output : undefined,
      ) === 'output-error';
    const declined =
      response?.action === 'decline' || tool.state === 'output-denied';
    const done =
      failed || declined || !!response || tool.state === 'output-available';
    const answer = questionAnswer(question, draft);
    const editable = !!question && tool.state !== 'input-streaming' && !done;
    const ready = done || (editable && (!!draft.skipped || answer.length > 0));
    return {
      id,
      tool,
      question,
      label:
        question?.question ??
        t('chat.questions.questionNumber', { number: index + 1 }),
      draft,
      failed,
      declined,
      done,
      editable,
      ready,
      answer,
      output: response?.action === 'resume' ? response.data : tool.output,
    };
  });
  const unanswered = items.filter((item) => !item.done);
  if (!items.length) return null;
  const readyCount = items.filter((item) => item.ready).length;
  const finishedWithError =
    !unanswered.length && items.some((item) => item.failed);
  const canSubmit =
    !!onSubmit &&
    !!anchor &&
    unanswered.length > 0 &&
    !disabled &&
    !submitting &&
    readyCount === items.length;
  const fieldsDisabled = !onSubmit || !!disabled || submitting;

  function changeDraft(id: string, draft: QuestionDraft) {
    draftCache?.set(id, draft);
    setDrafts((current) => new Map(current).set(id, draft));
    setError(undefined);
  }

  async function submit() {
    if (!canSubmit || !onSubmit || !anchor || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setError(undefined);
    const answers: AskUserAnswer[] = unanswered.map(
      ({ id: toolCallId, draft, answer }) => {
        const action = draft.skipped
          ? { action: 'decline' as const }
          : { action: 'resume' as const, data: answer };
        const signature = JSON.stringify(action);
        let request = requests.current.get(toolCallId);
        if (request?.signature !== signature) {
          request = { signature, id: nanoid() };
          requests.current.set(toolCallId, request);
        }
        return { toolCallId, response: { ...action, id: request.id } };
      },
    );
    try {
      await onSubmit(anchor.id, answers);
      setSubmitted({
        anchorId: anchor.id,
        responses: new Map(
          answers.map(({ toolCallId, response }) => [toolCallId, response]),
        ),
      });
      requests.current.clear();
      toast.success(t('chat.toolInteraction.sent'));
    } catch (cause) {
      const key = chatErrorKey(cause);
      setError(key);
      toast.error(t(key));
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Card
      role="group"
      aria-label={t('chat.questions.title')}
      className="my-3 min-w-0 gap-4 p-4 text-sm leading-normal sm:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <CircleHelp
            aria-hidden="true"
            className="size-4 shrink-0 text-primary"
          />
          {t('chat.questions.title')}
        </span>
        <Badge
          variant={finishedWithError ? 'destructive' : 'secondary'}
          role="status"
          className="shrink-0 tabular-nums"
        >
          {finishedWithError
            ? t('chat.toolFailed')
            : t(
                unanswered.length
                  ? 'chat.questions.ready'
                  : 'chat.questions.done',
                {
                  count: readyCount,
                  total: items.length,
                },
              )}
        </Badge>
      </div>
      <div className="min-w-0 divide-y divide-border">
        {items.map((item) => (
          <div
            key={item.id}
            role="group"
            aria-label={item.label}
            className="min-w-0 space-y-2.5 py-4 first:pt-0 last:pb-0"
          >
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium leading-6">
                {item.label}
              </p>
              {onSubmit && item.editable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-muted-foreground"
                  disabled={fieldsDisabled}
                  onClick={() =>
                    changeDraft(item.id, {
                      ...item.draft,
                      skipped: !item.draft.skipped,
                    })
                  }
                >
                  {t(
                    item.draft.skipped
                      ? 'chat.questions.restore'
                      : 'chat.questions.skip',
                  )}
                </Button>
              )}
              {onPreview && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0 text-muted-foreground"
                  title={t('chat.preview.open')}
                  aria-label={t('chat.preview.open')}
                  onClick={() => onPreview(item.tool)}
                >
                  <ScanText aria-hidden="true" />
                </Button>
              )}
            </div>
            {item.failed ? (
              <p className="whitespace-pre-wrap break-words text-destructive">
                {item.tool.errorText || t('chat.toolInteraction.failed')}
              </p>
            ) : item.declined || (!item.done && item.draft.skipped) ? (
              <Badge variant="outline">{t('chat.questions.skipped')}</Badge>
            ) : item.done ? (
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                {formatQuestionAnswer(item.output)}
              </p>
            ) : item.editable ? (
              <ChatQuestionFields
                question={item.question}
                draft={item.draft}
                disabled={fieldsDisabled}
                onChange={(draft) => changeDraft(item.id, draft)}
              />
            ) : (
              <p className="text-muted-foreground">
                {t('chat.toolInteraction.unavailable')}
              </p>
            )}
          </div>
        ))}
      </div>
      {onSubmit && !!unanswered.length && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-3">
          {error && (
            <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
              {t(error)}
            </p>
          )}
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {submitting && (
              <LoaderCircle
                aria-hidden="true"
                className="motion-safe:animate-spin"
              />
            )}
            {t(
              submitting
                ? 'chat.toolInteraction.submitting'
                : 'chat.questions.submit',
            )}
          </Button>
        </div>
      )}
    </Card>
  );
}
