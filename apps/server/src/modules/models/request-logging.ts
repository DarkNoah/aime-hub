import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { CapturedChatRequest } from '@aime/shared/request-logs';
import {
  Agent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type DiagnosticsChannel,
} from 'undici';

type Request = DiagnosticsChannel.RequestBodySentMessage['request'];
type CapturedRequest = { id: string; url: string; chunks: Buffer[] };

function isModelRequest(method: string | undefined, path: string) {
  return (
    method === 'POST' &&
    /\/(?:chat\/completions|responses)\/?$/.test(path.split('?')[0])
  );
}

let uninstall: (() => Promise<void>) | undefined;

/** Observe bytes sent by Undici without reading or replacing the request body. */
export function installChatRequestLogging(
  log: (message: string) => void = (message) => console.info(message),
  onRequest?: (request: CapturedChatRequest) => void,
) {
  if (uninstall) return uninstall;

  const previousDispatcher = getGlobalDispatcher();
  // Node 22's bundled Undici 6 has no bodyChunkSent channel. Route model
  // requests through Undici 7, leaving other requests on their dispatcher.
  const modelDispatcher = new Agent();
  const dispatcher = previousDispatcher.compose(
    (dispatch) => (options, handler) =>
      isModelRequest(options.method, options.path)
        ? modelDispatcher.dispatch(options, handler)
        : dispatch(options, handler),
  );
  const requests = new WeakMap<Request, CapturedRequest>();

  const onChunk = (message: unknown) => {
    // Diagnostics subscribers must never throw into the networking stack.
    try {
      const { request, chunk } =
        message as DiagnosticsChannel.RequestBodyChunkSentMessage;
      if (!isModelRequest(request.method, request.path)) return;
      let captured = requests.get(request);
      if (!captured) {
        const url = new URL(request.path, request.origin);
        captured = {
          id: randomUUID(),
          // Keep credentials, query parameters and headers out of log metadata.
          url: `${url.origin}${url.pathname}`,
          chunks: [],
        };
        requests.set(request, captured);
      }
      captured.chunks.push(Buffer.from(chunk));
    } catch {
      // Logging must not interrupt chat.
    }
  };

  const flush = (message: unknown, complete: boolean) => {
    try {
      const { request } = message as DiagnosticsChannel.RequestBodySentMessage;
      const captured = requests.get(request);
      if (!captured) return;
      requests.delete(request);
      const body = Buffer.concat(captured.chunks).toString('utf8');
      try {
        onRequest?.({
          id: captured.id,
          createdAt: new Date().toISOString(),
          method: request.method ?? 'POST',
          url: captured.url,
          body,
          complete,
        });
      } catch {
        // A persistence failure must not affect the request or console log.
      }
      // One string keeps concurrent requests separate and avoids console object
      // inspection truncating long prompts, tool schemas or message history.
      log(
        `[chat:request] id=${captured.id} ${request.method} ${captured.url} body=${complete ? 'complete' : 'incomplete'}\n${body}`,
      );
    } catch {
      // An unavailable log sink must not fail the model request.
    }
  };
  const onSent = (message: unknown) => flush(message, true);
  const onError = (message: unknown) => flush(message, false);

  subscribe('undici:request:bodyChunkSent', onChunk);
  subscribe('undici:request:bodySent', onSent);
  subscribe('undici:request:error', onError);
  setGlobalDispatcher(dispatcher);

  const dispose = async () => {
    if (uninstall !== dispose) return;
    uninstall = undefined;
    unsubscribe('undici:request:bodyChunkSent', onChunk);
    unsubscribe('undici:request:bodySent', onSent);
    unsubscribe('undici:request:error', onError);
    if (getGlobalDispatcher() === dispatcher)
      setGlobalDispatcher(previousDispatcher);
    await modelDispatcher.close();
  };
  uninstall = dispose;
  return dispose;
}
