import { useEffect, useState } from 'react';
import { issueApi, issueChanged } from '@/components/issues/api';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { issueStateSchema } from '@aime/shared/issues';
import {
  IssueStateBadge,
  IssueThreadLink,
} from '@/components/issues/presentation';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ToolInteractionProps } from '../chat-tool-interaction';

const summary = z.object({
  id: z.number(),
  title: z.string(),
  threadId: z.string(),
  source: z
    .object({ roomId: z.string(), agentId: z.string(), threadId: z.string() })
    .nullish(),
  projectId: z.string().nullable(),
  state: issueStateSchema,
});
const outputSchema = z.object({
  issue: summary.optional(),
  items: z.array(summary).optional(),
  error: z.string().optional(),
  help: z.string().optional(),
  comment: z.object({ body: z.string() }).optional(),
});

function IssueResultLink({ issue }: { issue: z.infer<typeof summary> }) {
  const [source, setSource] = useState<z.infer<typeof summary>['source']>();
  useEffect(() => {
    if (issue.source !== undefined) return;
    const controller = new AbortController();
    // Stored results predate source tracking. Resolve their current association
    // through the authenticated API without rewriting conversation history.
    void issueApi
      .view(
        { id: issue.id, projectId: issue.projectId ?? undefined },
        { signal: controller.signal },
      )
      .then(({ issue }) => {
        if (!controller.signal.aborted) setSource(issue.source);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [issue.id, issue.projectId, issue.source]);
  return (
    <IssueThreadLink
      issue={{
        ...issue,
        source: issue.source === undefined ? source : issue.source,
      }}
      className="flex items-center justify-between gap-3 px-3 py-3 hover:bg-accent"
    >
      <span className="min-w-0 break-words">
        #{issue.id} {issue.title}
      </span>
      <IssueStateBadge state={issue.state} />
    </IssueThreadLink>
  );
}

export function IssueToolResult({ tool }: ToolInteractionProps) {
  const { t } = useTranslation();
  useEffect(() => {
    if (tool?.state === 'output-available') issueChanged();
  }, [tool?.state, tool?.toolCallId]);
  const output =
    tool?.state === 'output-available'
      ? outputSchema.safeParse(tool.output).data
      : undefined;
  const items = output?.issue ? [output.issue] : (output?.items ?? []);
  const command = z.object({ command: z.string() }).safeParse(tool?.input)
    .data?.command;
  const failed = tool?.state === 'output-error';
  return (
    <div className="my-3 min-w-0 rounded-lg border text-sm">
      <div className="border-b bg-muted/30 px-3 py-2 font-mono text-xs break-words">
        {command ?? 'issue'}
      </div>
      <ScrollArea
        className="max-h-80"
        viewportProps={{ className: 'max-h-80' }}
      >
        <div className="divide-y">
          {items.map((issue) => (
            <IssueResultLink key={issue.id} issue={issue} />
          ))}
        </div>
        {!items.length && (
          <p
            role={failed || output?.error ? 'alert' : 'status'}
            className="p-3 whitespace-pre-wrap break-words text-muted-foreground"
          >
            {output?.error ??
              output?.help ??
              output?.comment?.body ??
              (typeof tool?.output === 'string'
                ? tool.output
                : t(
                    failed
                      ? 'issues.error'
                      : tool?.state === 'output-available'
                        ? 'issues.noResults'
                        : 'chat.loading',
                  ))}
          </p>
        )}
        {items.length > 0 && output?.error && (
          <p role="alert" className="p-3 text-destructive">
            {output.error}
          </p>
        )}
      </ScrollArea>
    </div>
  );
}
