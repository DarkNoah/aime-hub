import type { ChatRunner } from '../../apps/server/src/modules/threads/service.js';
import type { UIMessage } from 'ai';
import type {
  ChatUsage,
  RunInput,
  ThreadStreamStatus,
  ToolInteraction,
  ToolResponse,
} from '@aime/shared/threads';

/** Single-turn test driver over the real native thread session. */
export async function executeTurn(
  runner: ChatRunner,
  context: {
    thread: Parameters<ChatRunner['open']>[0]['thread'];
    input: Omit<RunInput, 'parts'> & {
      parts: RunInput['parts'];
      resume?: {
        interactionId: string;
        kind?: ToolInteraction['kind'];
        runId: string;
        toolCallId: string;
        response: ToolResponse;
      };
    };
    signal: AbortSignal;
    onMessage: (message: UIMessage) => void;
    onStatus: (status: ThreadStreamStatus) => void;
    onUsage: (usage: ChatUsage) => Promise<void>;
  },
) {
  const interactions: ToolInteraction[] = [];
  let finish!: (status: ThreadStreamStatus) => void;
  const terminal = new Promise<ThreadStreamStatus>((resolve) => {
    finish = resolve;
  });
  const session = await runner.open({
    thread: context.thread,
    settings: context.input,
    onEvent(event) {
      if (event.type === 'message' && event.message.role === 'assistant')
        context.onMessage(event.message);
      if (event.type === 'usage') void context.onUsage(event.usage);
      if (event.type === 'interaction') interactions.push(event.interaction);
      if (event.type === 'status') {
        context.onStatus(event.status);
        if (event.status !== 'running' && event.status !== 'pending')
          finish(event.status);
      }
      if (event.type === 'error') finish('failed');
    },
  });
  const abort = () => session.abort();
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    const resume = context.input.resume;
    if (resume)
      await session.respond(
        {
          id: resume.interactionId,
          kind: resume.kind ?? 'suspended',
          runId: resume.runId,
          toolCallId: resume.toolCallId,
          toolName: 'test',
        },
        resume.response,
        context.input,
      );
    else await session.send(context.input);
    return { status: await terminal, toolInteractions: interactions };
  } finally {
    context.signal.removeEventListener('abort', abort);
    await session.close();
  }
}
