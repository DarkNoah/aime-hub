import { nanoid } from 'nanoid';
import { ORPCError } from '@orpc/server';
import type { DataSource } from 'typeorm';
import { chatSettingsSchema, type ThreadStatus } from '@aime/shared/threads';
import {
  issueCreateSchema,
  issuePatchSchema,
  issueListSchema,
  issueCommentSchema,
  issueMessageSchema,
  type Issue,
  type IssueScope,
  type IssueCreate,
  type IssuePatch,
  type IssueListInput,
  type IssueList,
  type IssueDetail,
  type IssueComment,
  type IssueState,
} from '@aime/shared/issues';
import type { ProjectService } from '../projects/service.js';
import type { ThreadService } from '../threads/service.js';

const columns = `id,title,body,state,project_id AS "projectId",created_by AS "createdBy",thread_id AS "threadId",created_at AS "createdAt",updated_at AS "updatedAt",closed_at AS "closedAt",
  (SELECT json_build_object('roomId',a.room_id,'agentId',a.id,'threadId',a.thread_id)
   FROM group_chat_agents a JOIN group_chats r ON r.id=a.room_id
   WHERE a.thread_id=source_thread_id AND NOT a.deleting AND NOT r.deleting) AS source`;
type Row = Omit<Issue, 'createdAt' | 'updatedAt' | 'closedAt'> & {
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};
const dto = (row: Row): Issue => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  closedAt: row.closedAt?.toISOString() ?? null,
});
type CommentRow = Omit<IssueComment, 'createdAt'> & {
  createdAt: Date;
  sequence: string;
};
const commentColumns = `c.id,c.issue_id AS "issueId",c.author_id AS "authorId",u.name AS "authorName",c.body,c.kind,c.delivery,c.created_at AS "createdAt",c.sequence::text`;
const commentDto = (row: CommentRow): IssueComment => ({
  id: row.id,
  issueId: row.issueId,
  authorId: row.authorId,
  authorName: row.authorName,
  body: row.body,
  kind: row.kind,
  delivery: row.delivery,
  createdAt: row.createdAt.toISOString(),
});

export class IssueService {
  private locks = new Map<number, Promise<unknown>>();
  constructor(
    private database: DataSource,
    private projects: Pick<ProjectService, 'assertMember' | 'get'>,
    private threads: Pick<
      ThreadService,
      | 'createIssueThread'
      | 'discardIssueThread'
      | 'getThread'
      | 'getIssueSourceThread'
      | 'run'
      | 'stopIssueThread'
    >,
  ) {}

