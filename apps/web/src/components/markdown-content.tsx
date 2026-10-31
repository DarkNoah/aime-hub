import { lazy, Suspense, type ReactNode } from 'react';
import type { MessageResponseProps } from './ai-elements/message';

const Response = lazy(() =>
  import('./ai-elements/message').then((module) => ({
    default: module.MessageResponse,
  })),
);

/** Keep the host Markdown renderer out of plugins that only use basic controls. */
export function MarkdownContent({
  fallback,
  ...props
}: MessageResponseProps & { fallback?: ReactNode }) {
  return (
    <Suspense
      fallback={
        fallback === undefined ? (
          <div className="whitespace-pre-wrap text-sm leading-7">
            {props.children}
          </div>
        ) : (
          fallback
        )
      }
    >
      <Response {...props} />
    </Suspense>
  );
}
