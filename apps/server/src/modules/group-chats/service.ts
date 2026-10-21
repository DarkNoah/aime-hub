import { nanoid } from 'nanoid';
import { ORPCError } from '@orpc/server';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  GroupChat,
  GroupChatDetail,
  GroupChatList,
  GroupChatMessage,
  GroupChatMessages,
} from '@aime/shared/group-chats';
import {
  groupChatCreateSchema,
  groupChatMessageSchema,
} from '@aime/shared/group-chats';

type RoomRow = Omit<GroupChat, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};
type MessageRow = Omit<GroupChatMessage, 'createdAt'> & { createdAt: Date };
const roomColumns = `id, title, project_id AS "projectId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;
const messageColumns = `id, room_id AS "roomId", sequence::text, sender_id AS "senderId", text, created_at AS "createdAt"`;
const roomDto = (row: RoomRow): GroupChat => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const messageDto = (row: MessageRow): GroupChatMessage => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});

export class GroupChatService {
  constructor(private database: DataSource) {}

  /** Resolve the single room shown by the UI without restricting multi-room storage. */
  async openDefault(
    userId: string,
    projectId?: string,
  ): Promise<GroupChatDetail> {
    const roomId = await this.database.transaction(async (manager) => {
      if (projectId) await this.projectAccess(userId, projectId, manager, true);
      // Concurrent first visits (including different project members) share one room.
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `group-chat-default:${projectId ? `project:${projectId}` : `user:${userId}`}`,
        ],
      );
      const existing: { id: string }[] = await manager.query(
        `SELECT id FROM group_chats
         WHERE ${projectId ? 'project_id = $1' : 'project_id IS NULL AND created_by = $1'}
         ORDER BY created_at, id LIMIT 1`,
        [projectId ?? userId],
      );
      if (existing[0]) return existing[0].id;
      const id = nanoid(16);
      await manager.query(
        `INSERT INTO group_chats (id, title, project_id, created_by) VALUES ($1, $2, $3, $4)`,
        [id, 'Chat', projectId ?? null, userId],
      );
      return id;
    });
    return this.get(userId, roomId);
  }

  private async projectAccess(
    userId: string,
    projectId: string,
    manager: EntityManager,
    lock = false,
  ) {
    const rows: { role: string }[] = await manager.query(
      `
      SELECT m.role FROM projects p JOIN project_members m ON m.project_id = p.id
      WHERE p.id = $1 AND m.user_id = $2 AND p.deleted_at IS NULL AND m.deleted_at IS NULL
      ${lock ? 'FOR SHARE OF p, m' : ''}`,
      [projectId, userId],
    );
    if (!rows.length) throw new ORPCError('NOT_FOUND');
    return rows[0].role;
  }

  private async access(
    userId: string,
    roomId: string,
    manager = this.database.manager,
    lock = false,
  ) {
    const rows: RoomRow[] = await manager.query(
      `SELECT ${roomColumns} FROM group_chats WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [roomId],
    );
    const room = rows[0];
    if (!room) throw new ORPCError('NOT_FOUND');
    const role = room.projectId
      ? await this.projectAccess(userId, room.projectId, manager, lock)
      : null;
    if (!room.projectId && room.createdBy !== userId)
      throw new ORPCError('NOT_FOUND');
    return {
      room,
      canManage:
        room.createdBy === userId || role === 'owner' || role === 'admin',
    };
  }

  async list(
    userId: string,
    query: { projectId?: string; page: number; perPage: number },
  ): Promise<GroupChatList> {
    if (query.projectId)
      await this.projectAccess(userId, query.projectId, this.database.manager);
    const rows: RoomRow[] = await this.database.query(
      `SELECT ${roomColumns} FROM group_chats
      WHERE ${query.projectId ? 'project_id = $1' : 'project_id IS NULL AND created_by = $1'}
      ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [
        query.projectId ?? userId,
        query.perPage + 1,
        query.page * query.perPage,
      ],
    );
    return {
      rooms: rows.slice(0, query.perPage).map(roomDto),
      hasMore: rows.length > query.perPage,
    };
  }

  async get(userId: string, roomId: string): Promise<GroupChatDetail> {
    const { room, canManage } = await this.access(userId, roomId);
    const members: { userId: string }[] = room.projectId
      ? await this.database.query(
          `SELECT user_id AS "userId" FROM project_members WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at, user_id`,
          [room.projectId],
        )
      : [{ userId: room.createdBy }];
    return {
      ...roomDto(room),
      canManage,
      memberIds: members.map((member) => member.userId),
    };
  }

  async create(
    userId: string,
    input: { title: string; projectId?: string },
  ): Promise<GroupChatDetail> {
    const parsed = groupChatCreateSchema.parse(input);
    const id = nanoid(16);
    await this.database.transaction(async (manager) => {
      if (parsed.projectId)
        await this.projectAccess(userId, parsed.projectId, manager, true);
      await manager.query(
        `INSERT INTO group_chats (id, title, project_id, created_by) VALUES ($1, $2, $3, $4)`,
        [id, parsed.title, parsed.projectId ?? null, userId],
      );
    });
    return this.get(userId, id);
  }

  update(userId: string, roomId: string, title: string): Promise<GroupChat> {
    const parsed = groupChatCreateSchema.shape.title.parse(title);
    return this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true)).canManage)
        throw new ORPCError('FORBIDDEN');
      await manager.query(
        `UPDATE group_chats SET title = $2, updated_at = now() WHERE id = $1`,
        [roomId, parsed],
      );
      const rows: RoomRow[] = await manager.query(
        `SELECT ${roomColumns} FROM group_chats WHERE id = $1`,
        [roomId],
      );
      return roomDto(rows[0]);
    });
  }

  async remove(userId: string, roomId: string): Promise<void> {
    await this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true)).canManage)
        throw new ORPCError('FORBIDDEN');
      await manager.query('DELETE FROM group_chats WHERE id = $1', [roomId]);
    });
  }

  async messages(
    userId: string,
    roomId: string,
    query: { before?: string; after?: string; limit: number },
  ): Promise<GroupChatMessages> {
    await this.access(userId, roomId);
    const cursor = query.before ?? query.after;
    const rows: MessageRow[] = await this.database.query(
      `SELECT ${messageColumns} FROM group_chat_messages
      WHERE room_id = $1 ${cursor !== undefined ? `AND sequence ${query.after !== undefined ? '>' : '<'} $3::bigint` : ''}
      ORDER BY group_chat_messages.sequence ${query.after !== undefined ? 'ASC' : 'DESC'} LIMIT $2`,
      [roomId, query.limit + 1, ...(cursor !== undefined ? [cursor] : [])],
    );
    const messages = rows.slice(0, query.limit).map(messageDto);
    if (query.after === undefined) messages.reverse();
    return { messages, hasMore: rows.length > query.limit };
  }

  send(
    userId: string,
    roomId: string,
    input: { id: string; text: string },
  ): Promise<GroupChatMessage> {
    const parsed = groupChatMessageSchema.parse(input);
    return this.database.transaction(async (manager) => {
      // Serialize sends per room: a committed sequence cursor can never skip a pending send.
      await this.access(userId, roomId, manager, true);
      const previous: MessageRow[] = await manager.query(
        `SELECT ${messageColumns} FROM group_chat_messages WHERE room_id = $1 AND id = $2`,
        [roomId, parsed.id],
      );
      if (previous[0]) {
        if (previous[0].senderId !== userId || previous[0].text !== parsed.text)
          throw new ORPCError('CONFLICT');
        return messageDto(previous[0]);
      }
      const rows: MessageRow[] = await manager.query(
        `INSERT INTO group_chat_messages (room_id, id, sender_id, text) VALUES ($1, $2, $3, $4) RETURNING ${messageColumns}`,
        [roomId, parsed.id, userId, parsed.text],
      );
      await manager.query(
        'UPDATE group_chats SET updated_at = now() WHERE id = $1',
        [roomId],
      );
      return messageDto(rows[0]);
    });
  }
}
