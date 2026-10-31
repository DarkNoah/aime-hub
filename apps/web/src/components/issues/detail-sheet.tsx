import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRight,
  Check,
  Pencil,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Issue, IssueDetail } from '@aime/shared/issues';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MarkdownContent } from '@/components/markdown-content';
import { issueApi, issueChanged, issueErrorKey } from './api';
import { IssueThreadLink, IssueStateBadge } from './presentation';
import { IssueFormDialog } from './form-dialog';

export function IssueDetailSheet({
  issue: initial,
  onClose,
}: {
  issue: Issue;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const inputId = useId();
  const [issue, setIssue] = useState(initial);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<ReturnType<typeof issueErrorKey> | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'comment' | 'wait' | 'immediate'>('comment');
  const projectId = initial.projectId ?? undefined;
  useEffect(() => {
    const controller = new AbortController();
    void issueApi
      .view({ id: initial.id, projectId }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setDetail(result);
          setIssue(result.issue);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(issueErrorKey(cause));
      });
    return () => controller.abort();
  }, [initial.id, projectId, revision]);
  const act = async (action: () => Promise<Issue>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await action();
      setIssue(result);
      issueChanged();
      toast.success(t('issues.saved'));
      setRevision((value) => value + 1);
    } catch (cause) {
      toast.error(t(issueErrorKey(cause)));
    } finally {
      setBusy(false);
    }
  };
  const target = { id: issue.id, projectId };
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent
          className="w-full gap-0 sm:max-w-xl"
          closeLabel={t('nav.close')}
        >
          <SheetHeader className="shrink-0 gap-2 border-b p-5 pr-14">
            <div className="flex min-h-8 flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">
                #{issue.id}
              </span>
              <IssueStateBadge state={issue.state} />
            </div>
            <SheetTitle className="text-lg leading-6 break-words">
              {issue.title}
            </SheetTitle>
            <SheetDescription className="leading-5">
              {t('issues.detailHint')}
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-6 p-5">
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <IssueThreadLink issue={issue} onClick={onClose}>
                    {t(
                      issue.source
                        ? 'issues.openSourceThread'
                        : 'issues.openThread',
                    )}
                    <ArrowUpRight />
                  </IssueThreadLink>
                </Button>
                {issue.source && (
                  <Button asChild size="sm" variant="outline">
                    <IssueThreadLink issue={issue} task onClick={onClose}>
                      {t('issues.openTaskThread')}
                      <ArrowUpRight />
                    </IssueThreadLink>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEdit(true)}
                >
                  <Pencil />
                  {t('issues.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      issue.state === 'done'
                        ? issueApi.reopen(target)
                        : issueApi.close(target),
                    )
                  }
                >
                  {issue.state === 'done' ? <RotateCcw /> : <Check />}
                  {t(issue.state === 'done' ? 'issues.reopen' : 'issues.close')}
                </Button>
                {issue.state !== 'done' && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          issueApi.message({
                            ...target,
                            data: {
                              body: `${issue.title}\n\n${issue.body || t('issues.startPrompt')}`,
                              delivery: 'wait',
                            },
                          }),
                        )
                      }
                    >
                      <Play />
                      {t('issues.start')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => issueApi.stop(target))}
                    >
                      <Square />
                      {t('issues.stop')}
                    </Button>
                  </>
                )}
              </div>
              <div className="min-w-0 text-sm">
                <MarkdownContent mode="static">
                  {issue.body || t('issues.noBody')}
                </MarkdownContent>
              </div>
              <div className="border-t pt-5">
                <h3 className="mb-4 text-sm font-semibold">
                  {t('issues.discussion')}
                </h3>
                {error ? (
                  <div
                    role="alert"
                    className="space-y-2 text-sm text-destructive"
                  >
                    <p>{t(error)}</p>
                    <Button
                      variant="outline"
                      onClick={() => setRevision((value) => value + 1)}
                    >
                      {t('session.retry')}
                    </Button>
                  </div>
                ) : !detail ? (
                  <Skeleton className="h-20 w-full" />
                ) : (
                  <>
                    {detail.nextCursor && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void issueApi
                            .view({ ...target, cursor: detail.nextCursor! })
                            .then((page) =>
                              setDetail(
                                (previous) =>
                                  previous && {
                                    ...previous,
                                    comments: [
                                      ...page.comments,
                                      ...previous.comments,
                                    ],
                                    nextCursor: page.nextCursor,
                                  },
                              ),
                            )
                            .catch((cause) =>
                              toast.error(t(issueErrorKey(cause))),
                            )
                            .finally(() => setBusy(false));
                        }}
                      >
                        {t('issues.earlier')}
                      </Button>
                    )}
                    {!detail.comments.length && (
                      <p className="text-sm text-muted-foreground">
                        {t('issues.noComments')}
                      </p>
                    )}
                    <ol className="divide-y">
                      {detail.comments.map((comment) => (
                        <li key={comment.id} className="space-y-2 py-4">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {comment.authorName ?? t('issues.member')}
                            </span>
                            <time dateTime={comment.createdAt}>
                              {new Date(comment.createdAt).toLocaleString(
                                i18n.language,
                              )}
                            </time>
                            {comment.kind === 'message' && (
                              <Badge variant="secondary">
                                {t(
                                  comment.delivery === 'immediate'
                                    ? 'issues.immediate'
                                    : 'issues.wait',
                                )}
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm">
                            <MarkdownContent mode="static">
                              {comment.body}
                            </MarkdownContent>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
              <form
                className="space-y-3 border-t pt-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || !text.trim()) return;
                  setBusy(true);
                  void (
                    mode === 'comment'
                      ? issueApi.comment({ ...target, data: { body: text } })
                      : issueApi.message({
                          ...target,
                          data: { body: text, delivery: mode },
                        })
                  )
                    .then(() => {
                      setText('');
                      issueChanged();
                      setRevision((value) => value + 1);
                      toast.success(t('issues.sent'));
                    })
                    .catch((cause) => toast.error(t(issueErrorKey(cause))))
                    .finally(() => setBusy(false));
                }}
              >
                <Label htmlFor={inputId}>{t('issues.addMessage')}</Label>
                <Textarea
                  id={inputId}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={4}
                  maxLength={50000}
                  disabled={busy}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Select
                    value={mode}
                    onValueChange={(value) => setMode(value as typeof mode)}
                    disabled={busy}
                  >
                    <SelectTrigger aria-label={t('issues.delivery')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="comment">
                        {t('issues.commentOnly')}
                      </SelectItem>
                      <SelectItem
                        value="wait"
                        disabled={issue.state === 'done'}
                      >
                        {t('issues.wait')}
                      </SelectItem>
                      <SelectItem
                        value="immediate"
                        disabled={issue.state === 'done'}
                      >
                        {t('issues.immediate')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="submit"
                    disabled={
                      busy ||
                      !text.trim() ||
                      (mode !== 'comment' && issue.state === 'done')
                    }
                  >
                    {t('issues.send')}
                  </Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('issues.deliveryHint')}
                </p>
              </form>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      {edit && (
        <IssueFormDialog
          issue={issue}
          projectId={projectId}
          onClose={() => setEdit(false)}
          onSaved={setIssue}
        />
      )}
    </>
  );
}
