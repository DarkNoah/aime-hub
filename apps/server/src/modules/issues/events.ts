import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { EntityManager } from 'typeorm';
import type { IssueThreadObservation } from '../threads/session.js';

type IssueEvent = {
  type: 'created' | 'updated' | 'commented' | 'message' | 'stopped' | 'thread';
  actorId?: string;
  actorThreadId?: string;
  changes?: Record<string, unknown>;
  body?: string;
  execution?: IssueThreadObservation;
};

/** Commit the change and its wake-up together. Only the associated room's bot receives it. */
export async function enqueueIssueEvent(
  manager: EntityManager,
  issueId: number,
  event: IssueEvent,
) {
  const execution = event.execution;
  const id = execution
    ? `issue:${createHash('sha256').update(`${issueId}:${execution.runId}:${execution.status}`).digest('hex')}`
    : `issue:${nanoid()}`;
  // Source bindings are server-owned. User identity alone cannot distinguish
  // a human edit from a bot acting for that same user, so suppress by thread.
  await manager.query(
    `INSERT INTO group_chat_events(id,version,room_id,agent_id,actor_id,kind,text,due_at)
     SELECT $2,$2,bot.room_id,bot.id,i.created_by,'issue',
       jsonb_build_object('issueId',i.id,'title',i.title,'state',i.state,'threadId',i.thread_id,
         'event',$3::jsonb)::text,now()
     FROM issues i
     JOIN group_chat_agents source ON source.thread_id=i.source_thread_id AND NOT source.deleting
     JOIN group_chats room ON room.id=source.room_id AND NOT room.deleting
     JOIN group_chat_agents bot ON bot.room_id=room.id AND bot.role='bot' AND NOT bot.deleting
     WHERE i.id=$1 AND ($4::text IS NULL OR bot.thread_id<>$4)
       AND ($5::text IS NULL OR i.thread_id=$5)
     ON CONFLICT(id) DO NOTHING`,
    [
      issueId,
      id,
      JSON.stringify({
        ...event,
        body: event.body?.slice(0, 12000),
        execution: execution
          ? {
              ...execution,
              result: execution.result.slice(-12000),
              error: execution.error?.slice(0, 2000) ?? null,
            }
          : undefined,
      }),
      event.actorThreadId ?? execution?.actorThreadId ?? null,
      execution?.threadId ?? null,
    ],
  );
}
