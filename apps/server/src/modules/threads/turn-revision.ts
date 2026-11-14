import { createHash } from 'node:crypto';
import type { UIMessage } from 'ai';

const partRevisions = new WeakMap<UIMessage['parts'][number], string>();

/** Streaming replaces changed parts; unchanged large tool results keep their digest. */
export function partRevision(part: UIMessage['parts'][number]) {
  let revision = partRevisions.get(part);
  if (!revision) {
    revision = createHash('sha256').update(JSON.stringify(part)).digest('hex');
    partRevisions.set(part, revision);
  }
  return revision;
}

const messageRevisions = new WeakMap<UIMessage, string>();

export function messageRevision(message: UIMessage) {
  let revision = messageRevisions.get(message);
  if (!revision) {
    revision = createHash('sha256')
      .update(
        JSON.stringify([
          message.id,
          message.role,
          message.metadata,
          message.parts.map(partRevision),
        ]),
      )
      .digest('hex');
    messageRevisions.set(message, revision);
  }
  return revision;
}
