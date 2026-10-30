import { nanoid } from 'nanoid';
import { isDeepStrictEqual } from 'node:util';
import { ORPCError } from '@orpc/server';
import type { DataSource, EntityManager } from 'typeorm';
import type { ChatSettings } from '@aime/shared/threads';
import type {
  GroupChat,
  GroupChatDetail,
  GroupChatList,
  GroupChatReadState,
  GroupChatMessage,
  GroupChatMessages,
  GroupChatAgent,
  GroupChatAgentInput,
  GroupChatAgentUpdate,
  GroupChatA2AMemberInput,
  GroupChatA2AMemberUpdate,
  GroupChatFile,
  GroupChatUi,
  GroupChatEvent,
  GroupChatSearch,
  MemberProfile,
} from '@aime/shared/group-chats';
import {
  groupChatCreateSchema,
  groupChatReadSchema,
  groupChatMessageSchema,
  groupChatAgentCreateSchema,
  groupChatAgentUpdateSchema,
  groupChatReactionSchema,
  groupChatUiSchema,
  groupChatUiResponseSchema,
  mentionedRoomAgentIds,
} from '@aime/shared/group-chats';
import { messageSearchTerms } from './search.js';
import { GroupChatA2aKeys } from './a2a-keys.js';
import type { ProjectService } from '../projects/service.js';

