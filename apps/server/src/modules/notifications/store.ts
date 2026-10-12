import type { Pool } from 'pg';
import type { AutomationScope } from '@aime/shared/automations';
import type {
  BrowserPushSubscription,
  TaskNotification,
} from '@aime/shared/notifications';

export type NotificationRecord = {
  ownerId: string;
  scope: AutomationScope;
  notification: TaskNotification;
};
export type PushRecipient = BrowserPushSubscription & {
  userId: string;
  sessionId: string;
};
export interface NotificationStore {
  put(record: NotificationRecord): Promise<boolean>;
  read(
    userId: string,
    after?: string,
  ): Promise<{
    items: { cursor: string; notification: TaskNotification }[];
    cursor: string;
    more: boolean;
  }>;
  get(userId: string, id: string): Promise<TaskNotification | undefined>;
  subscribe(
    userId: string,
    sessionId: string,
    subscription: BrowserPushSubscription,
  ): Promise<void>;
  unsubscribe(userId: string, endpoint: string): Promise<void>;
  recipients(id: string): Promise<PushRecipient[]>;
  removeExpired(endpoint: string, sessionId: string): Promise<void>;
}

// Evaluate current membership and role for both online and offline delivery.
const visible = `u.banned IS NOT TRUE AND (
  (n.scope = 'personal' AND n.owner_id = u.id) OR
  (n.scope = 'system' AND 'admin' = ANY(string_to_array(COALESCE(u.role, ''), ','))) OR
  (n.scope = 'project' AND EXISTS (
    SELECT 1 FROM project_members m JOIN projects p ON p.id = m.project_id
    WHERE m.user_id = u.id AND m.project_id = n.project_id
      AND m.deleted_at IS NULL AND p.deleted_at IS NULL
  ))
)`;

export class PgNotificationStore implements NotificationStore {
  constructor(private pool: Pick<Pool, 'query'>) {}
  async put({ ownerId, scope, notification }: NotificationRecord) {
    // Allocate cursors in commit order so concurrent runs cannot skip an event.
    const result = await this.pool.query(
      `WITH locked AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtext('automation_notifications'))
    ) INSERT INTO automation_notifications (id, owner_id, scope, project_id, payload)
      SELECT $1, $2, $3, $4, $5 FROM locked ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        notification.id,
        ownerId,
        scope.scope,
        scope.scope === 'project' ? scope.projectId : null,
        notification,
      ],
    );
    return result.rows.length > 0;
  }
  async read(userId: string, after?: string) {
    const watermark = (
      await this.pool.query(
        'SELECT COALESCE(MAX(sequence), 0)::text AS cursor FROM automation_notifications',
      )
    ).rows[0].cursor as string;
    if (after === undefined)
      return { items: [], cursor: watermark, more: false };
    const { rows } = await this.pool.query(
      `SELECT n.sequence::text AS cursor, n.payload AS notification
      FROM automation_notifications n JOIN users u ON u.id = $1
      WHERE n.sequence > $2::bigint AND n.sequence <= $3::bigint AND ${visible}
      ORDER BY n.sequence ASC LIMIT 100`,
      [userId, after, watermark],
    );
    const more = rows.length === 100;
    return {
      items: rows,
      cursor: more ? rows[rows.length - 1].cursor : watermark,
      more,
    };
  }
  async get(userId: string, id: string) {
    const { rows } = await this.pool.query(
      `SELECT n.payload FROM automation_notifications n
      JOIN users u ON u.id = $1 WHERE n.id = $2 AND ${visible}`,
      [userId, id],
    );
    return rows[0]?.payload as TaskNotification | undefined;
  }
  async subscribe(
    userId: string,
    sessionId: string,
    input: BrowserPushSubscription,
  ) {
    // An endpoint belongs to the account currently signed in on this browser.
    await this.pool.query(
      `INSERT INTO web_push_subscriptions (endpoint, user_id, session_id, keys, locale)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (endpoint) DO UPDATE
      SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
          keys = EXCLUDED.keys, locale = EXCLUDED.locale, updated_at = now()`,
      [input.endpoint, userId, sessionId, input.keys, input.locale],
    );
  }
  async unsubscribe(userId: string, endpoint: string) {
    await this.pool.query(
      'DELETE FROM web_push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [userId, endpoint],
    );
  }
  async recipients(id: string): Promise<PushRecipient[]> {
    const { rows } = await this.pool.query(
      `SELECT s.endpoint, s.keys, s.locale, s.user_id AS "userId", s.session_id AS "sessionId"
      FROM web_push_subscriptions s JOIN users u ON u.id = s.user_id
      JOIN sessions a ON a.id = s.session_id AND a.user_id = u.id AND a.expires_at > now()
      JOIN automation_notifications n ON n.id = $1 WHERE ${visible}`,
      [id],
    );
    return rows;
  }
  async removeExpired(endpoint: string, sessionId: string) {
    await this.pool.query(
      'DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND session_id = $2',
      [endpoint, sessionId],
    );
  }
}
