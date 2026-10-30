import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { ORPCError } from '@orpc/server';
import type { DataSource, EntityManager } from 'typeorm';
import {
  groupChatA2aMemberCreateSchema,
  groupChatA2aMemberUpdateSchema,
  type GroupChatA2AMember,
} from '@aime/shared/group-chats';

type MemberRow = Omit<
  GroupChatA2AMember,
  'createdAt' | 'lastUsedAt' | 'revokedAt'
> & {
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};
const columns = `id,room_id AS "roomId",name,enabled,key_prefix AS "keyPrefix",created_at AS "createdAt",last_used_at AS "lastUsedAt",revoked_at AS "revokedAt"`;
const dto = (row: MemberRow): GroupChatA2AMember => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});
const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
type Access = (
  userId: string,
  roomId: string,
  manager: EntityManager,
  lock: boolean,
) => Promise<{
  room: { id: string; title: string };
  canManageMembers: boolean;
}>;

/** Credentials authorize only one room; external identities never own local threads. */
export class GroupChatA2aKeys {
  constructor(
    private database: DataSource,
    private access: Access,
  ) {}

  async list(manager: EntityManager, roomId: string) {
    const rows: MemberRow[] = await manager.query(
      `SELECT ${columns} FROM group_chat_a2a_members WHERE room_id=$1 AND deleted_at IS NULL ORDER BY created_at,id`,
      [roomId],
    );
    return rows.map(dto);
  }

  private async manage(userId: string, roomId: string, manager: EntityManager) {
    if (!(await this.access(userId, roomId, manager, true)).canManageMembers)
      throw new ORPCError('FORBIDDEN');
  }

  async create(userId: string, roomId: string, input: { name: string }) {
    const body = groupChatA2aMemberCreateSchema.parse(input);
    return this.database.transaction(async (manager) => {
      await this.manage(userId, roomId, manager);
      const apiKey = `room_a2a_${randomBytes(32).toString('base64url')}`;
      const rows: MemberRow[] = await manager.query(
        `INSERT INTO group_chat_a2a_members(id,room_id,name,key_hash,key_prefix,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,
        [
          nanoid(16),
          roomId,
          body.name,
          keyHash(apiKey),
          apiKey.slice(0, 17),
          userId,
        ],
      );
      return { member: dto(rows[0]), apiKey };
    });
  }

  async update(
    userId: string,
    roomId: string,
    memberId: string,
    input: { name?: string; enabled?: boolean },
  ) {
    const body = groupChatA2aMemberUpdateSchema.parse(input);
    return this.database.transaction(async (manager) => {
      await this.manage(userId, roomId, manager);
      const previous: MemberRow[] = await manager.query(
        `SELECT ${columns} FROM group_chat_a2a_members WHERE room_id=$1 AND id=$2 AND deleted_at IS NULL`,
        [roomId, memberId],
      );
      if (!previous[0]) throw new ORPCError('NOT_FOUND');
      if (previous[0].revokedAt)
        throw new ORPCError('CONFLICT', {
          message: 'API key has been revoked',
        });
      const rows: MemberRow[] = await manager.query(
        `WITH updated AS (UPDATE group_chat_a2a_members SET name=COALESCE($3,name),enabled=COALESCE($4,enabled) WHERE room_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING ${columns}) SELECT * FROM updated`,
        [roomId, memberId, body.name ?? null, body.enabled ?? null],
      );
      return dto(rows[0]);
    });
  }

  async revoke(userId: string, roomId: string, memberId: string) {
    return this.database.transaction(async (manager) => {
      await this.manage(userId, roomId, manager);
      const rows: MemberRow[] = await manager.query(
        `WITH updated AS (UPDATE group_chat_a2a_members SET enabled=false,revoked_at=COALESCE(revoked_at,now()) WHERE room_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING ${columns}) SELECT * FROM updated`,
        [roomId, memberId],
      );
      if (!rows[0]) throw new ORPCError('NOT_FOUND');
      return dto(rows[0]);
    });
  }

  async remove(
    userId: string,
    roomId: string,
    memberId: string,
  ): Promise<void> {
    await this.database.transaction(async (manager) => {
      // The same room lock also protects reads and sends. Once deletion commits,
      // no further request or SSE page can authenticate this member.
      await this.manage(userId, roomId, manager);
      const rows: { id: string }[] = await manager.query(
        `WITH removed AS (UPDATE group_chat_a2a_members
          SET enabled=false,revoked_at=COALESCE(revoked_at,now()),deleted_at=COALESCE(deleted_at,now())
          WHERE room_id=$1 AND id=$2 RETURNING id) SELECT id FROM removed`,
        [roomId, memberId],
      );
      if (!rows[0]) throw new ORPCError('NOT_FOUND');
    });
  }

  /** Must run in the same transaction as reads/sends; room locks serialize revocation. */
  async authenticate(manager: EntityManager, roomId: string, apiKey: string) {
    if (!/^room_a2a_[A-Za-z0-9_-]{43}$/.test(apiKey))
      throw new ORPCError('UNAUTHORIZED');
    const rooms = await manager.query(
      'SELECT id FROM group_chats WHERE id=$1 AND NOT deleting FOR UPDATE',
      [roomId],
    );
    if (!rooms.length) throw new ORPCError('UNAUTHORIZED');
    const keys: (MemberRow & { createdBy: string })[] = await manager.query(
      `SELECT ${columns
        .split(',')
        .map((column) => `k.${column}`)
        .join(',')},k.created_by AS "createdBy" FROM group_chat_a2a_members k
       JOIN users u ON u.id=k.created_by
       WHERE k.room_id=$1 AND k.key_hash=$2 AND k.enabled AND k.revoked_at IS NULL AND k.deleted_at IS NULL AND NOT COALESCE(u.banned,false)
       FOR SHARE OF u`,
      [roomId, keyHash(apiKey)],
    );
    if (!keys[0]) throw new ORPCError('UNAUTHORIZED');
    let room: { id: string; title: string };
    try {
      const access = await this.access(
        keys[0].createdBy,
        roomId,
        manager,
        true,
      );
      if (!access.canManageMembers) throw new ORPCError('UNAUTHORIZED');
      room = { id: access.room.id, title: access.room.title };
    } catch (error) {
      if (
        error instanceof ORPCError &&
        ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)
      )
        throw new ORPCError('UNAUTHORIZED');
      throw error;
    }
    const { createdBy: actorId, ...memberRow } = keys[0];
    // Long-lived feeds poll frequently; usage metadata only needs minute precision.
    const rows: MemberRow[] =
      !memberRow.lastUsedAt ||
      Date.now() - memberRow.lastUsedAt.getTime() >= 60_000
        ? await manager.query(
            `WITH updated AS (UPDATE group_chat_a2a_members SET last_used_at=now() WHERE id=$1 RETURNING ${columns}) SELECT * FROM updated`,
            [memberRow.id],
          )
        : [memberRow];
    return { member: dto(rows[0]), room, actorId };
  }
}
