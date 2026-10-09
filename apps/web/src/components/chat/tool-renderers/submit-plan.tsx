import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRight,
  Check,
  ClipboardList,
  FileText,
  LoaderCircle,
  X,
} from 'lucide-react';
import {
  Plan,
  PlanContent,
  PlanHeader,
  PlanTitle,
} from '@/components/ai-elements/plan';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspaceFile } from '@/components/file-manager/context';
import type { ToolInteractionProps } from '../chat-tool-interaction';
import {
  createSubmitPlanResponse,
  getSubmitPlanData,
} from './submit-plan-data';
import { useToolResponse } from './use-tool-response';

export function SubmitPlan(props: ToolInteractionProps) {
  const { interaction, tool } = props;
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
  const feedbackId = useId();
  const [feedback, setFeedback] = useState('');
  const { response, pending, unavailable, error, submit } =
    useToolResponse(props);
  const plan = getSubmitPlanData(interaction, tool, response);
  const done =
    !!response ||
    !!plan.decision ||
    tool?.state === 'output-available' ||
    plan.failed;
  const streaming = tool?.state === 'input-streaming';
  const disabled = unavailable || done || streaming;
  const status =
    plan.decision === 'rejected'
      ? 'chat.submitPlan.rejected'
      : plan.decision === 'approved'
        ? 'chat.submitPlan.approved'
        : plan.failed
          ? 'chat.submitPlan.failed'
          : streaming
            ? 'chat.submitPlan.preparing'
            : done
              ? 'chat.submitPlan.submitted'
              : 'chat.toolInteraction.waiting';

  return (
    <Plan
      open
      className="my-3 min-w-0 gap-4 rounded-xl py-4 leading-normal sm:py-5"
      role="group"
      aria-label={t('chat.submitPlan.title')}
    >
      <PlanHeader className="gap-3 px-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-2">
          <ClipboardList
            className="mt-0.5 size-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <PlanTitle className="min-w-0 text-sm leading-5">
            {plan.title ?? t('chat.submitPlan.title')}
          </PlanTitle>
        </div>
        <Badge
          variant={
            plan.failed
              ? 'destructive'
              : plan.decision === 'rejected'
                ? 'outline'
                : 'secondary'
          }
          className="shrink-0"
          role="status"
        >
          {t(status)}
        </Badge>
      </PlanHeader>
      <PlanContent className="min-w-0 space-y-4 px-4 sm:px-5">
        {plan.path ? (
          <Button
            variant="outline"
            className="h-auto w-full min-w-0 justify-start gap-2 py-2.5 text-left"
            title={t('chat.submitPlan.openFile', { path: plan.path })}
            aria-label={t('chat.submitPlan.openFile', { path: plan.path })}
            disabled={!openFile || streaming}
            onClick={() => openFile?.(plan.path!)}
          >
            <FileText
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 whitespace-normal break-all font-mono text-xs leading-5">
              {plan.path}
            </span>
            <ArrowUpRight
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('chat.submitPlan.missingPath')}
          </p>
        )}
        {!done && (
          <>
            <p className="text-xs leading-5 text-muted-foreground">
              {t('chat.submitPlan.hint')}
            </p>
            <div className="space-y-2">
              <Label htmlFor={feedbackId}>
                {t('chat.submitPlan.feedback')}
              </Label>
              <Textarea
                id={feedbackId}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                disabled={disabled}
                maxLength={2000}
                placeholder={t('chat.submitPlan.feedbackPlaceholder')}
                className="min-h-20 resize-y"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {t(error)}
              </p>
            )}
            <div
              className="flex flex-wrap justify-end gap-2"
              aria-busy={pending}
            >
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  void submit(
                    createSubmitPlanResponse('rejected', plan.path, feedback),
                  )
                }
              >
                <X aria-hidden="true" />
                {t('chat.submitPlan.reject')}
              </Button>
              <Button
                size="sm"
                disabled={disabled || !plan.path}
                onClick={() =>
                  void submit(
                    createSubmitPlanResponse('approved', plan.path, feedback),
                  )
                }
              >
                {pending ? (
                  <LoaderCircle
                    className="motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Check aria-hidden="true" />
                )}
                {t(
                  pending
                    ? 'chat.toolInteraction.submitting'
                    : 'chat.submitPlan.approve',
                )}
              </Button>
            </div>
            {!interaction && !streaming && (
              <p className="text-xs text-muted-foreground">
                {t('chat.toolInteraction.unavailable')}
              </p>
            )}
          </>
        )}
        {plan.feedback && (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
            {plan.feedback}
          </p>
        )}
        {plan.failed && (
          <p role="alert" className="text-sm text-destructive">
            {tool?.errorText ?? t('chat.toolInteraction.failed')}
          </p>
        )}
      </PlanContent>
    </Plan>
  );
}
