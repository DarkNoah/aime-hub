import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { QueryRunner } from 'typeorm';
import { createAuth, createAuthOptions } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { AddNotifications1780000008000 } from '../../../../../packages/db/src/migrations/1780000008000-add-notifications.js';
import { CreateProjectTables1780000002000 } from '../../../../../packages/db/src/migrations/1780000002000-create-project-tables.js';
import { PgNotificationStore, type NotificationRecord } from './store.js';
import { NotificationService } from './service.js';
import { notificationRoutes } from './routes.js';
import { createApp } from '../../app.js';

test(
  'real Postgres migration isolates scope, revoked membership, session expiry, endpoint reassignment and replay cursors',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `notification_test_${randomBytes(8).toString('hex')}`;
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.end();
      try {
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await root.end();
      }
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    const webOrigin = 'http://localhost:5173';
    const authConfig = {
      pool,
      secret: randomBytes(32).toString('hex'),
      baseURL: webOrigin,
      webOrigin,
      admins: 'admin',
    };
    await (await getMigrations(createAuthOptions(authConfig))).runMigrations();
    const auth = createAuth(authConfig);
    const runner = {
      query: (sql: string) => pool.query(sql),
    } as unknown as QueryRunner;
    await new CreateProjectTables1780000002000().up(runner);
    await new AddNotifications1780000008000().up(runner);
    const store = new PgNotificationStore(pool);
    const notifications = new NotificationService(store, {
      publicKey: 'public',
      async send() {},
    });
    const app = createApp(
      auth,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { service: notifications, webOrigin },
    );
    const accounts: Record<
      string,
      { id: string; sessionId: string; cookie: string }
    > = {};
    for (const name of ['alice', 'bob', 'admin']) {
      const password = randomBytes(24).toString('hex');
      const { user } = await auth.api.createUser({
        body: {
          name,
          email: `${name}@example.test`,
          password,
          role: name === 'admin' ? 'admin' : 'user',
          data: { username: name },
        },
      });
      const response = await auth.api.signInUsername({
        body: { username: name, password },
        asResponse: true,
      });
      const cookie = response.headers
        .getSetCookie()
        .map((item) => item.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      assert.ok(session);
      accounts[name] = { id: user.id, sessionId: session.session.id, cookie };
      await store.subscribe(user.id, session.session.id, {
        endpoint: `https://fcm.googleapis.com/${name}`,
        keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
        locale: 'en',
      });
    }
    const register = (
      cookie: string,
      origin: string,
      endpoint = 'https://fcm.googleapis.com/rpc',
    ) =>
      app.request('/api/rpc/notifications/subscribe', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          json: {
            endpoint,
            keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
            locale: 'en',
          },
        }),
      });
    assert.equal((await register('', webOrigin)).status, 401);
    assert.equal(
      (await register(accounts.alice.cookie, 'https://evil.test')).status,
      403,
    );
    assert.equal(
      (
        await register(
          accounts.alice.cookie,
          webOrigin,
          'https://127.0.0.1/private',
        )
      ).status,
      400,
    );
    assert.equal(
      (await register(accounts.alice.cookie, webOrigin)).status,
      200,
    );
    const registered = (
      await pool.query(
        'SELECT user_id, session_id FROM web_push_subscriptions WHERE endpoint = $1',
        ['https://fcm.googleapis.com/rpc'],
      )
    ).rows[0];
    assert.equal(registered.user_id, accounts.alice.id);
    assert.equal(registered.session_id, accounts.alice.sessionId);
    await store.unsubscribe(
      accounts.alice.id,
      'https://fcm.googleapis.com/rpc',
    );
    await pool.query(
      "INSERT INTO projects(id,name,created_by) VALUES ('project000000001','Project',$1)",
      [accounts.alice.id],
    );
    await pool.query(
      "INSERT INTO project_members(project_id,user_id,role) VALUES ('project000000001',$1,'owner'),('project000000001',$2,'member')",
      [accounts.alice.id, accounts.bob.id],
    );
    const record = (
      id: string,
      scope: NotificationRecord['scope'],
    ): NotificationRecord => ({
      ownerId: accounts.alice.id,
      scope,
      notification: {
        id,
        taskId: 'task',
        taskName: 'Test task',
        scope,
        status: 'succeeded',
        createdAt: new Date().toISOString(),
        url: '/automations',
      },
    });
    await store.put(record('personal', { scope: 'personal' }));
    await store.put(
      record('project', { scope: 'project', projectId: 'project000000001' }),
    );
    await store.put(record('system', { scope: 'system' }));
    assert.equal(
      await store.put(record('personal', { scope: 'personal' })),
      false,
    );
    const recipients = async (id: string) =>
      (await store.recipients(id)).map((item) => item.userId).sort();
    assert.deepEqual(await recipients('personal'), [accounts.alice.id]);
    assert.deepEqual(
      await recipients('project'),
      [accounts.alice.id, accounts.bob.id].sort(),
    );
    assert.deepEqual(await recipients('system'), [accounts.admin.id]);
    assert.deepEqual((await store.read(accounts.bob.id)).items, []);
    assert.deepEqual(
      (await store.read(accounts.bob.id, '0')).items.map(
        (item) => item.notification.id,
      ),
      ['project'],
    );
    assert.equal(await store.get(accounts.bob.id, 'personal'), undefined);
    const api = notificationRoutes(auth, new NotificationService(store));
    assert.equal((await api.request('/personal')).status, 401);
    assert.equal(
      (
        await api.request('/personal', {
          headers: { cookie: accounts.bob.cookie },
        })
      ).status,
      404,
    );
    const detail = await api.request('/personal', {
      headers: { cookie: accounts.alice.cookie },
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).userId, accounts.alice.id);
    assert.equal(
      (
        await api.request('/events?after=bad', {
          headers: { cookie: accounts.alice.cookie },
        })
      ).status,
      400,
    );
    await pool.query(
      'UPDATE project_members SET deleted_at = now() WHERE user_id = $1',
      [accounts.bob.id],
    );
    assert.equal(await store.get(accounts.bob.id, 'project'), undefined);
    assert.deepEqual(await recipients('project'), [accounts.alice.id]);
    await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [
      accounts.admin.id,
    ]);
    assert.deepEqual(await recipients('system'), []);
    await pool.query('UPDATE sessions SET expires_at = now() WHERE id = $1', [
      accounts.alice.sessionId,
    ]);
    assert.deepEqual(await recipients('personal'), []);
    const endpoint = 'https://fcm.googleapis.com/alice';
    await store.subscribe(accounts.bob.id, accounts.bob.sessionId, {
      endpoint,
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
      locale: 'en',
    });
    await store.removeExpired(endpoint, accounts.alice.sessionId);
    await store.unsubscribe(accounts.alice.id, endpoint);
    assert.equal(
      (
        await pool.query(
          'SELECT user_id FROM web_push_subscriptions WHERE endpoint = $1',
          [endpoint],
        )
      ).rows[0].user_id,
      accounts.bob.id,
    );
    await pool.query('DELETE FROM sessions WHERE id = $1', [
      accounts.bob.sessionId,
    ]);
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM web_push_subscriptions WHERE user_id = $1',
          [accounts.bob.id],
        )
      ).rowCount,
      0,
    );
    const before = (await store.read(accounts.alice.id)).cursor;
    await Promise.all(
      Array.from({ length: 105 }, (_, i) =>
        store.put(record(`batch-${i}`, { scope: 'personal' })),
      ),
    );
    const first = await store.read(accounts.alice.id, before);
    assert.equal(first.items.length, 100);
    assert.equal(first.more, true);
    const second = await store.read(accounts.alice.id, first.cursor);
    assert.equal(second.items.length, 5);
    assert.equal(second.more, false);
    assert.equal(
      (await store.read(accounts.alice.id, second.cursor)).items.length,
      0,
    );
    await pool.query('UPDATE users SET banned = true WHERE id = $1', [
      accounts.alice.id,
    ]);
    assert.equal((await store.read(accounts.alice.id, '0')).items.length, 0);
  },
);
