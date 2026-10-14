import type {
  AgentSignalDataPart,
  AgentThreadSubscription,
} from '@mastra/core/agent';
import type {
  ChunkType,
  MastraModelOutput,
  ThreadHistoryChunk,
} from '@mastra/core/stream';
import { toAISdkStream } from '@mastra/ai-sdk';
import { readUIMessageStream, type UIMessage } from 'ai';
import { nanoid } from 'nanoid';
import {
  toolInteractionSchema,
  type ChatSettings,
  type ThreadStreamStatus,
} from '@aime/shared/threads';
import type { ChatSessionEvent } from './session.js';
import { signalMessage, threadMessages } from './message-conversion.js';

/** Observe all native runs on a thread, including queued and background turns. */
export async function consumeSessionStream(
  subscription: AgentThreadSubscription<unknown, true>,
  messages: Map<string, UIMessage>,
  settings: () => ChatSettings,
  emit: (event: ChatSessionEvent) => void,
  onSignalConsumed: (id: string) => void,
  onTurnFinished: (messageIds: string[]) => Promise<void>,
) {
  const streamedMessageIds = new Set<string>();
  let segment:
    | {
        controller: ReadableStreamDefaultController<ChunkType>;
        done: Promise<void>;
      }
    | undefined;
  let messageId: string | undefined;
  let runId = '';
  let status: ThreadStreamStatus = 'running';
  let started = false;
  const closeSegment = async () => {
    const current = segment;
    segment = undefined;
    if (current) {
      current.controller.close();
      await current.done;
    }
  };
  const reconcileTurn = async () => {
    if (!streamedMessageIds.size) return;
    const ids = [...streamedMessageIds];
    await onTurnFinished(ids);
    for (const id of ids) streamedMessageIds.delete(id);
  };
  const beginSegment = (id?: string) => {
    messageId = id;
    let controller!: ReadableStreamDefaultController<ChunkType>;
    const fullStream = new ReadableStream<ChunkType>({
      start(value) {
        controller = value;
      },
    });
    // The adapter accepts a raw fullStream at runtime; its public overload names
    // MastraModelOutput. No aggregate output properties are used here.
    const uiStream = toAISdkStream({ fullStream } as MastraModelOutput, {
      from: 'agent',
      version: 'v6',
      sendReasoning: true,
      onError: (error) => {
        // The adapter also calls this formatter for tool-output-error. Only
        // native run errors and UI stream failures should fail the thread.
        return error instanceof Error ? error.message : String(error);
      },
    });
    const done = (async () => {
      for await (const message of readUIMessageStream({
        message: id
          ? (messages.get(id) ?? { id, role: 'assistant', parts: [] })
          : undefined,
        stream: uiStream,
        onError: (error) => emit({ type: 'error', error, runId }),
      })) {
        if (message.id && message.parts.length) {
          streamedMessageIds.add(message.id);
          messages.set(message.id, structuredClone(message));
          emit({ type: 'message', message, active: true });
        }
      }
    })();
    segment = { controller, done };
  };
  try {
    for await (const raw of subscription.stream) {
      const chunk = raw as ChunkType | AgentSignalDataPart | ThreadHistoryChunk;
      if (chunk.type === 'thread-history') {
        for (const message of threadMessages(chunk.payload.messages)) {
          messages.set(message.id, structuredClone(message));
          emit({ type: 'message', message, active: false });
        }
        continue;
      }
      if (chunk.type === 'data-user-message' || chunk.type === 'data-signal') {
        const data = (chunk as AgentSignalDataPart).data;
        onSignalConsumed(data.id);
        const message = signalMessage(data);
        if (message) {
          messages.set(message.id, structuredClone(message));
          emit({ type: 'message', message, active: false });
        }
        continue;
      }
      const native = chunk as ChunkType;
      // A new subscription replays pending HITL markers before the resumed run.
      // Service metadata already contains those; only a fresh start is live.
      if (!started && native.type !== 'start') continue;
      runId = native.runId || subscription.activeRunId() || runId;
      if (native.type === 'goal') {
        emit({
          type: 'goal',
          objective: native.payload.objective,
          evaluating: native.payload.pending === true,
          waitingForUser: native.payload.waitingForUser === true,
        });
        continue;
      }
      if (native.type === 'start') {
        started = true;
        await closeSegment();
        await reconcileTurn();
        status = 'running';
        emit({ type: 'status', status, runId });
        beginSegment(
          typeof native.payload.messageId === 'string'
            ? native.payload.messageId
            : undefined,
        );
      }
      if (
        native.type === 'step-start' &&
        native.payload.messageId &&
        native.payload.messageId !== messageId
      ) {
        await closeSegment();
        beginSegment(native.payload.messageId);
      }
      if (
        native.type === 'tool-result' ||
        native.type === 'tool-output-denied' ||
        native.type === 'tool-error' ||
        native.type === 'tool-call-suspended' ||
        native.type === 'tool-call-approval'
      ) {
        const toolCallId = native.payload.toolCallId;
        const original = [...messages.values()].find((message) =>
          message.parts.some(
            (part) => 'toolCallId' in part && part.toolCallId === toolCallId,
          ),
        );
        if (original && original.id !== messageId) {
          await closeSegment();
          beginSegment(original.id);
        }
      }
      if (!segment) beginSegment();
      segment!.controller.enqueue(native);
      if (
        native.type === 'tool-call-suspended' ||
        native.type === 'tool-call-approval'
      ) {
        status = 'suspended';
        const parsed = toolInteractionSchema.parse({
          ...native.payload,
          runId,
          kind: native.type === 'tool-call-approval' ? 'approval' : 'suspended',
          input: native.payload.args,
        });
        emit({
          type: 'interaction',
          interaction: { ...parsed, id: nanoid() },
          settings: settings(),
        });
        emit({ type: 'status', status, runId });
      } else if (native.type === 'error') {
        status = 'failed';
        emit({ type: 'error', error: native.payload.error, runId });
      } else if (native.type === 'abort') {
        status = 'canceled';
        await closeSegment();
        await reconcileTurn();
        emit({ type: 'status', status, runId });
      } else if (native.type === 'finish') {
        await closeSegment();
        if (status === 'running')
          status =
            native.payload.stepResult.reason === 'error'
              ? 'failed'
              : native.payload.stepResult.reason === 'tripwire'
                ? 'tripwire'
                : 'success';
        // Reconcile every terminal state. Reconciliation only coalesces proven
        // overlap, retaining partial text/tools that have not reached storage.
        await reconcileTurn();
        emit({ type: 'status', status, runId });
      }
    }
  } finally {
    await closeSegment();
    await reconcileTurn();
  }
}
