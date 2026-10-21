import type { DataSource } from 'typeorm';
import type { MemberProfile } from '@aime/shared/group-chats';
import type { GroupChatService } from '../group-chats/service.js';

export class UserService {
  constructor(
    private database: DataSource,
    private rooms: GroupChatService,
  ) {}

  async lookup(
    userId: string,
    userIds: string[],
    roomId?: string,
  ): Promise<MemberProfile[]> {
    // A room also permits resolving historical senders who have left the project.
    const room = roomId ? await this.rooms.get(userId, roomId) : null;
    const ids = [...new Set(userIds)];
    if (!ids.length) return [];
    return this.database.query(
      `SELECT u.id, u.name, u.username, u.image FROM users u
      WHERE u.id = ANY($1::text[]) AND (
        u.id = $2 OR EXISTS (
          SELECT 1 FROM project_members me JOIN project_members other ON other.project_id = me.project_id
          JOIN projects p ON p.id = me.project_id
          WHERE me.user_id = $2 AND other.user_id = u.id
          AND me.deleted_at IS NULL AND other.deleted_at IS NULL AND p.deleted_at IS NULL
        ) ${room ? `OR u.id = ANY($3::text[]) OR EXISTS (SELECT 1 FROM group_chat_messages m WHERE m.room_id = $4 AND m.sender_id = u.id)` : ''}
      ) ORDER BY array_position($1::text[], u.id)`,
      [ids, userId, ...(room ? [room.memberIds, room.id] : [])],
    );
  }
}
