import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test from 'node:test';
import { Pool } from 'pg';
import { createAuth, createAuthOptions } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { hasAdminRole, parseAdminUsernames } from '@aime/shared';
import { createApp } from '../apps/server/src/app.js';

test('管理员配置标准化与角色判断', () => {
  assert.deepEqual(parseAdminUsernames(' Admin, owner,admin, , OWNER '), [
    'admin',
    'owner',
  ]);
  assert.equal(hasAdminRole('user,admin'), true);
  assert.equal(hasAdminRole('superadmin'), false);
  assert.equal(hasAdminRole(null), false);
});

test(
  'PostgreSQL 认证集成',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = `auth_test_${randomBytes(8).toString('hex')}`;
    const root = new Pool({ connectionString });
    const options = `-c search_path=${schema}`;
    const pool = new Pool({ connectionString, options });
    let server: Server | undefined;
    let schemaCreated = false;
    try {
      await root.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const authConfig = {
        pool,
        secret: randomBytes(32).toString('hex'),
        baseURL: 'http://localhost:5173',
        webOrigin: 'http://localhost:5173',
        admins: 'admin,owner',
      };
      const initialMigrations = await getMigrations(
        createAuthOptions(authConfig),
      );
      await initialMigrations.runMigrations();
      const auth = createAuth(authConfig);
      server = createApp(auth).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const password = 'Integration-Password-49!';
      let userCookie = '';
      let adminCookie = '';
      let userId = '';
      let adminId = '';
      let ownerId = '';
      let managedId = '';
      let managedCookie = '';
      let managedToken = '';
      const managedPassword = 'Managed-New-Password-73!';
      async function request(
        path: string,
        body?: unknown,
        cookie = '',
        origin = 'http://localhost:5173',
        extraHeaders: Record<string, string> = {},
      ) {
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'content-type': 'application/json',
            origin,
            cookie,
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        return {
          response,
          data: text ? JSON.parse(text) : null,
          cookie: response.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; '),
        };
      }
      await t.test('Better Auth 独立建表，插件字段齐全且迁移幂等', async () => {
        assert.deepEqual(
          initialMigrations.toBeCreated.map(({ table }) => table).sort(),
          ['accounts', 'sessions', 'users', 'verifications'],
        );
        const next = await getMigrations(auth.options);
        assert.deepEqual(next.toBeCreated, []);
        assert.deepEqual(next.toBeAdded, []);
        assert.deepEqual(next.toBeAddedIndexes, []);
        assert.deepEqual(next.schemaProblems, []);
        await next.runMigrations();
        const columns = await pool.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users'`,
          [schema],
        );
        const names = columns.rows.map((row) => row.column_name);
        for (const name of [
          'username',
          'display_username',
          'role',
          'banned',
          'ban_reason',
          'ban_expires',
        ]) {
          assert.ok(names.includes(name), `Missing plugin column: ${name}`);
        }
        assert.ok(!names.includes('deleted_at'));
        assert.equal(
          (await pool.query('SELECT current_schema() AS schema')).rows[0]
            .schema,
          schema,
        );
      });
      await t.test('匿名请求无法访问个人和管理接口', async () => {
        assert.equal((await request('/api/me')).response.status, 401);
        assert.equal((await request('/api/admin/users')).response.status, 401);
        assert.equal(
          (await request('/api/auth/admin/list-users')).response.status,
          401,
        );
        assert.equal(
          (
            await request('/api/auth/admin/create-user', {
              email: 'intruder@example.com',
              password,
              name: 'intruder',
              role: 'admin',
            })
          ).response.status,
          401,
        );
      });
      await t.test('公开注册不能抢占保留管理员用户名', async () => {
        for (const username of ['ADMIN', 'owner']) {
          const result = await request('/api/auth/sign-up/email', {
            username,
            email: `${username}@example.com`,
            name: username,
            password,
          });
          assert.equal(result.response.status, 400);
          assert.equal(result.data.code, 'USERNAME_RESERVED');
        }
      });
      await t.test('用户名必填，密码长度由服务端验证', async () => {
        await assert.rejects(
          auth.api.signUpEmail({
            body: { email: 'missing@example.com', name: 'missing', password },
          }),
          { status: 'BAD_REQUEST' },
        );
        await assert.rejects(
          auth.api.signUpEmail({
            body: {
              username: 'shortpass',
              email: 'short@example.com',
              name: 'short',
              password: 'short',
            },
          }),
          { status: 'BAD_REQUEST' },
        );
      });
      await t.test('注册自动登录且拒绝客户端角色提权', async () => {
        const attack = await request('/api/auth/sign-up/email', {
          username: 'Alice',
          email: 'alice@example.com',
          name: 'Alice',
          password,
          role: 'admin',
        });
        assert.equal(attack.response.status, 400);
        assert.equal(attack.data.code, 'FIELD_NOT_ALLOWED');
        const result = await request('/api/auth/sign-up/email', {
          username: 'Alice',
          email: 'alice@example.com',
          name: 'Alice',
          password,
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.data.user.role, 'user');
        assert.equal(result.data.user.username, 'alice');
        assert.match(result.response.headers.get('set-cookie')!, /httponly/i);
        assert.match(
          result.response.headers.get('set-cookie')!,
          /samesite=lax/i,
        );
        userCookie = result.cookie;
        userId = result.data.user.id;
        const credentials = await pool.query(
          'SELECT password FROM accounts WHERE user_id = $1',
          [userId],
        );
        assert.ok(credentials.rows[0].password);
        assert.notEqual(credentials.rows[0].password, password);
      });
      await t.test('重复用户名和邮箱不能注册，不产生额外用户', async () => {
        await assert.rejects(
          auth.api.signUpEmail({
            body: {
              username: 'ALICE',
              email: 'another@example.com',
              name: 'duplicate',
              password,
            },
          }),
          { status: 'BAD_REQUEST' },
        );
        await assert.rejects(
          auth.api.signUpEmail({
            body: {
              username: 'another',
              email: 'ALICE@example.com',
              name: 'duplicate',
              password,
            },
          }),
        );
        const count = await pool.query(
          'SELECT count(*)::int AS count FROM users',
        );
        assert.equal(count.rows[0].count, 1);
      });
      await t.test(
        '会话持久化，普通用户不能访问后台和插件管理接口',
        async () => {
          assert.equal(
            (await request('/api/me', undefined, userCookie)).data.user.id,
            userId,
          );
          assert.equal(
            (await request('/api/auth/get-session', undefined, userCookie)).data
              .user.id,
            userId,
          );
          assert.equal(
            (await request('/api/admin/users', undefined, userCookie)).response
              .status,
            403,
          );
          assert.equal(
            (await request('/api/auth/admin/list-users', undefined, userCookie))
              .response.status,
            403,
          );
          assert.equal(
            (
              await request(
                '/api/auth/admin/set-role',
                { userId, role: 'admin' },
                userCookie,
              )
            ).response.status,
            403,
          );
        },
      );
      await t.test('本地通过 admin 插件创建多管理员并登录', async () => {
        for (const username of ['admin', 'owner']) {
          const created = await auth.api.createUser({
            body: {
              name: username,
              email: `${username}@example.com`,
              password,
              role: 'admin',
              data: { username },
            },
          });
          assert.equal(created.user.role, 'admin');
          if (username === 'owner') ownerId = created.user.id;
        }
        const login = await request('/api/auth/sign-in/username', {
          username: 'admin',
          password,
        });
        assert.equal(login.response.status, 200);
        adminCookie = login.cookie;
        adminId = login.data.user.id;
        const users = await request(
          '/api/auth/admin/list-users',
          undefined,
          adminCookie,
        );
        assert.equal(users.response.status, 200);
        assert.equal(users.data.total, 3);
        assert.equal(
          (await request('/api/admin/users', undefined, adminCookie)).response
            .status,
          501,
        );
      });
      await t.test('管理员通过 HTTP 创建用户名用户且可登录', async () => {
        const created = await request(
          '/api/auth/admin/create-user',
          {
            email: 'MANAGED@example.com',
            name: 'Management Test User',
            password,
            role: 'user',
            data: { username: 'Managed' },
          },
          adminCookie,
        );
        assert.equal(created.response.status, 200);
        assert.equal(created.data.user.username, 'managed');
        assert.equal(created.data.user.email, 'managed@example.com');
        assert.equal(created.data.user.name, 'Management Test User');
        assert.equal(created.data.user.role, 'user');
        assert.ok(created.data.user.id);
        managedId = created.data.user.id;
        const login = await request('/api/auth/sign-in/username', {
          username: 'MANAGED',
          password,
        });
        assert.equal(login.response.status, 200);
        assert.equal(login.data.user.id, managedId);
        assert.ok(login.cookie);
        assert.ok(login.data.token);
        managedCookie = login.cookie;
        managedToken = login.data.token;
        assert.equal(
          (await request('/api/me', undefined, adminCookie)).data.user.id,
          adminId,
        );
      });
      await t.test('用户列表支持搜索、排序、分页与空结果', async () => {
        const first = await request(
          '/api/auth/admin/list-users?sortBy=email&sortDirection=asc&limit=2&offset=0',
          undefined,
          adminCookie,
        );
        assert.equal(first.response.status, 200);
        assert.equal(first.data.total, 4);
        assert.equal(first.data.limit, 2);
        assert.deepEqual(
          first.data.users.map((user: { id: string }) => user.id),
          [adminId, userId],
        );
        const second = await request(
          '/api/auth/admin/list-users?sortBy=email&sortDirection=asc&limit=2&offset=2',
          undefined,
          adminCookie,
        );
        assert.equal(second.response.status, 200);
        assert.equal(second.data.total, 4);
        assert.equal(second.data.limit, 2);
        assert.equal(second.data.offset, 2);
        assert.deepEqual(
          second.data.users.map((user: { id: string }) => user.id),
          [managedId, ownerId],
        );
        for (const query of [
          'searchField=name&searchOperator=contains&searchValue=Management',
          'searchField=email&searchOperator=starts_with&searchValue=managed%40',
        ]) {
          const result = await request(
            `/api/auth/admin/list-users?${query}&limit=1`,
            undefined,
            adminCookie,
          );
          assert.equal(result.response.status, 200);
          assert.equal(result.data.total, 1);
          assert.deepEqual(
            result.data.users.map((user: { id: string }) => user.id),
            [managedId],
          );
        }
        const descending = await request(
          '/api/auth/admin/list-users?searchField=email&searchOperator=ends_with&searchValue=%40example.com&sortBy=email&sortDirection=desc&limit=1',
          undefined,
          adminCookie,
        );
        assert.equal(descending.response.status, 200);
        assert.equal(descending.data.total, 4);
        assert.equal(descending.data.users[0].id, ownerId);
        for (const query of ['searchValue=nobody', 'limit=2&offset=4']) {
          const result = await request(
            `/api/auth/admin/list-users?${query}`,
            undefined,
            adminCookie,
          );
          assert.equal(result.response.status, 200);
          assert.deepEqual(result.data.users, []);
          assert.equal(
            result.data.total,
            query === 'searchValue=nobody' ? 0 : 4,
          );
        }
      });
      await t.test(
        '普通用户不能通过管理接口读取会话或执行任何用户变更',
        async () => {
          const cases: Array<[string, unknown, string]> = [
            [
              'create-user',
              {
                email: 'forbidden@example.com',
                name: 'Forbidden',
                password,
                role: 'admin',
                data: { username: 'forbidden' },
              },
              'YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS',
            ],
            [
              'update-user',
              {
                userId: managedId,
                data: { name: 'Forbidden', email: 'forbidden@example.com' },
              },
              'YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS',
            ],
            [
              'set-role',
              { userId: managedId, role: 'admin' },
              'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE',
            ],
            [
              'set-user-password',
              { userId: managedId, newPassword: managedPassword },
              'YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD',
            ],
            [
              'ban-user',
              { userId: managedId, banReason: 'Forbidden' },
              'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS',
            ],
            [
              'unban-user',
              { userId: managedId },
              'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS',
            ],
            [
              'list-user-sessions',
              { userId: managedId },
              'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS_SESSIONS',
            ],
            [
              'revoke-user-session',
              { sessionToken: managedToken },
              'YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS',
            ],
            [
              'revoke-user-sessions',
              { userId: managedId },
              'YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS',
            ],
            [
              'remove-user',
              { userId: managedId },
              'YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS',
            ],
          ];
          for (const [endpoint, body, code] of cases) {
            const result = await request(
              `/api/auth/admin/${endpoint}`,
              body,
              userCookie,
            );
            assert.equal(result.response.status, 403, endpoint);
            assert.equal(result.data.code, code, endpoint);
          }
          const target = await request('/api/me', undefined, managedCookie);
          assert.equal(target.response.status, 200);
          assert.equal(target.data.user.id, managedId);
          assert.equal(target.data.user.name, 'Management Test User');
          assert.equal(target.data.user.email, 'managed@example.com');
          assert.equal(target.data.user.role, 'user');
          assert.equal(target.data.user.banned, false);
          const users = await request(
            '/api/auth/admin/list-users',
            undefined,
            adminCookie,
          );
          assert.equal(users.response.status, 200);
          assert.equal(users.data.total, 4);
        },
      );
      await t.test('管理员创建重复用户名或邮箱失败且不增加用户', async () => {
        for (const [username, email, code] of [
          ['MANAGED', 'duplicate@example.com', 'USERNAME_IS_ALREADY_TAKEN'],
          [
            'duplicate',
            'MANAGED@example.com',
            'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
          ],
        ]) {
          const result = await request(
            '/api/auth/admin/create-user',
            { name: 'Duplicate', email, password, data: { username } },
            adminCookie,
          );
          assert.equal(result.response.status, 400);
          assert.equal(result.data.code, code);
        }
        const users = await request(
          '/api/auth/admin/list-users',
          undefined,
          adminCookie,
        );
        assert.equal(users.response.status, 200);
        assert.equal(users.data.total, 4);
      });
      await t.test(
        '管理员编辑 name/email，拒绝无效邮箱和重复邮箱',
        async () => {
          for (const [email, code] of [
            ['invalid-email', 'INVALID_EMAIL'],
            ['ALICE@example.com', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'],
          ]) {
            const result = await request(
              '/api/auth/admin/update-user',
              { userId: managedId, data: { name: 'Must Not Persist', email } },
              adminCookie,
            );
            assert.equal(result.response.status, 400);
            assert.equal(result.data.code, code);
          }
          const unchanged = await request('/api/me', undefined, managedCookie);
          assert.equal(unchanged.response.status, 200);
          assert.equal(unchanged.data.user.name, 'Management Test User');
          assert.equal(unchanged.data.user.email, 'managed@example.com');
          const result = await request(
            '/api/auth/admin/update-user',
            {
              userId: managedId,
              data: { name: 'Managed Updated', email: 'UPDATED@example.com' },
            },
            adminCookie,
          );
          assert.equal(result.response.status, 200);
          // Better Auth 1.7.6 update-user returns the user directly, unlike set-role.
          assert.equal(result.data.id, managedId);
          assert.equal(result.data.name, 'Managed Updated');
          assert.equal(result.data.email, 'updated@example.com');
          assert.equal(result.data.username, 'managed');
          const persisted = await request('/api/me', undefined, managedCookie);
          assert.equal(persisted.response.status, 200);
          assert.equal(persisted.data.user.name, 'Managed Updated');
          assert.equal(persisted.data.user.email, 'updated@example.com');
        },
      );
      await t.test('set-role 提权和降权立即影响已有会话权限', async () => {
        for (const [role, status] of [
          ['admin', 200],
          ['user', 403],
        ] as const) {
          const result = await request(
            '/api/auth/admin/set-role',
            { userId: managedId, role },
            adminCookie,
          );
          assert.equal(result.response.status, 200);
          assert.equal(result.data.user.id, managedId);
          assert.equal(result.data.user.role, role);
          assert.equal(
            (
              await request(
                '/api/auth/admin/list-users',
                undefined,
                managedCookie,
              )
            ).response.status,
            status,
          );
        }
      });
      await t.test(
        'set-user-password 校验长度，旧密码失效、新密码可登录',
        async () => {
          for (const newPassword of ['short', 'x'.repeat(129)]) {
            const result = await request(
              '/api/auth/admin/set-user-password',
              { userId: managedId, newPassword },
              adminCookie,
            );
            assert.equal(result.response.status, 400);
            assert.equal(
              result.data.code,
              newPassword.length < 8
                ? 'PASSWORD_TOO_SHORT'
                : 'PASSWORD_TOO_LONG',
            );
          }
          const updated = await request(
            '/api/auth/admin/set-user-password',
            { userId: managedId, newPassword: managedPassword },
            adminCookie,
          );
          assert.equal(updated.response.status, 200);
          assert.equal(updated.data.status, true);
          // Use email login here so these checks do not consume the username rate-limit budget.
          const oldLogin = await request('/api/auth/sign-in/email', {
            email: 'updated@example.com',
            password,
          });
          assert.equal(oldLogin.response.status, 401);
          const newLogin = await request('/api/auth/sign-in/email', {
            email: 'updated@example.com',
            password: managedPassword,
          });
          assert.equal(newLogin.response.status, 200);
          assert.equal(newLogin.data.user.id, managedId);
          // Password reset alone does not revoke existing sessions in the admin plugin.
          assert.equal(
            (await request('/api/me', undefined, managedCookie)).response
              .status,
            200,
          );
        },
      );
      await t.test(
        '管理员列出会话、撤销单个及全部会话，用户仍可重新登录',
        async () => {
          const sessions = await request(
            '/api/auth/admin/list-user-sessions',
            { userId: managedId },
            adminCookie,
          );
          assert.equal(sessions.response.status, 200);
          assert.equal(sessions.data.sessions.length, 2);
          assert.ok(
            sessions.data.sessions.every(
              (session: { userId: string }) => session.userId === managedId,
            ),
          );
          assert.ok(
            sessions.data.sessions.some(
              (session: { token: string }) => session.token === managedToken,
            ),
          );
          const revoked = await request(
            '/api/auth/admin/revoke-user-session',
            { sessionToken: managedToken },
            adminCookie,
          );
          assert.equal(revoked.response.status, 200);
          assert.equal(revoked.data.success, true);
          assert.equal(
            (await request('/api/me', undefined, managedCookie)).response
              .status,
            401,
          );
          const remaining = await request(
            '/api/auth/admin/list-user-sessions',
            { userId: managedId },
            adminCookie,
          );
          assert.equal(remaining.response.status, 200);
          assert.equal(remaining.data.sessions.length, 1);
          assert.ok(
            remaining.data.sessions.every(
              (session: { token: string }) => session.token !== managedToken,
            ),
          );
          const cookies: string[] = [];
          for (let index = 0; index < 2; index++) {
            const login = await request('/api/auth/sign-in/email', {
              email: 'updated@example.com',
              password: managedPassword,
            });
            assert.equal(login.response.status, 200);
            cookies.push(login.cookie);
          }
          const all = await request(
            '/api/auth/admin/revoke-user-sessions',
            { userId: managedId },
            adminCookie,
          );
          assert.equal(all.response.status, 200);
          assert.equal(all.data.success, true);
          for (const cookie of cookies) {
            assert.equal(
              (await request('/api/me', undefined, cookie)).response.status,
              401,
            );
          }
          const empty = await request(
            '/api/auth/admin/list-user-sessions',
            { userId: managedId },
            adminCookie,
          );
          assert.equal(empty.response.status, 200);
          assert.deepEqual(empty.data.sessions, []);
          assert.equal(
            (await request('/api/me', undefined, adminCookie)).response.status,
            200,
          );
          const login = await request('/api/auth/sign-in/email', {
            email: 'updated@example.com',
            password: managedPassword,
          });
          assert.equal(login.response.status, 200);
          managedCookie = login.cookie;
        },
      );
      await t.test('管理员不能自我封禁或删除，失败不影响自身会话', async () => {
        for (const [endpoint, body, code] of [
          ['ban-user', { userId: adminId }, 'YOU_CANNOT_BAN_YOURSELF'],
          [
            'update-user',
            { userId: adminId, data: { banned: true } },
            'YOU_CANNOT_BAN_YOURSELF',
          ],
          ['remove-user', { userId: adminId }, 'YOU_CANNOT_REMOVE_YOURSELF'],
        ] as const) {
          const result = await request(
            `/api/auth/admin/${endpoint}`,
            body,
            adminCookie,
          );
          assert.equal(result.response.status, 400);
          assert.equal(result.data.code, code);
        }
        const current = await request('/api/me', undefined, adminCookie);
        assert.equal(current.response.status, 200);
        assert.equal(current.data.user.id, adminId);
        assert.equal(current.data.user.banned, false);
      });
      await t.test(
        '自身角色和会话操作沿用插件权限，不套用前端禁止规则',
        async () => {
          const login = await request('/api/auth/sign-in/email', {
            email: 'owner@example.com',
            password,
          });
          assert.equal(login.response.status, 200);
          const demoted = await request(
            '/api/auth/admin/set-role',
            { userId: ownerId, role: 'user' },
            login.cookie,
          );
          assert.equal(demoted.response.status, 200);
          assert.equal(demoted.data.user.role, 'user');
          assert.equal(
            (
              await request(
                '/api/auth/admin/list-users',
                undefined,
                login.cookie,
              )
            ).response.status,
            403,
          );
          const restored = await request(
            '/api/auth/admin/set-role',
            { userId: ownerId, role: 'admin' },
            adminCookie,
          );
          assert.equal(restored.response.status, 200);
          const revoked = await request(
            '/api/auth/admin/revoke-user-sessions',
            { userId: ownerId },
            login.cookie,
          );
          assert.equal(revoked.response.status, 200);
          assert.equal(revoked.data.success, true);
          assert.equal(
            (await request('/api/me', undefined, login.cookie)).response.status,
            401,
          );
          assert.equal(
            (
              await request(
                '/api/auth/admin/list-users',
                undefined,
                adminCookie,
              )
            ).response.status,
            200,
          );
        },
      );
      await t.test(
        'remove-user 删除用户、账号和会话，旧会话与密码不能再登录',
        async () => {
          const removed = await request(
            '/api/auth/admin/remove-user',
            { userId: managedId },
            adminCookie,
          );
          assert.equal(removed.response.status, 200);
          assert.equal(removed.data.success, true);
          assert.equal(
            (await request('/api/me', undefined, managedCookie)).response
              .status,
            401,
          );
          const login = await request('/api/auth/sign-in/email', {
            email: 'updated@example.com',
            password: managedPassword,
          });
          assert.equal(login.response.status, 401);
          const users = await request(
            '/api/auth/admin/list-users?searchValue=updated%40example.com',
            undefined,
            adminCookie,
          );
          assert.equal(users.response.status, 200);
          assert.equal(users.data.total, 0);
          assert.deepEqual(users.data.users, []);
          const counts = await pool.query(
            `SELECT
            (SELECT count(*)::int FROM users WHERE id = $1) AS users,
            (SELECT count(*)::int FROM accounts WHERE user_id = $1) AS accounts,
            (SELECT count(*)::int FROM sessions WHERE user_id = $1) AS sessions`,
            [managedId],
          );
          assert.deepEqual(counts.rows[0], {
            users: 0,
            accounts: 0,
            sessions: 0,
          });
          const again = await request(
            '/api/auth/admin/remove-user',
            { userId: managedId },
            adminCookie,
          );
          assert.equal(again.response.status, 404);
          assert.equal(again.data.code, 'USER_NOT_FOUND');
        },
      );
      await t.test('错误密码失败，用户名大小写归一化', async () => {
        assert.equal(
          (
            await request('/api/auth/sign-in/username', {
              username: 'Alice',
              password: 'incorrect-password',
            })
          ).response.status,
          401,
        );
        const result = await request('/api/auth/sign-in/username', {
          username: 'ALICE',
          password,
        });
        assert.equal(result.response.status, 200);
        userCookie = result.cookie;
      });
      await t.test('拒绝跨来源请求和已登录用户抢占管理员用户名', async () => {
        assert.equal(
          (
            await request(
              '/api/auth/update-user',
              { username: 'admin' },
              userCookie,
            )
          ).response.status,
          400,
        );
        assert.equal(
          (
            await request(
              '/api/auth/sign-out',
              {},
              userCookie,
              'https://untrusted.invalid',
            )
          ).response.status,
          403,
        );
      });
      await t.test('退出后旧会话失效', async () => {
        assert.equal(
          (await request('/api/auth/sign-out', {}, userCookie)).response.status,
          200,
        );
        assert.equal(
          (await request('/api/me', undefined, userCookie)).response.status,
          401,
        );
      });
      await t.test(
        'ban/unban 撤销会话、阻止登录，解封后必须重新登录',
        async () => {
          const login = await request('/api/auth/sign-in/username', {
            username: 'alice',
            password,
          });
          assert.equal(login.response.status, 200);
          const beforeBan = Date.now();
          const banned = await request(
            '/api/auth/admin/ban-user',
            { userId, banReason: 'integration test', banExpiresIn: 3600 },
            adminCookie,
          );
          assert.equal(banned.response.status, 200);
          assert.equal(banned.data.user.id, userId);
          assert.equal(banned.data.user.banned, true);
          assert.equal(banned.data.user.banReason, 'integration test');
          const banExpires = Date.parse(banned.data.user.banExpires);
          assert.ok(banExpires >= beforeBan + 3600_000);
          assert.ok(banExpires <= Date.now() + 3600_000);
          assert.equal(
            (await request('/api/me', undefined, login.cookie)).response.status,
            401,
          );
          const sessions = await request(
            '/api/auth/admin/list-user-sessions',
            { userId },
            adminCookie,
          );
          assert.equal(sessions.response.status, 200);
          assert.deepEqual(sessions.data.sessions, []);
          const blocked = await request('/api/auth/sign-in/username', {
            username: 'alice',
            password,
          });
          assert.equal(blocked.response.status, 403);
          assert.equal(blocked.data.code, 'BANNED_USER');
          const unbanned = await request(
            '/api/auth/admin/unban-user',
            { userId },
            adminCookie,
          );
          assert.equal(unbanned.response.status, 200);
          assert.equal(unbanned.data.user.id, userId);
          assert.equal(unbanned.data.user.banned, false);
          assert.equal(unbanned.data.user.banReason, null);
          assert.equal(unbanned.data.user.banExpires, null);
          assert.equal(
            (await request('/api/me', undefined, login.cookie)).response.status,
            401,
          );
          const relogin = await request('/api/auth/sign-in/username', {
            username: 'alice',
            password,
          });
          assert.equal(relogin.response.status, 200);
          assert.equal(relogin.data.user.id, userId);
          assert.equal(
            (await request('/api/me', undefined, relogin.cookie)).response
              .status,
            200,
          );
        },
      );
      await t.test('登录接口启用速率限制', async () => {
        let status = 0;
        for (let index = 0; index < 11; index++) {
          status = (
            await request('/api/auth/sign-in/username', {
              username: 'ghost',
              password,
            })
          ).response.status;
          if (status === 429) break;
        }
        assert.equal(status, 429);
        const spoofed = await request(
          '/api/auth/sign-in/username',
          { username: 'ghost', password },
          '',
          'http://localhost:5173',
          {
            'x-forwarded-for': '198.51.100.17',
            'x-aime-client-ip': '198.51.100.18',
          },
        );
        assert.equal(spoofed.response.status, 429);
      });
    } finally {
      if (server?.listening) {
        const activeServer = server;
        const closing = new Promise<void>((resolve, reject) =>
          activeServer.close((error) => (error ? reject(error) : resolve())),
        );
        activeServer.closeAllConnections();
        await closing;
      }
      await pool.end();
      // Only remove this run's randomly named schema, never an existing application's tables.
      if (schemaCreated) await root.query(`DROP SCHEMA "${schema}" CASCADE`);
      await root.end();
    }
  },
);
