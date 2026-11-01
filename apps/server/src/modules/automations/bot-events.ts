import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { hasAdminRole } from '@aime/shared';
import type { Automation, AutomationScope } from '@aime/shared/automations';
import type { GroupChatService } from '../group-chats/service.js';
import { ThreadError } from '../threads/errors.js';
import type { AutomationResult } from './service.js';

/** Deliver terminal results through the room's durable, deduplicated event queue. */
export class AutomationBotEvents {
  constructor(
    private pool: Pick<Pool, 'query'>,
    private rooms: Pick<GroupChatService, 'get' | 'openDefault'>,
  ) {}

  async validateSource(userId: string, scope: AutomationScope, roomId: string) {
    const room = await this.rooms.get(userId, roomId);
    if (room.projectId !== (scope.scope === 'project' ? scope.projectId : null))
      throw new ThreadError('FORBIDDEN', 403);
    return room;
  }

  async publish(
    task: Automation,
    result: AutomationResult,
    executionId: string,
  ) {
    if (result.status !== 'succeeded' && result.status !== 'failed') return;
    const { rows } = await this.pool.query(
      'SELECT role, banned FROM users WHERE id = $1',
      [task.createdBy],
    );
    const user = rows[0];
    if (
      !user ||
      user.banned ||
      (task.scope.scope === 'system' && !hasAdminRole(user.role))
    )
      return;
    // Legacy and page-created tasks use the same default room as the scope UI.
    // A deleted/inaccessible explicit source must never redirect to another room.
    const room = task.sourceRoomId
      ? await this.validateSource(task.createdBy, task.scope, task.sourceRoomId)
      : await this.rooms.openDefault(
          task.createdBy,
          task.scope.scope === 'project' ? task.scope.projectId : undefined,
        );
    const id = `automation:${createHash('sha256').update(`${task.id}:${executionId}`).digest('hex')}`;
    await this.pool.query(
      `INSERT INTO group_chat_events(id,version,room_id,agent_id,actor_id,kind,text,due_at)
       SELECT $1,$1,r.id,bot.id,$3,'automation',$4,now()
       FROM group_chats r JOIN group_chat_agents bot ON bot.room_id=r.id AND bot.role='bot' AND NOT bot.deleting
       WHERE r.id=$2 AND NOT r.deleting
       ON CONFLICT(id) DO NOTHING`,
      [
        id,
        room.id,
        task.createdBy,
        JSON.stringify({
          taskId: task.id,
          taskName: task.name,
          scope: task.scope,
          threadId: task.threadId,
          executionId,
          status: result.status,
          result: result.text.slice(-12000),
          error: result.error?.slice(0, 2000) ?? null,
        }),
      ],
    );
  }
}
