import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { truncateJsonBody } from '@aime/shared/log-json';
import type {
  CapturedChatRequest,
  CapturedChatResponse,
  RequestLogContext,
} from '@aime/shared/request-logs';
import {
  Agent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type DiagnosticsChannel,
} from 'undici';
import { decodeResponseBody } from './response-body.js';

type Request = DiagnosticsChannel.RequestBodySentMessage['request'];
type CapturedRequest = {
  id: string;
  url: string;
  chunks: Buffer[];
  context: RequestLogContext;
  createdAt: string;
  startedAt: number;
  requestLogged: boolean;
  httpStatus: number | null;
  responseContentType: string | null;
  responseContentEncoding: string | null;
  responseChunks: Buffer[];
};

/** Undici 7 exposes outgoing headers as alternating name/value entries. */
function requestContext(headers: unknown): RequestLogContext {
  const context: RequestLogContext = {
    threadId: null,
    resourceId: null,
    userId: null,
    projectId: null,
  };
  if (!Array.isArray(headers)) return context;
  for (let index = 0; index < headers.length; index += 2) {
    const name: unknown = headers[index];
    const value: unknown = headers[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    // Only these four context headers are retained, never credentials/cookies.
    const id = value.trim() || null;
    switch (name.toLowerCase()) {
      case 'x-thread-id':
        context.threadId = id;
        break;
      case 'x-resource-id':
        context.resourceId = id;
        break;
      case 'x-user-id':
        context.userId = id;
        break;
      case 'x-project-id':
        context.projectId = id;
        break;
    }
  }
  return context;
}

function isModelRequest(method: string | undefined, path: string) {
  return (
    method === 'POST' &&
    /\/(?:chat\/completions|responses)\/?$/.test(path.split('?')[0])
  );
}

let uninstall: (() => Promise<void>) | undefined;

/** Observe transport bytes without reading or replacing the caller's streams. */
export function installChatRequestLogging(
  log: (message: string) => void = (message) => console.info(message),
  onRequest?: (request: CapturedChatRequest) => void,
  onResponse?: (response: CapturedChatResponse) => void,
  isEnabled: () => boolean = () => true,
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
  const pendingResponses = new Set<Promise<void>>();

  // Diagnostics subscribers must never throw into the networking stack.
  const observe =
    <T>(callback: (message: T) => void) =>
    (message: unknown) => {
      try {
        callback(message as T);
      } catch {
        /* Logging must not interrupt chat. */
      }
    };
  const onCreate = observe<DiagnosticsChannel.RequestCreateMessage>(
    ({ request }) => {
      // Decide once per request: disabled requests never buffer bodies, while
      // already captured requests finish together with their responses.
      if (!isModelRequest(request.method, request.path) || !isEnabled()) return;
      const url = new URL(request.path, request.origin);
      requests.set(request, {
        id: randomUUID(),
        // Keep credentials and query parameters out of log metadata.
        url: `${url.origin}${url.pathname}`,
        chunks: [],
        context: requestContext(request.headers),
        createdAt: new Date().toISOString(),
        startedAt: performance.now(),
        requestLogged: false,
        httpStatus: null,
        responseContentType: null,
        responseContentEncoding: null,
        responseChunks: [],
      });
    },
  );
  const onChunk = observe<DiagnosticsChannel.RequestBodyChunkSentMessage>(
    ({ request, chunk }) => {
      requests.get(request)?.chunks.push(Buffer.from(chunk));
    },
  );

  const writeRequest = (
    request: Request,
    captured: CapturedRequest,
    complete: boolean,
  ) => {
    if (captured.requestLogged) return;
    captured.requestLogged = true;
    const body = Buffer.concat(captured.chunks).toString('utf8');
    captured.chunks = [];
    try {
      onRequest?.({
        ...captured.context,
        id: captured.id,
        createdAt: captured.createdAt,
        method: request.method ?? 'POST',
        url: captured.url,
        body,
        complete,
      });
    } catch {
      // A persistence failure must not affect the request or console log.
    }
    try {
      // One string keeps concurrent requests separate and avoids console object
      // inspection truncating long prompts, tool schemas or message history.
      log(
        `[chat:request] id=${captured.id} ${request.method} ${captured.url} body=${complete ? 'complete' : 'incomplete'}\n${truncateJsonBody(body)}`,
      );
    } catch {
      // An unavailable log sink must not fail the model request.
    }
  };
  const onSent = observe<DiagnosticsChannel.RequestBodySentMessage>(
    ({ request }) => {
      const captured = requests.get(request);
      if (captured) writeRequest(request, captured, true);
    },
  );
  const onHeaders = observe<DiagnosticsChannel.RequestHeadersMessage>(
    ({ request, response }) => {
      const captured = requests.get(request);
      if (!captured || response.statusCode < 200) return;
      captured.httpStatus = response.statusCode;
      for (let index = 0; index < response.headers.length; index += 2) {
        const name = response.headers[index].toString().toLowerCase();
        if (name === 'content-type')
          captured.responseContentType = response.headers[index + 1].toString();
        if (name === 'content-encoding')
          captured.responseContentEncoding =
            response.headers[index + 1].toString();
      }
    },
  );
  const onResponseChunk =
    observe<DiagnosticsChannel.RequestBodyChunkReceivedMessage>(
      ({ request, chunk }) => {
        if (onResponse)
          requests.get(request)?.responseChunks.push(Buffer.from(chunk));
      },
    );
  const finish = (request: Request, complete: boolean) => {
    const captured = requests.get(request);
    if (!captured) return;
    requests.delete(request);
    const durationMs = Math.max(
      0,
      Math.round(performance.now() - captured.startedAt),
    );
    // Connection failures and rejected uploads can precede bodySent entirely.
    writeRequest(request, captured, false);
    if (!onResponse) return;
    const bytes = Buffer.concat(captured.responseChunks);
    captured.responseChunks = [];
    const pending = (async () => {
      const decoded =
        captured.httpStatus === null
          ? { responseBody: null, responseBodyEncoding: null }
          : await decodeResponseBody(
              bytes,
              captured.responseContentEncoding,
              complete,
            );
      onResponse({
        id: captured.id,
        durationMs,
        httpStatus: captured.httpStatus,
        responseStatus: complete ? 'complete' : 'incomplete',
        responseContentType: captured.responseContentType,
        responseContentEncoding: captured.responseContentEncoding,
        responseBytes: bytes.length,
        ...decoded,
      });
    })()
      .catch(() => {
        // A response log sink must not affect delivery to the caller.
      })
      .finally(() => pendingResponses.delete(pending));
    pendingResponses.add(pending);
  };
  const onEnd = observe<DiagnosticsChannel.RequestTrailersMessage>(
    ({ request }) => finish(request, true),
  );
  const onError = observe<DiagnosticsChannel.RequestErrorMessage>(
    ({ request }) => finish(request, false),
  );

  subscribe('undici:request:create', onCreate);
  subscribe('undici:request:bodyChunkSent', onChunk);
  subscribe('undici:request:bodySent', onSent);
  subscribe('undici:request:headers', onHeaders);
  subscribe('undici:request:bodyChunkReceived', onResponseChunk);
  subscribe('undici:request:trailers', onEnd);
  subscribe('undici:request:error', onError);
  setGlobalDispatcher(dispatcher);

  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      if (getGlobalDispatcher() === dispatcher)
        setGlobalDispatcher(previousDispatcher);
      try {
        // Keep subscriptions alive until in-flight responses have been captured.
        await modelDispatcher.close();
        await Promise.all(pendingResponses);
      } finally {
        unsubscribe('undici:request:create', onCreate);
        unsubscribe('undici:request:bodyChunkSent', onChunk);
        unsubscribe('undici:request:bodySent', onSent);
        unsubscribe('undici:request:headers', onHeaders);
        unsubscribe('undici:request:bodyChunkReceived', onResponseChunk);
        unsubscribe('undici:request:trailers', onEnd);
        unsubscribe('undici:request:error', onError);
        uninstall = undefined;
      }
    })());
  uninstall = dispose;
  return dispose;
}
