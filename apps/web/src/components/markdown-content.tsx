import { lazy, Suspense } from 'react';
import type { MessageResponseProps } from './ai-elements/message';

const Response = lazy(() =>
  import('./ai-elements/message').then((module) => ({
    default: module.MessageResponse,
  })),
);

/** Keep the host Markdown renderer out of plugins that only use basic controls. */
export function MarkdownContent(props: MessageResponseProps) {
  return (
    <Suspense
      fallback={
        <div className="whitespace-pre-wrap text-sm leading-7">
          {props.children}
        </div>
      }
    >
      <Response {...props} />
    </Suspense>
  );
}
