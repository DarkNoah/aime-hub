import type { MastraCompositeStore } from '@mastra/core/storage';
import type { GoalObjectiveRecord } from '@mastra/core/storage';
import type { ThreadGoal } from '@aime/shared/threads';

export const GOAL_MAX_RUNS = 150;

export async function readThreadGoal(
  storage: MastraCompositeStore,
  threadId: string,
): Promise<ThreadGoal | null> {
  const store = await storage.getStore('threadState');
  const record = await store?.getState<GoalObjectiveRecord>({
    threadId,
    type: 'goal',
  });
  return record
    ? {
        id: record.id,
        objective: record.objective,
        status: record.status,
        runsUsed: record.runsUsed,
        maxRuns: record.maxRuns ?? GOAL_MAX_RUNS,
        activeDurationMs: record.activeDurationMs ?? 0,
        pausedReason: record.pausedReason,
      }
    : null;
}