  private async authorize(userId: string, scope: IssueScope) {
    if (scope.projectId)
      await this.projects.assertMember(userId, scope.projectId);
  }
  private locked<T>(id: number, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    this.locks.set(id, next);
    void next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  async get(userId: string, id: number, scope: IssueScope): Promise<Issue> {
    await this.authorize(userId, scope);
    const [row]: Row[] = await this.database.query(
      `SELECT ${columns} FROM issues WHERE id=$1 AND (project_id=$2 OR ($2::text IS NULL AND project_id IS NULL AND created_by=$3))`,
      [id, scope.projectId ?? null, userId],
    );
    if (!row) throw new ORPCError('NOT_FOUND');
    return dto(row);
  }

  async forThread(
    userId: string,
    threadId: string,
    scope: IssueScope,
  ): Promise<Issue | null> {
    await this.authorize(userId, scope);
    const [row]: Row[] = await this.database.query(
      `SELECT ${columns} FROM issues WHERE thread_id=$1 AND (project_id=$2 OR ($2::text IS NULL AND project_id IS NULL AND created_by=$3))`,
      [threadId, scope.projectId ?? null, userId],
    );
    return row ? dto(row) : null;
  }

  async list(userId: string, raw: IssueListInput): Promise<IssueList> {
    const input = issueListSchema.parse(raw);
    await this.authorize(userId, input);
    const scope = `(project_id=$1 OR ($1::text IS NULL AND project_id IS NULL AND created_by=$2))`;
    const [rows, totals]: [Row[], { state: IssueState; count: string }[]] =
      await Promise.all([
        this.database.query(
          `SELECT ${columns} FROM issues WHERE ${scope} AND ($3='all' OR ($3='open' AND state<>'done') OR state=$3) AND ($4::int IS NULL OR id<$4) ORDER BY id DESC LIMIT $5`,
          [
            input.projectId ?? null,
            userId,
            input.state,
            input.cursor ?? null,
            input.limit + 1,
          ],
        ),
        this.database.query(
          `SELECT state,count(*)::text FROM issues WHERE ${scope} GROUP BY state`,
          [input.projectId ?? null, userId],
        ),
      ]);
    await this.authorize(userId, input);
    const counts = { decision: 0, todo: 0, in_progress: 0, done: 0 };
    for (const row of totals) counts[row.state] = Number(row.count);
    return {
      items: rows.slice(0, input.limit).map(dto),
      counts,
      nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
    };
  }

  async view(
    userId: string,
    id: number,
    scope: IssueScope,
    cursor?: string,
  ): Promise<IssueDetail> {
    const issue = await this.get(userId, id, scope);
    if (cursor && !/^\d+$/.test(cursor)) throw new ORPCError('BAD_REQUEST');
    const rows: CommentRow[] = await this.database.query(
      `SELECT ${commentColumns} FROM issue_comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.issue_id=$1 AND ($2::bigint IS NULL OR c.sequence<$2) ORDER BY c.sequence DESC LIMIT 51`,
      [id, cursor ?? null],
    );
    await this.authorize(userId, scope);
    return {
      issue,
      comments: rows.slice(0, 50).reverse().map(commentDto),
      nextCursor: rows.length > 50 ? rows[49]!.sequence : null,
    };
  }

  async create(
    userId: string,
    scope: IssueScope,
    raw: IssueCreate,
    signal?: AbortSignal,
    sourceThreadId?: string,
  ): Promise<Issue> {
    const data = issueCreateSchema.parse(raw);
    await this.authorize(userId, scope);
    const source = sourceThreadId
      ? await this.threads.getIssueSourceThread(
          userId,
          sourceThreadId,
          scope.projectId,
        )
      : null;
    const settings =
      data.settings ??
      (scope.projectId
        ? (await this.projects.get(userId, scope.projectId)).settings
        : chatSettingsSchema.parse({}));
    let threadId: string | undefined;
    let issueId: number | undefined;
    try {
      return await this.database.transaction(async (manager) => {
        signal?.throwIfAborted();
        const [{ id }] = await manager.query(
          `SELECT nextval(pg_get_serial_sequence('issues','id'))::int AS id`,
        );
        issueId = id;
        const thread = await this.threads.createIssueThread(
          userId,
          {
            ...settings,
            title: `#${id} ${data.title}`.slice(0, 120),
            projectId: scope.projectId,
          },
          id,
        );
        threadId = thread.id;
        signal?.throwIfAborted();
        await this.authorize(userId, scope);
        const [row]: Row[] = await manager.query(
          `INSERT INTO issues(id,project_id,created_by,thread_id,title,body,state,closed_at,source_thread_id) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='done' THEN now() END,$8) RETURNING ${columns}`,
          [
            id,
            scope.projectId ?? null,
            userId,
            thread.id,
            data.title,
            data.body,
            data.state,
            source,
          ],
        );
        return dto(row!);
      });
    } catch (error) {
      if (threadId && issueId)
        await this.threads
          .discardIssueThread(threadId, issueId)
          .catch(() => undefined);
      throw error;
    }
  }

  edit(userId: string, id: number, scope: IssueScope, raw: IssuePatch) {
    const patch = issuePatchSchema.parse(raw);
    return this.locked(id, async () => {
      await this.get(userId, id, scope);
      const [row]: Row[] = await this.database.query(
        `WITH updated AS (UPDATE issues SET title=COALESCE($2,title),body=COALESCE($3,body),state=COALESCE($4,state),closed_at=CASE WHEN $4='done' THEN COALESCE(closed_at,now()) WHEN $4 IS NOT NULL THEN NULL ELSE closed_at END,updated_at=now() WHERE id=$1 RETURNING ${columns}) SELECT * FROM updated`,
        [id, patch.title ?? null, patch.body ?? null, patch.state ?? null],
      );
      return dto(row!);
    });
  }

  comment(userId: string, id: number, scope: IssueScope, body: string) {
    body = issueCommentSchema.parse({ body }).body;
    return this.locked(id, async () => {
      await this.get(userId, id, scope);
      return this.addComment(userId, id, body, 'comment', null);
    });
  }

  private async addComment(
    userId: string,
    id: number,
    body: string,
    kind: 'comment' | 'message',
    delivery: 'wait' | 'immediate' | null,
    messageId = nanoid(16),
  ) {
    return this.database.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO issue_comments(id,issue_id,author_id,body,kind,delivery) VALUES ($1,$2,$3,$4,$5,$6)`,
        [messageId, id, userId, body, kind, delivery],
      );
      await manager.query('UPDATE issues SET updated_at=now() WHERE id=$1', [
        id,
      ]);
      const [row]: CommentRow[] = await manager.query(
        `SELECT ${commentColumns} FROM issue_comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.id=$1`,
        [messageId],
      );
      return commentDto(row!);
    });
  }

  message(
    userId: string,
    id: number,
    scope: IssueScope,
    body: string,
    delivery: 'wait' | 'immediate' = 'wait',
    signal?: AbortSignal,
  ) {
    const data = issueMessageSchema.parse({ body, delivery });
    return this.locked(id, async () => {
      const issue = await this.get(userId, id, scope);
      if (issue.state === 'done')
        throw new ORPCError('ISSUE_CLOSED', { status: 409 });
      signal?.throwIfAborted();
      const { thread } = await this.threads.getThread(userId, issue.threadId);
      signal?.throwIfAborted();
      const messageId = nanoid(16);
      // Native scheduling persists the input and handles immediate interruption.
      await this.threads.run(userId, issue.threadId, {
        id: messageId,
        parts: [{ type: 'text', text: data.body }],
        model: thread.model,
        agentId: thread.agentId,
        reasoningEffort: thread.reasoningEffort,
        isImmediate: data.delivery === 'immediate',
        createdBy: userId,
      });
      await this.addComment(
        userId,
        id,
        data.body,
        'message',
        data.delivery,
        messageId,
      );
      return this.get(userId, id, scope);
    });
  }

  stop(userId: string, id: number, scope: IssueScope) {
    return this.locked(id, async () => {
      const issue = await this.get(userId, id, scope);
      await this.threads.stopIssueThread(userId, issue.threadId);
      await this.database.query(
        `UPDATE issues SET state='todo',updated_at=now() WHERE id=$1 AND state<>'done'`,
        [id],
      );
      return this.get(userId, id, scope);
    });
  }

  /** Execution alone never proves the task is complete; completion is explicit. */
  async observeThread(id: number, status: ThreadStatus) {
    const next =
      status === 'running' || status === 'pending'
        ? 'in_progress'
        : status === 'suspended' ||
            status === 'failed' ||
            status === 'success' ||
            status === 'waiting' ||
            status === 'paused' ||
            status === 'tripwire' ||
            status === 'bailed'
          ? 'decision'
          : status === 'canceled'
            ? 'todo'
            : undefined;
    if (!next) return;
    await this.database.query(
      `UPDATE issues SET state=$2,updated_at=now() WHERE id=$1 AND state<>'done' AND state<>$2`,
      [id, next],
    );
  }
}