export type GroupChatLifecycle = {
  ensureAgent(room: GroupChat, agent: GroupChatAgent): Promise<void>;
  removeAgents?(room: GroupChat, agents: GroupChatAgent[]): Promise<void>;
  updateAgent?(
    room: GroupChat,
    previous: GroupChatAgent,
    next: GroupChatAgent,
  ): Promise<void>;
  validateAgent?(
    userId: string,
    room: GroupChat,
    settings: ChatSettings,
    role: GroupChatAgent['role'],
  ): Promise<void>;
  validateFiles?(
    userId: string,
    agent: GroupChatAgent,
    files: GroupChatFile[],
  ): Promise<void>;
};
export type AgentRoomMessageInput = {
  id: string;
  text: string;
  replyToId?: string;
  files?: GroupChatFile[];
  ui?: GroupChatUi;
  targetAgentId?: string;
};
type RoomRow = Omit<GroupChat, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};
type MessageRow = Omit<GroupChatMessage, 'createdAt'> & { createdAt: Date };
const roomColumns = `id, title, project_id AS "projectId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;
const agentColumns = `id,room_id AS "roomId",thread_id AS "threadId",name,role,settings,enabled,status,error,last_read_sequence::text AS "lastReadSequence",idle_wake_hours AS "idleWakeHours"`;
// A pending plan blocks idle work even when its deadline is far in the future.
const idleAgentReady = `a.role='bot' AND a.enabled AND NOT a.deleting AND a.status IN ('idle','failed')
  AND a.idle_wake_hours IS NOT NULL AND a.idle_since + a.idle_wake_hours * interval '1 hour' <= now()
  AND EXISTS(SELECT 1 FROM group_chats r WHERE r.id=a.room_id AND NOT r.deleting)
  AND NOT EXISTS(SELECT 1 FROM group_chat_events waiting WHERE waiting.agent_id=a.id AND waiting.status='pending' AND waiting.kind<>'idle')`;
const eventColumns = `id,version,room_id AS "roomId",agent_id AS "agentId",actor_id AS "actorId",kind,text,due_at AS "dueAt",status,error`;
const messageColumns = `m.id,m.room_id AS "roomId",m.sequence::text,m.revision::text,m.sender_id AS "senderId",m.sender_kind AS "senderKind",CASE WHEN m.sender_kind='agent' THEN sender_agent.name WHEN m.sender_kind='a2a' THEN sender_a2a.name ELSE NULLIF(btrim(sender_user.name),'') END AS "senderName",NULLIF(btrim(sender_user.username),'') AS "senderUsername",m.text,m.reply_to_id AS "replyToId",m.files,m.ui,m.ui_response AS "uiResponse",m.target_agent_id AS "targetAgentId",m.created_at AS "createdAt", COALESCE((SELECT jsonb_agg(r) FROM (SELECT emoji, jsonb_agg(member_id ORDER BY member_id) AS "memberIds" FROM group_chat_reactions WHERE room_id=m.room_id AND message_id=m.id GROUP BY emoji ORDER BY emoji) r),'[]'::jsonb) AS reactions`;
const messageSenderJoins = `LEFT JOIN users sender_user ON m.sender_kind='user' AND sender_user.id=m.sender_id
  LEFT JOIN group_chat_agents sender_agent ON m.sender_kind='agent' AND sender_agent.room_id=m.room_id AND sender_agent.id=m.sender_id
  LEFT JOIN group_chat_a2a_members sender_a2a ON m.sender_kind='a2a' AND sender_a2a.room_id=m.room_id AND sender_a2a.id=m.sender_id`;
const roomDto = (row: RoomRow): GroupChat => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const messageDto = (row: MessageRow): GroupChatMessage => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
const eventDto = (
  row: Omit<GroupChatEvent, 'dueAt'> & { dueAt: Date },
): GroupChatEvent => ({ ...row, dueAt: row.dueAt.toISOString() });
const boundedLimit = (limit: number) =>
  Math.max(1, Math.min(100, Math.trunc(limit) || 50));

export class GroupChatService {
  private lifecycle?: GroupChatLifecycle;
  private a2aKeys: GroupChatA2aKeys;
  private lifecycleTasks = new Map<string, Promise<unknown>>();
  private async lifecycleLocked<T>(
    roomId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTasks.get(roomId);
    const task = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    this.lifecycleTasks.set(roomId, task);
    try {
      return await task;
    } finally {
      if (this.lifecycleTasks.get(roomId) === task)
        this.lifecycleTasks.delete(roomId);
    }
  }
  constructor(
    private database: DataSource,
    private projects?: Pick<ProjectService, 'addMember'>,
  ) {
    this.a2aKeys = new GroupChatA2aKeys(
      database,
      (userId, roomId, manager, lock) =>
        this.access(userId, roomId, manager, lock),
    );
  }
  setLifecycle(lifecycle: GroupChatLifecycle) {
    this.lifecycle = lifecycle;
  }
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
         WHERE NOT deleting AND ${projectId ? 'project_id = $1' : 'project_id IS NULL AND created_by = $1'}
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
    allowDeleting = false,
  ) {
    const rows: RoomRow[] = await manager.query(
      `SELECT ${roomColumns}, (SELECT name FROM users WHERE id=group_chats.created_by) AS "ownerName" FROM group_chats WHERE id = $1 ${allowDeleting ? '' : 'AND NOT deleting'} ${lock ? 'FOR UPDATE' : ''}`,
      [roomId],
    );
    const room = rows[0];
    if (!room) throw new ORPCError('NOT_FOUND');
    const role = room.projectId
      ? await this.projectAccess(userId, room.projectId, manager, lock)
      : null;
    if (!room.projectId && room.createdBy !== userId) {
      const members = await manager.query(
        `SELECT 1 FROM group_chat_members WHERE room_id=$1 AND user_id=$2 ${lock ? 'FOR SHARE' : ''}`,
        [roomId, userId],
      );
      if (!members.length) throw new ORPCError('NOT_FOUND');
    }
    return {
      room,
      canManage:
        room.createdBy === userId || role === 'owner' || role === 'admin',
      canManageMembers: room.projectId
        ? role === 'owner' || role === 'admin'
        : room.createdBy === userId,
    };
  }

  async list(
    userId: string,
    query: { projectId?: string; page: number; perPage: number },
  ): Promise<GroupChatList> {
    if (query.projectId)
      await this.projectAccess(userId, query.projectId, this.database.manager);
    const rows: RoomRow[] = await this.database.query(
      `SELECT ${roomColumns}, (SELECT name FROM users WHERE id=group_chats.created_by) AS "ownerName" FROM group_chats
      WHERE NOT deleting AND ${query.projectId ? 'project_id = $1' : 'project_id IS NULL AND (created_by = $1 OR EXISTS (SELECT 1 FROM group_chat_members m WHERE m.room_id=group_chats.id AND m.user_id=$1))'}
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

  private async ensureBot(manager: EntityManager, roomId: string) {
    await manager.query(
      `INSERT INTO group_chat_agents(id,room_id,thread_id,name,role) VALUES($1,$2,$3,'Bot','bot') ON CONFLICT (room_id) WHERE role='bot' DO NOTHING`,
      [nanoid(16), roomId, nanoid(16)],
    );
  }

  /** One lightweight query for every visible sidebar room, independent of message history. */
  async unread(userId: string): Promise<{ rooms: GroupChatReadState[] }> {
    const rooms = await this.database.query(
      `
      SELECT r.id AS "roomId", r.project_id AS "projectId",
        COALESCE(latest.sequence,0)::text AS "latestSequence",
        COALESCE(seen.last_read_sequence,0)::text AS "readSequence"
      FROM group_chats r
      LEFT JOIN group_chat_reads seen ON seen.room_id=r.id AND seen.user_id=$1
      LEFT JOIN LATERAL (
        SELECT m.sequence FROM group_chat_messages m
        WHERE m.room_id=r.id AND (m.sender_kind<>'user' OR m.sender_id<>$1)
        ORDER BY m.sequence DESC LIMIT 1
      ) latest ON true
      WHERE NOT r.deleting AND (
        (r.project_id IS NULL AND (r.created_by=$1 OR EXISTS (
          SELECT 1 FROM group_chat_members member WHERE member.room_id=r.id AND member.user_id=$1
        ))) OR (
          EXISTS (SELECT 1 FROM projects p JOIN project_members member ON member.project_id=p.id
            WHERE p.id=r.project_id AND p.deleted_at IS NULL AND member.user_id=$1 AND member.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM group_chats earlier WHERE earlier.project_id=r.project_id
            AND NOT earlier.deleting AND (earlier.created_at,earlier.id)<(r.created_at,r.id))
        )
      ) ORDER BY r.id`,
      [userId],
    );
    return { rooms };
  }

  async markRead(userId: string, roomId: string, input: { sequence: string }) {
    const { sequence } = groupChatReadSchema.parse(input);
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      // Acknowledge only the displayed prefix, even if another reply arrived in the meantime.
      const rows: { readSequence: string }[] = await manager.query(
        `
        INSERT INTO group_chat_reads(room_id,user_id,last_read_sequence)
        VALUES($1,$2,LEAST($3::bigint,COALESCE((SELECT MAX(sequence) FROM group_chat_messages WHERE room_id=$1),0)))
        ON CONFLICT (room_id,user_id) DO UPDATE
        SET last_read_sequence=GREATEST(group_chat_reads.last_read_sequence,EXCLUDED.last_read_sequence)
        RETURNING last_read_sequence::text AS "readSequence"`,
        [roomId, userId, sequence],
      );
      return rows[0];
    });
  }

  async searchUsers(
    userId: string,
    roomId: string,
    query: string,
  ): Promise<MemberProfile[]> {
    const { room, canManageMembers } = await this.access(userId, roomId);
    if (!canManageMembers) throw new ORPCError('FORBIDDEN');
    if (query.trim().length < 2) return [];
    return this.database.query(
      `SELECT u.id,u.name,u.username,u.image FROM users u
       WHERE COALESCE(u.banned,false)=false AND ($2::text IS NULL OR u.id<>$2)
       AND (strpos(lower(u.name),lower($3))>0 OR strpos(lower(COALESCE(u.username,'')),lower($3))>0)
       AND NOT EXISTS (SELECT 1 FROM ${room.projectId ? 'project_members m WHERE m.project_id=$1 AND m.user_id=u.id AND m.deleted_at IS NULL' : 'group_chat_members m WHERE m.room_id=$1 AND m.user_id=u.id'})
       ORDER BY u.name,u.id LIMIT 20`,
      [
        room.projectId ?? roomId,
        room.projectId ? null : room.createdBy,
        query.trim(),
      ],
    );
  }

  async addMember(
    userId: string,
    roomId: string,
    targetId: string,
  ): Promise<MemberProfile> {
    const { room, canManageMembers } = await this.access(userId, roomId);
    if (!canManageMembers) throw new ORPCError('FORBIDDEN');
    const profile = async (manager: EntityManager) => {
      const rows: MemberProfile[] = await manager.query(
        'SELECT id,name,username,image FROM users WHERE id=$1 AND COALESCE(banned,false)=false',
        [targetId],
      );
      if (!rows[0]) throw new ORPCError('NOT_FOUND');
      return rows[0];
    };
    if (room.projectId) {
      const member = await profile(this.database.manager);
      const existing = await this.database.query(
        'SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL',
        [room.projectId, targetId],
      );
      if (!existing.length) {
        if (!this.projects) throw new ORPCError('INTERNAL_SERVER_ERROR');
        try {
          // Joining a project room also joins the project and its workspace.
          await this.projects.addMember(userId, room.projectId, {
            userId: targetId,
            role: 'member',
          });
        } catch (error) {
          // Concurrent additions are an idempotent success, without changing roles.
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 'PROJECT_MEMBER_EXISTS'
          )
            throw error;
        }
      }
      return member;
    }
    return this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true)).canManageMembers)
        throw new ORPCError('FORBIDDEN');
      const member = await profile(manager);
      if (targetId !== room.createdBy)
        await manager.query(
          'INSERT INTO group_chat_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [roomId, targetId],
        );
      return member;
    });
  }

  async get(userId: string, roomId: string): Promise<GroupChatDetail> {
    const detail = await this.database.transaction(async (manager) => {
      const { room, canManage, canManageMembers } = await this.access(
        userId,
        roomId,
        manager,
        true,
      );
      await this.ensureBot(manager, roomId);
      const members: { userId: string }[] = room.projectId
        ? await manager.query(
            `SELECT user_id AS "userId" FROM project_members WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at,user_id`,
            [room.projectId],
          )
        : [
            { userId: room.createdBy },
            ...(await manager.query(
              `SELECT user_id AS "userId" FROM group_chat_members WHERE room_id=$1 AND user_id<>$2 ORDER BY created_at,user_id`,
              [roomId, room.createdBy],
            )),
          ];
      const agents: GroupChatAgent[] = await manager.query(
        `SELECT ${agentColumns} FROM group_chat_agents WHERE room_id=$1 AND NOT deleting ORDER BY role,created_at,id`,
        [roomId],
      );
      return {
        ...roomDto(room),
        canManage,
        canManageMembers,
        memberIds: members.map((m) => m.userId),
        a2aMembers: await this.a2aKeys.list(manager, roomId),
        agents,
        botAgentId: agents.find((a) => a.role === 'bot')!.id,
      };
    });
    // Thread/storage provisioning must never run while a room transaction is locked.
    await this.lifecycleLocked(roomId, async () => {
      await this.access(userId, roomId);
      const agents: GroupChatAgent[] = await this.database.query(
        `SELECT ${agentColumns} FROM group_chat_agents WHERE room_id=$1 AND NOT deleting`,
        [roomId],
      );
      await Promise.all(
        agents.map((agent) => this.lifecycle?.ensureAgent(detail, agent)),
      );
    });
    return detail;
  }

  async create(
    userId: string,
    input: { title: string; projectId?: string },
  ): Promise<GroupChatDetail> {
    const parsed = groupChatCreateSchema.parse(input),
      id = nanoid(16);
    await this.database.transaction(async (manager) => {
      if (parsed.projectId)
        await this.projectAccess(userId, parsed.projectId, manager, true);
      await manager.query(
        `INSERT INTO group_chats(id,title,project_id,created_by) VALUES($1,$2,$3,$4)`,
        [id, parsed.title, parsed.projectId ?? null, userId],
      );
      await this.ensureBot(manager, id);
    });
    return this.get(userId, id);
  }

  update(userId: string, roomId: string, title: string): Promise<GroupChat> {
    const parsed = groupChatCreateSchema.shape.title.parse(title);
    return this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true)).canManage)
        throw new ORPCError('FORBIDDEN');
      const rows: RoomRow[] = await manager.query(
        `WITH updated AS (UPDATE group_chats SET title=$2,updated_at=now() WHERE id=$1 RETURNING ${roomColumns}) SELECT * FROM updated`,
        [roomId, parsed],
      );
      return roomDto(rows[0]);
    });
  }

  async remove(userId: string, roomId: string): Promise<void> {
    const { room, agents } = await this.database.transaction(
      async (manager) => {
        const access = await this.access(userId, roomId, manager, true, true);
        if (!access.canManage) throw new ORPCError('FORBIDDEN');
        await manager.query(
          'UPDATE group_chats SET deleting=true WHERE id=$1',
          [roomId],
        );
        const agents: GroupChatAgent[] = await manager.query(
          `WITH updated AS (UPDATE group_chat_agents SET enabled=false,deleting=true WHERE room_id=$1 RETURNING ${agentColumns}) SELECT * FROM updated`,
          [roomId],
        );
        return { room: roomDto(access.room), agents };
      },
    );
    // Tombstones prevent concurrent reads from provisioning threads again. Failed cleanup is retryable.
    await this.lifecycleLocked(roomId, async () => {
      await this.lifecycle?.removeAgents?.(room, agents);
    });
    await this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true, true)).canManage)
        throw new ORPCError('FORBIDDEN');
      await manager.query('DELETE FROM group_chats WHERE id=$1', [roomId]);
    });
  }

  private async roomRevision(manager: EntityManager, roomId: string) {
    const rows: { revision: string }[] = await manager.query(
      `SELECT COALESCE(max(revision),0)::text AS revision FROM group_chat_messages WHERE room_id=$1`,
      [roomId],
    );
    return rows[0].revision;
  }

  async messages(
    userId: string,
    roomId: string,
    query: {
      before?: string;
      after?: string;
      afterRevision?: string;
      limit: number;
    },
  ): Promise<GroupChatMessages> {
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      return this.readMessages(manager, roomId, query);
    });
  }

  private async readMessages(
    manager: EntityManager,
    roomId: string,
    query: {
      before?: string;
      after?: string;
      afterRevision?: string;
      limit: number;
    },
  ): Promise<GroupChatMessages> {
    const limit = boundedLimit(query.limit),
      cursor = query.afterRevision ?? query.before ?? query.after;
    const ascending =
      query.afterRevision !== undefined || query.after !== undefined;
    const field = query.afterRevision !== undefined ? 'revision' : 'sequence';
    const rows: MessageRow[] = await manager.query(
      `SELECT ${messageColumns} FROM group_chat_messages m ${messageSenderJoins} WHERE m.room_id=$1 ${cursor !== undefined ? `AND m.${field} ${ascending ? '>' : '<'} $3::bigint` : ''} ORDER BY m.${field} ${ascending ? 'ASC' : 'DESC'} LIMIT $2`,
      [roomId, limit + 1, ...(cursor !== undefined ? [cursor] : [])],
    );
    const messages = rows.slice(0, limit).map(messageDto),
      hasMore = rows.length > limit;
    const revision =
      query.afterRevision !== undefined && hasMore
        ? messages.at(-1)!.revision
        : await this.roomRevision(manager, roomId);
    if (!ascending) messages.reverse();
    return { messages, hasMore, revision };
  }

  createA2aMember(
    userId: string,
    roomId: string,
    input: GroupChatA2AMemberInput,
  ) {
    return this.a2aKeys.create(userId, roomId, input);
  }

  updateA2aMember(
    userId: string,
    roomId: string,
    memberId: string,
    input: GroupChatA2AMemberUpdate,
  ) {
    return this.a2aKeys.update(userId, roomId, memberId, input);
  }

  revokeA2aMember(userId: string, roomId: string, memberId: string) {
    return this.a2aKeys.revoke(userId, roomId, memberId);
  }

  removeA2aMember(userId: string, roomId: string, memberId: string) {
    return this.a2aKeys.remove(userId, roomId, memberId);
  }

  authenticateA2a(roomId: string, apiKey: string) {
    return this.database.transaction(async (manager) => {
      const { member, room } = await this.a2aKeys.authenticate(
        manager,
        roomId,
        apiKey,
      );
      return { member, room };
    });
  }

  messagesA2a(
    roomId: string,
    apiKey: string,
    query: {
      before?: string;
      after?: string;
      afterRevision?: string;
      limit: number;
    },
  ): Promise<GroupChatMessages> {
    return this.database.transaction(async (manager) => {
      await this.a2aKeys.authenticate(manager, roomId, apiKey);
      return this.readMessages(manager, roomId, query);
    });
  }

  sendA2a(
    roomId: string,
    apiKey: string,
    input: { id: string; text: string; replyToId?: string },
  ): Promise<GroupChatMessage> {
    const body = groupChatMessageSchema.omit({ files: true }).parse(input);
    return this.database.transaction(async (manager) => {
      const { member, actorId } = await this.a2aKeys.authenticate(
        manager,
        roomId,
        apiKey,
      );
      const result = await this.insertMessage(
        manager,
        roomId,
        member.id,
        'a2a',
        body,
      );
      if (result.created) {
        const recipients = await this.wakeMentionedAgents(
          manager,
          actorId,
          result.message,
        );
        if (!recipients.some((agent) => agent.role === 'bot'))
          await this.wakeBot(manager, roomId, actorId);
      }
      return result.message;
    });
  }

  private async readMessage(
    manager: EntityManager,
    roomId: string,
    id: string,
  ) {
    const rows: MessageRow[] = await manager.query(
      `SELECT ${messageColumns} FROM group_chat_messages m ${messageSenderJoins} WHERE m.room_id=$1 AND m.id=$2`,
      [roomId, id],
    );
    if (!rows[0]) throw new ORPCError('NOT_FOUND');
    return messageDto(rows[0]);
  }

  private async agentInRoom(
    manager: EntityManager,
    roomId: string,
    memberId: string,
    requireEnabled = false,
  ) {
    const agents: GroupChatAgent[] = await manager.query(
      `SELECT ${agentColumns} FROM group_chat_agents WHERE room_id=$1 AND id=$2 AND NOT deleting`,
      [roomId, memberId],
    );
    if (!agents[0]) throw new ORPCError('NOT_FOUND');
    if (requireEnabled && !agents[0].enabled)
      throw new ORPCError('CONFLICT', { message: 'Agent is disabled' });
    return agents[0];
  }

  async getAgent(
    userId: string,
    roomId: string,
    memberId: string,
  ): Promise<GroupChatAgent> {
    await this.access(userId, roomId);
    return this.agentInRoom(this.database.manager, roomId, memberId);
  }

  private async wakeBot(
    manager: EntityManager,
    roomId: string,
    userId: string,
  ) {
    await this.ensureBot(manager, roomId);
    await manager.query(
      `INSERT INTO group_chat_events(id,version,room_id,agent_id,actor_id,kind,text,due_at)
      SELECT $1,$2,$3,id,$4,'messages','New room messages. Call get_room_recent_messages to read them.',now()+interval '30 seconds' FROM group_chat_agents WHERE room_id=$3 AND role='bot'
      ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,actor_id=EXCLUDED.actor_id,due_at=EXCLUDED.due_at,status='pending',error=NULL,lease_until=NULL,completed_at=NULL,attempts=0`,
      [`messages:${roomId}`, nanoid(), roomId, userId],
    );
  }

  private async insertMessage(
    manager: EntityManager,
    roomId: string,
    senderId: string,
    senderKind: GroupChatMessage['senderKind'],
    input: AgentRoomMessageInput & {
      uiResponse?: GroupChatMessage['uiResponse'];
    },
  ) {
    const body = {
      text: input.text.trim(),
      replyToId: input.replyToId ?? null,
      files: input.files ?? [],
      ui: input.ui ?? null,
      uiResponse: input.uiResponse ?? null,
      targetAgentId: input.targetAgentId ?? null,
    };
    if (!body.text || body.text.length > 20_000)
      throw new ORPCError('BAD_REQUEST');
    const previous: MessageRow[] = await manager.query(
      `SELECT ${messageColumns} FROM group_chat_messages m ${messageSenderJoins} WHERE m.room_id=$1 AND m.id=$2`,
      [roomId, input.id],
    );
    if (previous[0]) {
      const same =
        previous[0].senderId === senderId &&
        previous[0].senderKind === senderKind &&
        Object.entries(body).every(([key, value]) =>
          isDeepStrictEqual(previous[0][key as keyof MessageRow], value),
        );
      if (!same) throw new ORPCError('CONFLICT');
      return { message: messageDto(previous[0]), created: false };
    }
    if (body.replyToId) await this.readMessage(manager, roomId, body.replyToId);
    if (body.targetAgentId)
      await this.agentInRoom(manager, roomId, body.targetAgentId, true);
    const search = messageSearchTerms(
      [
        body.text,
        body.ui?.title,
        body.ui?.tips,
        ...body.files.map((file) => file.name),
      ]
        .filter(Boolean)
        .join(' '),
    );
    await manager.query(
      `INSERT INTO group_chat_messages(room_id,id,sender_id,sender_kind,text,reply_to_id,files,ui,ui_response,target_agent_id,search_terms,token_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        roomId,
        input.id,
        senderId,
        senderKind,
        body.text,
        body.replyToId,
        JSON.stringify(body.files),
        body.ui ? JSON.stringify(body.ui) : null,
        body.uiResponse ? JSON.stringify(body.uiResponse) : null,
        body.targetAgentId,
        JSON.stringify(search.terms),
        search.count,
      ],
    );
    await manager.query('UPDATE group_chats SET updated_at=now() WHERE id=$1', [
      roomId,
    ]);
    return {
      message: await this.readMessage(manager, roomId, input.id),
      created: true,
    };
  }

  private async wakeMentionedAgents(
    manager: EntityManager,
    userId: string,
    message: GroupChatMessage,
    legacyTarget?: string,
  ) {
    if (!message.text.includes('@') && !legacyTarget) return [];
    const agents: GroupChatAgent[] = await manager.query(
      `SELECT ${agentColumns} FROM group_chat_agents WHERE room_id=$1 AND NOT deleting`,
      [message.roomId],
    );
    const a2aMembers = (
      await this.a2aKeys.list(manager, message.roomId)
    ).filter((member) => !member.revokedAt);
    const targets = new Set(
      mentionedRoomAgentIds(message.text, [...agents, ...a2aMembers]),
    );
    if (legacyTarget) targets.add(legacyTarget);
    const recipients = agents.filter(
      (agent) =>
        targets.has(agent.id) &&
        agent.enabled &&
        !(message.senderKind === 'agent' && agent.id === message.senderId),
    );
    for (const agent of recipients) {
      await manager.query(
        `INSERT INTO group_chat_events(id,version,room_id,agent_id,actor_id,kind,text,due_at) VALUES($1,$2,$3,$4,$5,'task',$6,now()) ON CONFLICT(id) DO NOTHING`,
        [
          `mention:${message.id}:${agent.id}`,
          nanoid(),
          message.roomId,
          agent.id,
          userId,
          `Room message ${message.id} from ${message.senderKind} ${message.senderName || message.senderUsername || message.senderId} (${message.senderId}):\n${message.text}`,
        ],
      );
    }
    return recipients;
  }

  async send(
    userId: string,
    roomId: string,
    input: {
      id: string;
      text: string;
      replyToId?: string;
      files?: GroupChatFile[];
    },
  ): Promise<GroupChatMessage> {
    const parsed = groupChatMessageSchema.parse(input);
    if (parsed.files?.length) {
      const room = await this.get(userId, roomId);
      const bot = room.agents.find((agent) => agent.id === room.botAgentId)!;
      if (!this.lifecycle?.validateFiles)
        throw new ORPCError('CONFLICT', {
          message: 'Room file delivery is unavailable',
        });
      await this.lifecycle.validateFiles(userId, bot, parsed.files);
    }
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      const result = await this.insertMessage(
        manager,
        roomId,
        userId,
        'user',
        parsed,
      );
      if (result.created) {
        const recipients = await this.wakeMentionedAgents(
          manager,
          userId,
          result.message,
        );
        if (!recipients.some((agent) => agent.role === 'bot'))
          await this.wakeBot(manager, roomId, userId);
      }
      return result.message;
    });
  }

  async sendAgent(
    userId: string,
    roomId: string,
    memberId: string,
    input: AgentRoomMessageInput,
  ): Promise<GroupChatMessage> {
    groupChatMessageSchema.parse(input);
    const agent = await this.getAgent(userId, roomId, memberId);
    if (input.ui) input = { ...input, ui: groupChatUiSchema.parse(input.ui) };
    if (input.files?.length) {
      if (!this.lifecycle?.validateFiles)
        throw new ORPCError('CONFLICT', {
          message: 'Room file delivery is unavailable',
        });
      await this.lifecycle.validateFiles(userId, agent, input.files);
    }
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      await this.agentInRoom(manager, roomId, memberId, true);
      if (input.targetAgentId === memberId)
        throw new ORPCError('BAD_REQUEST', {
          message: 'Cannot delegate a task to yourself',
        });
      const result = await this.insertMessage(
        manager,
        roomId,
        memberId,
        'agent',
        input,
      );
      if (result.created)
        await this.wakeMentionedAgents(
          manager,
          userId,
          result.message,
          input.targetAgentId,
        );
      return result.message;
    });
  }

  async react(
    userId: string,
    roomId: string,
    messageId: string,
    input: { emoji: string; active: boolean },
    agentMemberId?: string,
  ): Promise<GroupChatMessage> {
    const parsed = groupChatReactionSchema.parse(input);
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      if (agentMemberId)
        await this.agentInRoom(manager, roomId, agentMemberId, true);
      await this.readMessage(manager, roomId, messageId);
      if (parsed.active)
        await manager.query(
          `INSERT INTO group_chat_reactions(room_id,message_id,member_id,emoji) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [roomId, messageId, agentMemberId ?? userId, parsed.emoji],
        );
      else
        await manager.query(
          `DELETE FROM group_chat_reactions WHERE room_id=$1 AND message_id=$2 AND member_id=$3 AND emoji=$4`,
          [roomId, messageId, agentMemberId ?? userId, parsed.emoji],
        );
      await manager.query(
        `UPDATE group_chat_messages SET revision=nextval(pg_get_serial_sequence('group_chat_messages','revision')) WHERE room_id=$1 AND id=$2`,
        [roomId, messageId],
      );
      return this.readMessage(manager, roomId, messageId);
    });
  }

  async respondUi(
    userId: string,
    roomId: string,
    messageId: string,
    input: Parameters<typeof groupChatUiResponseSchema.parse>[0],
  ): Promise<GroupChatMessage> {
    const parsed = groupChatUiResponseSchema.parse(input);
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      const source = await this.readMessage(manager, roomId, messageId);
      if (!source.ui) throw new ORPCError('BAD_REQUEST');
      const result = await this.insertMessage(manager, roomId, userId, 'user', {
        id: parsed.id,
        text: `${source.ui.title ?? 'UI'}: ${JSON.stringify(parsed.data)}`.slice(
          0,
          20_000,
        ),
        replyToId: messageId,
        uiResponse: { sourceMessageId: messageId, data: parsed.data },
      });
      if (result.created) await this.wakeBot(manager, roomId, userId);
      return result.message;
    });
  }

  async recentMessages(
    userId: string,
    roomId: string,
    memberId: string,
    limit = 50,
  ): Promise<GroupChatMessages> {
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      const agent = await this.agentInRoom(manager, roomId, memberId, true);
      const take = boundedLimit(limit);
      const rows: MessageRow[] = await manager.query(
        `SELECT ${messageColumns} FROM group_chat_messages m ${messageSenderJoins} WHERE m.room_id=$1 AND m.sequence>$2::bigint AND NOT(m.sender_kind='agent' AND m.sender_id=$3) ORDER BY m.sequence LIMIT $4`,
        [roomId, agent.lastReadSequence, memberId, take + 1],
      );
      const messages = rows.slice(0, take).map(messageDto);
      if (messages.length)
        await manager.query(
          `UPDATE group_chat_agents SET last_read_sequence=$2::bigint WHERE id=$1`,
          [memberId, messages.at(-1)!.sequence],
        );
      return {
        messages,
        hasMore: rows.length > take,
        revision: await this.roomRevision(manager, roomId),
      };
    });
  }

  async addAgent(
    userId: string,
    roomId: string,
    input: GroupChatAgentInput,
  ): Promise<GroupChatAgent> {
    const parsed = groupChatAgentCreateSchema.parse(input),
      access = await this.access(userId, roomId);
    if (!access.canManage) throw new ORPCError('FORBIDDEN');
    await this.lifecycle?.validateAgent?.(
      userId,
      roomDto(access.room),
      parsed.settings,
      'worker',
    );
    const agent = await this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true)).canManage)
        throw new ORPCError('FORBIDDEN');
      const rows: GroupChatAgent[] = await manager.query(
        `INSERT INTO group_chat_agents(id,room_id,thread_id,name,role,settings,enabled) VALUES($1,$2,$3,$4,'worker',$5,$6) RETURNING ${agentColumns}`,
        [
          nanoid(16),
          roomId,
          nanoid(16),
          parsed.name,
          JSON.stringify(parsed.settings),
          parsed.enabled ?? true,
        ],
      );
      return rows[0];
    });
    await this.lifecycleLocked(roomId, async () => {
      await this.access(userId, roomId);
      await this.agentInRoom(this.database.manager, roomId, agent.id);
      await this.lifecycle?.ensureAgent(roomDto(access.room), agent);
    });
    return agent;
  }

  async updateAgent(
    userId: string,
    roomId: string,
    memberId: string,
    input: GroupChatAgentUpdate,
  ): Promise<GroupChatAgent> {
    const parsed = groupChatAgentUpdateSchema.parse(input),
      access = await this.access(userId, roomId);
    if (!access.canManage) throw new ORPCError('FORBIDDEN');
    if (parsed.settings)
      await this.lifecycle?.validateAgent?.(
        userId,
        roomDto(access.room),
        parsed.settings,
        (await this.agentInRoom(this.database.manager, roomId, memberId)).role,
      );
    const { previous, next } = await this.database.transaction(
      async (manager) => {
        if (!(await this.access(userId, roomId, manager, true)).canManage)
          throw new ORPCError('FORBIDDEN');
        const previous = await this.agentInRoom(manager, roomId, memberId);
        if (
          previous.role === 'bot' &&
          (parsed.name !== undefined ||
            parsed.enabled !== undefined ||
            (!parsed.settings && parsed.idleWakeHours === undefined) ||
            (parsed.settings &&
              (parsed.settings.agentId ?? null) !==
                (previous.settings.agentId ?? null)))
        )
          throw new ORPCError('FORBIDDEN', {
            message:
              'Only the bot model, reasoning effort and idle wake interval can be changed',
          });
        if (previous.role !== 'bot' && parsed.idleWakeHours !== undefined)
          throw new ORPCError('BAD_REQUEST', {
            message: 'Idle wake-up is only available for the bot',
          });
        const idleWakeHours =
          parsed.idleWakeHours === undefined
            ? previous.idleWakeHours
            : parsed.idleWakeHours;
        const rows: GroupChatAgent[] = await manager.query(
          `WITH updated AS (UPDATE group_chat_agents SET name=$3,settings=$4,enabled=$5,error=NULL,
            idle_since=CASE WHEN idle_wake_hours IS DISTINCT FROM $6::double precision AND status<>'running' THEN now() ELSE idle_since END,
            idle_wake_hours=$6 WHERE room_id=$1 AND id=$2 RETURNING ${agentColumns}) SELECT * FROM updated`,
          [
            roomId,
            memberId,
            parsed.name ?? previous.name,
            JSON.stringify(parsed.settings ?? previous.settings),
            parsed.enabled ?? previous.enabled,
            idleWakeHours,
          ],
        );
        if (idleWakeHours !== previous.idleWakeHours)
          await manager.query(
            `UPDATE group_chat_events SET status='cancelled',completed_at=now(),lease_until=NULL
            WHERE agent_id=$1 AND kind='idle' AND status='pending' AND (lease_until IS NULL OR lease_until<now())`,
            [memberId],
          );
        return { previous, next: rows[0] };
      },
    );
    await this.lifecycleLocked(roomId, async () => {
      await this.access(userId, roomId);
      const current = await this.agentInRoom(
        this.database.manager,
        roomId,
        memberId,
      );
      await this.lifecycle?.updateAgent?.(
        roomDto(access.room),
        previous,
        current,
      );
    });
    return next;
  }

  async removeAgent(
    userId: string,
    roomId: string,
    memberId: string,
  ): Promise<void> {
    const { room, agent } = await this.database.transaction(async (manager) => {
      const access = await this.access(userId, roomId, manager, true);
      if (!access.canManage) throw new ORPCError('FORBIDDEN');
      const agents: GroupChatAgent[] = await manager.query(
        `SELECT ${agentColumns} FROM group_chat_agents WHERE room_id=$1 AND id=$2`,
        [roomId, memberId],
      );
      const agent = agents[0];
      if (!agent) throw new ORPCError('NOT_FOUND');
      if (agent.role === 'bot')
        throw new ORPCError('CONFLICT', {
          message: 'The room must retain its bot',
        });
      await manager.query(
        'UPDATE group_chat_agents SET enabled=false,deleting=true WHERE id=$1',
        [memberId],
      );
      return { room: roomDto(access.room), agent };
    });
    await this.lifecycleLocked(roomId, async () => {
      await this.lifecycle?.removeAgents?.(room, [agent]);
    });
    await this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true)).canManage)
        throw new ORPCError('FORBIDDEN');
      await manager.query(
        `DELETE FROM group_chat_agents WHERE room_id=$1 AND id=$2 AND role='worker'`,
        [roomId, memberId],
      );
    });
  }

  async setAgentStatus(
    memberId: string,
    status: GroupChatAgent['status'],
    error: string | null = null,
  ): Promise<void> {
    await this.database.query(
      `UPDATE group_chat_agents SET status=$2,error=$3,
        idle_since=CASE WHEN $2='running' THEN NULL WHEN status='running' OR idle_since IS NULL THEN now() ELSE idle_since END WHERE id=$1`,
      [memberId, status, error],
    );
  }

  async createPlan(
    userId: string,
    roomId: string,
    memberId: string,
    input: { id?: string; text: string; runAt: string },
  ): Promise<GroupChatEvent> {
    const time = new Date(input.runAt),
      text = input.text.trim();
    if (!Number.isFinite(time.getTime()) || !text || text.length > 20_000)
      throw new ORPCError('BAD_REQUEST', {
        message: 'Provide a future runAt and a non-empty plan',
      });
    return this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      await this.agentInRoom(manager, roomId, memberId, true);
      const id = input.id ?? nanoid(16);
      const previous: (Omit<GroupChatEvent, 'dueAt'> & { dueAt: Date })[] =
        await manager.query(
          `SELECT ${eventColumns} FROM group_chat_events WHERE id=$1`,
          [id],
        );
      if (previous[0]) {
        if (
          previous[0].roomId !== roomId ||
          previous[0].agentId !== memberId ||
          previous[0].actorId !== userId ||
          previous[0].kind !== 'plan' ||
          previous[0].text !== text ||
          previous[0].dueAt.getTime() !== time.getTime()
        )
          throw new ORPCError('CONFLICT');
        return eventDto(previous[0]);
      }
      if (time.getTime() <= Date.now())
        throw new ORPCError('BAD_REQUEST', {
          message: 'Provide a future runAt',
        });
      const rows: (Omit<GroupChatEvent, 'dueAt'> & { dueAt: Date })[] =
        await manager.query(
          `INSERT INTO group_chat_events(id,version,room_id,agent_id,actor_id,kind,text,due_at) VALUES($1,$2,$3,$4,$5,'plan',$6,$7) RETURNING ${eventColumns}`,
          [id, nanoid(), roomId, memberId, userId, text, time],
        );
      return eventDto(rows[0]);
    });
  }

  async plans(userId: string, roomId: string): Promise<GroupChatEvent[]> {
    await this.access(userId, roomId);
    const rows: (Omit<GroupChatEvent, 'dueAt'> & { dueAt: Date })[] =
      await this.database.query(
        `SELECT ${eventColumns} FROM group_chat_events WHERE room_id=$1 AND kind='plan' ORDER BY created_at DESC LIMIT 100`,
        [roomId],
      );
    return rows.map(eventDto);
  }

  async cancelPlan(
    userId: string,
    roomId: string,
    eventId: string,
  ): Promise<void> {
    await this.database.transaction(async (manager) => {
      if (!(await this.access(userId, roomId, manager, true)).canManage)
        throw new ORPCError('FORBIDDEN');
      const rows = await manager.query(
        `WITH updated AS (UPDATE group_chat_events SET status='cancelled',completed_at=now(),lease_until=NULL WHERE id=$1 AND room_id=$2 AND kind='plan' AND status='pending' RETURNING id) SELECT * FROM updated`,
        [eventId, roomId],
      );
      if (!rows.length) throw new ORPCError('NOT_FOUND');
    });
  }

  async dueEvents(limit = 50): Promise<GroupChatEvent[]> {
    const rows: (Omit<GroupChatEvent, 'dueAt'> & { dueAt: Date })[] =
      await this.database.query(
        `SELECT ${eventColumns
          .split(',')
          .map((part) => `e.${part}`)
          .join(
            ',',
          )} FROM group_chat_events e WHERE e.status='pending' AND e.due_at<=now() AND (e.lease_until IS NULL OR e.lease_until<now()) AND EXISTS(SELECT 1 FROM group_chat_agents a WHERE a.id=e.agent_id AND a.enabled AND NOT a.deleting) ORDER BY e.due_at,e.id LIMIT $1`,
        [boundedLimit(limit)],
      );
    return rows.map(eventDto);
  }

  /** One durable wake-up per idle period, with room locks shared by messages/plans/settings. */
  async scheduleIdleEvents(limit = 50): Promise<void> {
    await this.database.query(
      `WITH candidates AS (
        SELECT a.id,a.room_id,r.created_by FROM group_chat_agents a JOIN group_chats r ON r.id=a.room_id
        WHERE ${idleAgentReady}
        AND NOT EXISTS(SELECT 1 FROM group_chat_events previous WHERE previous.id='idle:'||a.id
          AND (previous.status='pending' OR (previous.status IN ('completed','failed') AND previous.created_at>=a.idle_since)))
        ORDER BY a.idle_since,a.id LIMIT $1 FOR UPDATE OF r,a SKIP LOCKED
      ) INSERT INTO group_chat_events(id,version,room_id,agent_id,actor_id,kind,text,due_at)
        SELECT 'idle:'||id,$2,room_id,id,created_by,'idle','Look for useful work after a period of inactivity.',now() FROM candidates
        ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,actor_id=EXCLUDED.actor_id,due_at=EXCLUDED.due_at,
          status='pending',error=NULL,lease_until=NULL,completed_at=NULL,attempts=0,created_at=now()
        WHERE group_chat_events.status<>'pending'`,
      [boundedLimit(limit), nanoid()],
    );
  }

  async claimEvent(id: string, version: string): Promise<boolean> {
    return this.database.transaction(async (manager) => {
      // Serialize with future_plan creation and configuration changes before claiming.
      await manager.query(
        `SELECT r.id FROM group_chats r JOIN group_chat_events e ON e.room_id=r.id WHERE e.id=$1 AND e.version=$2 FOR UPDATE OF r`,
        [id, version],
      );
      const ready = `EXISTS(SELECT 1 FROM group_chat_agents a WHERE a.id=e.agent_id AND ${idleAgentReady} AND a.idle_since<=e.created_at)`;
      await manager.query(
        `UPDATE group_chat_events e SET status='cancelled',completed_at=now(),lease_until=NULL
        WHERE e.id=$1 AND e.version=$2 AND e.kind='idle' AND e.status='pending' AND (e.lease_until IS NULL OR e.lease_until<now()) AND NOT (${ready})`,
        [id, version],
      );
      const rows = await manager.query(
        `WITH updated AS (UPDATE group_chat_events e SET lease_until=now()+interval '60 seconds'
          WHERE e.id=$1 AND e.version=$2 AND e.status='pending' AND e.due_at<=now() AND (e.lease_until IS NULL OR e.lease_until<now())
          AND EXISTS(SELECT 1 FROM group_chat_agents a WHERE a.id=e.agent_id AND a.enabled AND NOT a.deleting)
          AND (e.kind<>'idle' OR ${ready}) RETURNING e.id) SELECT * FROM updated`,
        [id, version],
      );
      return rows.length > 0;
    });
  }

  async acknowledgeEvent(id: string, version: string): Promise<void> {
    await this.database.query(
      `UPDATE group_chat_events SET status='completed',completed_at=now(),lease_until=NULL,error=NULL WHERE id=$1 AND version=$2 AND status='pending'`,
      [id, version],
    );
  }

  async deferEvent(
    id: string,
    version: string,
    error?: string,
    delayMs = 60_000,
  ): Promise<void> {
    await this.database.query(
      `UPDATE group_chat_events SET lease_until=now()+($4*interval '1 millisecond'),error=$3,attempts=attempts+CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END,status=CASE WHEN $3::text IS NOT NULL AND attempts>=2 THEN 'failed' ELSE 'pending' END WHERE id=$1 AND version=$2 AND status='pending'`,
      [id, version, error ?? null, Math.max(1000, delayMs)],
    );
  }

  /** BM25 (k1=1.2,b=0.75), indexed term candidates and room-local document statistics. */
  async search(
    userId: string,
    roomId: string,
    input: { query?: string; reactions?: string[]; limit: number },
  ): Promise<GroupChatSearch> {
    await this.access(userId, roomId);
    const queryTerms = Object.keys(messageSearchTerms(input.query ?? '').terms);
    const reactions = [
      ...new Set(
        groupChatReactionSchema.shape.emoji
          .array()
          .max(20)
          .parse(input.reactions ?? []),
      ),
    ];
    const limit = boundedLimit(input.limit);
    if (!queryTerms.length) {
      if (!reactions.length) return { messages: [], hasMore: false };
      const rows: MessageRow[] = await this.database.query(
        `SELECT ${messageColumns} FROM group_chat_messages m ${messageSenderJoins} WHERE m.room_id=$1
          AND EXISTS(SELECT 1 FROM group_chat_reactions r WHERE r.room_id=m.room_id AND r.message_id=m.id AND r.emoji=ANY($2::text[]))
          ORDER BY m.sequence DESC LIMIT $3`,
        [roomId, reactions, limit + 1],
      );
      return {
        messages: rows
          .slice(0, limit)
          .map((row) => ({ ...messageDto(row), score: 0 })),
        hasMore: rows.length > limit,
      };
    }
    // Existing room history predates tokenization. Backfill it once without changing visible revisions.
    await this.database.transaction(async (manager) => {
      await this.access(userId, roomId, manager, true);
      const old: { id: string; text: string }[] = await manager.query(
        `SELECT id,text FROM group_chat_messages WHERE room_id=$1 AND search_terms='{}'::jsonb AND token_count=0`,
        [roomId],
      );
      for (const row of old) {
        const search = messageSearchTerms(row.text);
        await manager.query(
          `UPDATE group_chat_messages SET search_terms=$3,token_count=$4 WHERE room_id=$1 AND id=$2`,
          [roomId, row.id, JSON.stringify(search.terms), search.count || -1],
        );
      }
    });
    const rows: (MessageRow & { score: number })[] = await this.database.query(
      `WITH corpus AS (
      SELECT count(*)::float8 AS n, greatest(avg(greatest(token_count,0)),1)::float8 AS avgdl FROM group_chat_messages WHERE room_id=$1
    ), frequencies AS (
      SELECT term,count(m.id)::float8 AS df FROM unnest($2::text[]) term JOIN group_chat_messages m ON m.room_id=$1 AND m.search_terms ? term GROUP BY term
    ), ranked AS (
      SELECT m.id,sum(ln(1+(corpus.n-f.df+0.5)/(f.df+0.5))*(((m.search_terms->>f.term)::float8*2.2)/((m.search_terms->>f.term)::float8+1.2*(0.25+0.75*m.token_count/corpus.avgdl))))::float8 AS score
      FROM group_chat_messages m CROSS JOIN corpus JOIN frequencies f ON m.search_terms ? f.term
      WHERE m.room_id=$1 AND m.search_terms ?| $2::text[]
        AND ($4::text[] IS NULL OR EXISTS(SELECT 1 FROM group_chat_reactions r WHERE r.room_id=m.room_id AND r.message_id=m.id AND r.emoji=ANY($4::text[])))
      GROUP BY m.id ORDER BY score DESC,m.id LIMIT $3
    ) SELECT ${messageColumns},ranked.score FROM ranked JOIN group_chat_messages m ON m.id=ranked.id AND m.room_id=$1 ${messageSenderJoins} ORDER BY ranked.score DESC,m.sequence DESC`,
      [roomId, queryTerms, limit + 1, reactions.length ? reactions : null],
    );
    return {
      messages: rows
        .slice(0, limit)
        .map((row) => ({ ...messageDto(row), score: row.score })),
      hasMore: rows.length > limit,
    };
  }
}
