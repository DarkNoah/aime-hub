'use client';

import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { isValidElement } from 'react';
import { useTranslation } from 'react-i18next';

import { CodeBlock } from './code-block';

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      'group not-prose mb-4 w-full min-w-0 rounded-md border',
      className,
    )}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart['type']; state: ToolUIPart['state']; toolName?: never }
  | {
      type: DynamicToolUIPart['type'];
      state: DynamicToolUIPart['state'];
      toolName: string;
    }
);

const statusLabels = {
  'approval-requested': 'chat.toolAwaitingApproval',
  'approval-responded': 'chat.toolApprovalResponded',
  'input-available': 'chat.toolRunning',
  'input-streaming': 'chat.toolPending',
  'output-available': 'chat.toolDone',
  'output-denied': 'chat.toolDenied',
  'output-error': 'chat.toolFailed',
} as const satisfies Record<ToolPart['state'], string>;

const statusIcons: Record<ToolPart['state'], ReactNode> = {
  'approval-requested': <ClockIcon className="size-4 text-yellow-600" />,
  'approval-responded': <CheckCircleIcon className="size-4 text-blue-600" />,
  'input-available': <ClockIcon className="size-4 animate-pulse" />,
  'input-streaming': <CircleIcon className="size-4" />,
  'output-available': <CheckCircleIcon className="size-4 text-green-600" />,
  'output-denied': <XCircleIcon className="size-4 text-orange-600" />,
  'output-error': <XCircleIcon className="size-4 text-red-600" />,
};

const ToolStatusBadge = ({ status }: { status: ToolPart['state'] }) => {
  const { t } = useTranslation();
  return (
    <Badge
      className="shrink-0 gap-1.5 rounded-full text-xs"
      variant="secondary"
    >
      {statusIcons[status]}
      {t(statusLabels[status])}
    </Badge>
  );
};

export const getStatusBadge = (status: ToolPart['state']) => (
  <ToolStatusBadge status={status} />
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-');

  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full items-center justify-between gap-4 p-3',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-sm">
          {title ?? derivedName}
        </span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolPart['input'];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const { t } = useTranslation();
  return (
    <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t('chat.toolParameters')}
      </h4>
      <div className="max-h-56 overflow-auto rounded-md bg-muted/50">
        <CodeBlock
          code={JSON.stringify(input, null, 2) ?? ''}
          language="json"
        />
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolPart['output'];
  errorText: ToolPart['errorText'];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  const { t } = useTranslation();
  if (output === undefined && !errorText) {
    return null;
  }

  let Output = isValidElement(output) ? output : null;

  if (output !== undefined && !isValidElement(output)) {
    Output = (
      <CodeBlock
        code={
          typeof output === 'string' ? output : JSON.stringify(output, null, 2)
        }
        language="json"
      />
    );
  }

  return (
    <div className={cn('space-y-2', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t(errorText ? 'chat.toolError' : 'chat.toolResult')}
      </h4>
      <div
        className={cn(
          'max-h-56 overflow-auto rounded-md text-xs [&_table]:w-full',
          errorText
            ? 'bg-destructive/10 text-destructive'
            : 'bg-muted/50 text-foreground',
        )}
      >
        {errorText && (
          <div className="whitespace-pre-wrap p-3">{errorText}</div>
        )}
        {Output}
      </div>
    </div>
  );
};
