import { convertMessages, mastraDBMessageToSignal } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { AgentSignalDataPart } from '@mastra/core/agent';
import type { UIMessage } from 'ai';

export function signalMessage(
  data: AgentSignalDataPart['data'],
): UIMessage | undefined {
  if (data.type !== 'user') return;
  const contents =
    typeof data.contents === 'string'
      ? [{ type: 'text' as const, text: data.contents }]
      : data.contents;
  return {
    id:
      typeof data.metadata?.clientMessageId === 'string'
        ? data.metadata.clientMessageId
        : data.id,
    role: 'user',
    metadata: {
      ...data.metadata,
      createdAt:
        typeof data.metadata?.createdAt === 'string'
          ? data.metadata.createdAt
          : data.createdAt,
    },
    parts: contents.map((part) =>
      part.type === 'text'
        ? part
        : {
            type: 'file' as const,
            mediaType: part.mediaType,
            ...(part.filename ? { filename: part.filename } : {}),
            url:
              typeof part.data === 'string' && part.data.startsWith('data:')
                ? part.data
                : `data:${part.mediaType};base64,${String(part.data)}`,
          },
    ),
  };
}

/** Native user signals keep their client ID in both live updates and history. */
export function threadMessages(messages: MastraDBMessage[]): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'signal')
      return convertMessages([message]).to('AIV6.UI') as UIMessage[];
    const converted = signalMessage(
      mastraDBMessageToSignal(message).toDataPart().data,
    );
    return converted ? [converted] : [];
  });
}
