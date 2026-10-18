import type { ChatTurnSummary } from '@aime/shared/chat-turns';

/** History is prepended; live revisions always win over an overlapping page. */
export function mergeTurns(
  current: ChatTurnSummary[],
  incoming: ChatTurnSummary[],
  older = false,
  removedIds: string[] = [],
) {
  const removed = new Set(removedIds);
  const result = new Map<string, ChatTurnSummary>();
  const retained = current.filter((turn) => !removed.has(turn.id));
  for (const turn of older
    ? [...incoming, ...retained]
    : [...retained, ...incoming]) {
    const previous = result.get(turn.id);
    result.set(
      turn.id,
      previous?.revision === turn.revision && previous.cursor === turn.cursor
        ? previous
        : previous
          ? { ...turn, cursor: turn.cursor ?? previous.cursor }
          : turn,
    );
  }
  const turns = [...result.values()];
  return turns.length === current.length &&
    turns.every((turn, index) => turn === current[index])
    ? current
    : turns;
}
