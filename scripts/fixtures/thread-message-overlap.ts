import type { UIMessage } from 'ai';

export const call = (id: string): UIMessage['parts'][number] => ({
  type: 'tool-exec',
  toolCallId: id,
  state: 'output-available',
  input: {},
  output: id,
});
export function overlappingMessages() {
  const before = Array.from({ length: 9 }, (_, i) => call(`before-${i}`));
  const after = Array.from({ length: 7 }, (_, i) => call(`after-${i}`));
  const commentary = { type: 'text' as const, text: 'Intermediate findings' };
  const persisted: UIMessage = {
    id: 'persisted',
    role: 'assistant',
    metadata: { createdAt: '2026-10-13T12:41:20Z' },
    parts: [
      { type: 'text', text: 'Starting' },
      ...before,
      commentary,
      ...after,
    ],
  };
  const draft: UIMessage = {
    id: 'live-draft',
    role: 'assistant',
    parts: [
      ...before.slice(4),
      commentary,
      ...after,
      { type: 'text', text: 'Not saved yet', state: 'streaming' },
      { type: 'file', mediaType: 'image/png', url: '/unsaved.png' },
      {
        type: 'tool-exec',
        toolCallId: 'new-call',
        state: 'input-streaming',
        input: {},
      },
    ],
  };
  return { persisted, draft };
}
