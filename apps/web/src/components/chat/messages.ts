import type { UIMessage } from 'ai';

export function mergeMessages(
  current: UIMessage[],
  incoming: UIMessage[],
  older = false,
) {
  const messages = new Map<string, UIMessage>();
  for (const message of older
    ? [...incoming, ...current]
    : [...current, ...incoming])
    messages.set(message.id, message);
  return [...messages.values()];
}
