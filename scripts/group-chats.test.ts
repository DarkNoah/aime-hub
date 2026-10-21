import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { Auth } from '@aime/auth';
import {
  groupChatCreateSchema,
  groupChatMessageSchema,
} from '@aime/shared/group-chats';
import { groupChatMessagesQuery } from '../packages/shared/src/rpc/group-chats.js';
import { CreateGroupChats1780000024000 } from '../packages/db/src/migrations/1780000024000-create-group-chats.js';
import { GroupChatService } from '../apps/server/src/modules/group-chats/service.js';
import { UserService } from '../apps/server/src/modules/users/service.js';
import { createApp } from '../apps/server/src/app.js';
import type { ThreadService } from '../apps/server/src/modules/threads/service.js';
import type { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import { chatDraftKey } from '../apps/web/src/components/chat/draft-storage.js';

test('room/message validation and pagination cursor boundaries', () => {
  assert.equal(groupChatCreateSchema.safeParse({ title: '  ' }).success, false);
  assert.equal(
    groupChatMessageSchema.safeParse({ id: 'abcdefghijklmnop', text: '  ' })
      .success,
    false,
  );
  assert.equal(
    groupChatMessageSchema.safeParse({
      id: 'abcdefghijklmnop',
      text: 'a'.repeat(20001),
    }).success,
    false,
  );
  assert.equal(
    groupChatMessagesQuery.safeParse({ before: '1', after: '2' }).success,
    false,
  );
  assert.equal(
    groupChatMessagesQuery.safeParse({ after: '-1' }).success,
    false,
  );
  assert.equal(
    groupChatMessagesQuery.safeParse({ after: '9223372036854775808' }).success,
    false,
  );
  assert.equal(
    groupChatMessagesQuery.parse({ after: '9007199254740993' }).after,
    '9007199254740993',
  );
  assert.notEqual(
    chatDraftKey({ userId: 'alice', groupChatId: 'abcdefghijklmnop' }),
    chatDraftKey({ userId: 'alice', threadId: 'abcdefghijklmnop' }),
  );
  assert.notEqual(
    chatDraftKey({ userId: 'alice', groupChatId: 'abcdefghijklmnop' }),
    chatDraftKey({ userId: 'bob', groupChatId: 'abcdefghijklmnop' }),
  );
});

test(
  'Postgres rooms, membership, concurrent sends, pagination and HTTP contracts',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `group_chat_test_${randomBytes(8).toString('hex')}`;
    const database = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      extra: { options: `-c search_path=${schema}` },
    });
    await database.initialize();
    t.after(async () => {
      try {
        await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await database.destroy();
      }
    });
    await database.query(`CREATE SCHEMA "${schema}"`);
    await database.query(`CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL, username text, image text, email text);
    CREATE TABLE projects (id text PRIMARY KEY, deleted_at timestamptz);
    CREATE TABLE project_members (project_id text REFERENCES projects(id), user_id text, role text, created_at timestamptz DEFAULT now(), deleted_at timestamptz, PRIMARY KEY(project_id, user_id));
    INSERT INTO users VALUES ('alice','Alice','alice','/alice.png','private@example.com'), ('bob','Bob','bob','/bob.png','private2@example.com'), ('outsider','Outsider',NULL,NULL,NULL);
    INSERT INTO projects VALUES ('project000000001',NULL);
    INSERT INTO project_members(project_id,user_id,role) VALUES ('project000000001','alice','owner'), ('project000000001','bob','member');`);
    const runner = database.createQueryRunner();
    await new CreateGroupChats1780000024000().up(runner);
    await runner.release();
    const rooms = new GroupChatService(database);
    const users = new UserService(database, rooms);
    const personal = await rooms.create('alice', { title: 'Private' });
    const project = await rooms.create('alice', {
      title: 'Team',
      projectId: 'project000000001',
    });
    const memberRoom = await rooms.create('bob', {
      title: 'Bob room',
      projectId: 'project000000001',
    });
    const code = (value: string) => (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === value;

    await t.test(
      'scope isolation and room management permissions',
      async () => {
        assert.equal(
          (await rooms.list('alice', { page: 0, perPage: 20 })).rooms.length,
          1,
        );
        assert.deepEqual(
          (await rooms.list('bob', { page: 0, perPage: 20 })).rooms,
          [],
        );
        assert.equal(
          (
            await rooms.list('bob', {
              projectId: project.projectId!,
              page: 0,
              perPage: 1,
            })
          ).hasMore,
          true,
        );
        await assert.rejects(rooms.get('bob', personal.id), code('NOT_FOUND'));
        await assert.rejects(
          rooms.messages('outsider', project.id, { limit: 50 }),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.list('outsider', {
            projectId: project.projectId!,
            page: 0,
            perPage: 20,
          }),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.update('bob', project.id, 'No'),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.remove('bob', project.id),
          code('FORBIDDEN'),
        );
        assert.equal(
          (await rooms.update('alice', memberRoom.id, 'Manager rename')).title,
          'Manager rename',
        );
        assert.deepEqual((await rooms.get('bob', project.id)).memberIds, [
          'alice',
          'bob',
        ]);
      },
    );

    await t.test(
      'default entry reuses existing rooms and serializes first visits by scope',
      async () => {
        assert.equal((await rooms.openDefault('alice')).id, personal.id);
        assert.equal(
          (await rooms.openDefault('bob', project.projectId!)).id,
          project.id,
        );
        assert.equal(
          (
            await rooms.list('alice', {
              projectId: project.projectId!,
              page: 0,
              perPage: 20,
            })
          ).rooms.length,
          2,
        );
        await assert.rejects(
          rooms.openDefault('outsider', project.projectId!),
          code('NOT_FOUND'),
        );
        const personalVisits = await Promise.all(
          Array.from({ length: 12 }, () => rooms.openDefault('outsider')),
        );
        assert.equal(new Set(personalVisits.map((room) => room.id)).size, 1);
        assert.equal(
          (await rooms.list('outsider', { page: 0, perPage: 20 })).rooms.length,
          1,
        );
        await database.query(`INSERT INTO projects VALUES ('project000000002', NULL);
        INSERT INTO project_members(project_id,user_id,role) VALUES ('project000000002','alice','owner'), ('project000000002','bob','member')`);
        const visits = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            rooms.openDefault(index % 2 ? 'alice' : 'bob', 'project000000002'),
          ),
        );
        assert.equal(new Set(visits.map((room) => room.id)).size, 1);
        assert.equal(
          (
            await rooms.list('alice', {
              projectId: 'project000000002',
              page: 0,
              perPage: 20,
            })
          ).rooms.length,
          1,
        );
        // Keep subsequent membership-revocation assertions scoped to the original project.
        await database.query(
          "DELETE FROM project_members WHERE project_id = 'project000000002'",
        );
        await database.query(
          "DELETE FROM projects WHERE id = 'project000000002'",
        );
      },
    );

    await t.test(
      'concurrent sends are persistent and idempotent, authors cannot be spoofed',
      async () => {
        const sent = await Promise.all(
          Array.from({ length: 73 }, (_, index) =>
            rooms.send(index % 2 ? 'alice' : 'bob', project.id, {
              id: `message${String(index).padStart(9, '0')}`,
              text: `message ${index}`,
            }),
          ),
        );
        assert.equal(new Set(sent.map((message) => message.sequence)).size, 73);
        const first = sent[0];
        assert.equal(
          (
            await rooms.send('bob', project.id, {
              id: first.id,
              text: first.text,
            })
          ).sequence,
          first.sequence,
        );
        await assert.rejects(
          rooms.send('alice', project.id, { id: first.id, text: first.text }),
          code('CONFLICT'),
        );
        await assert.rejects(
          rooms.send('bob', project.id, { id: first.id, text: 'changed' }),
          code('CONFLICT'),
        );
        await assert.rejects(
          rooms.send('outsider', project.id, {
            id: 'invalid000000001',
            text: 'No access',
          }),
          code('NOT_FOUND'),
        );
        assert.equal(
          (await rooms.messages('alice', project.id, { limit: 50 })).messages
            .length,
          50,
        );
      },
    );

    await t.test(
      'history and catch-up cursors never duplicate or skip messages',
      async () => {
        const latest = await rooms.messages('alice', project.id, { limit: 50 });
        assert.equal(latest.hasMore, true);
        await rooms.send('alice', project.id, {
          id: 'newmessage000001',
          text: 'Arrived during pagination',
        });
        const earlier = await rooms.messages('alice', project.id, {
          before: latest.messages[0].sequence,
          limit: 50,
        });
        assert.equal(earlier.hasMore, false);
        assert.equal(earlier.messages.length, 23);
        const after = await rooms.messages('bob', project.id, {
          after: latest.messages.at(-1)!.sequence,
          limit: 50,
        });
        assert.equal(after.messages.length, 1);
        const all = [
          ...earlier.messages,
          ...latest.messages,
          ...after.messages,
        ];
        assert.equal(new Set(all.map((message) => message.id)).size, 74);
        assert.ok(
          all.every(
            (message, index) =>
              !index ||
              BigInt(message.sequence) > BigInt(all[index - 1].sequence),
          ),
        );
        const catchup = await rooms.messages('bob', project.id, {
          after: '0',
          limit: 50,
        });
        assert.equal(catchup.hasMore, true);
        const rest = await rooms.messages('bob', project.id, {
          after: catchup.messages.at(-1)!.sequence,
          limit: 50,
        });
        assert.equal(rest.messages.length, 24);
      },
    );

    await t.test(
      'lookup returns only basic authorized profiles, including historical senders',
      async () => {
        const profiles = await users.lookup('alice', [
          'bob',
          'alice',
          'bob',
          'outsider',
        ]);
        assert.deepEqual(
          profiles.map((profile) => profile.id),
          ['bob', 'alice'],
        );
        assert.deepEqual(Object.keys(profiles[0]).sort(), [
          'id',
          'image',
          'name',
          'username',
        ]);
        assert.equal(profiles[0].image, '/bob.png');
        assert.deepEqual(await users.lookup('outsider', ['alice', 'bob']), []);
        await database.query(
          "UPDATE project_members SET deleted_at = now() WHERE user_id = 'bob'",
        );
        assert.deepEqual((await rooms.get('alice', project.id)).memberIds, [
          'alice',
        ]);
        await assert.rejects(
          rooms.messages('bob', project.id, { limit: 50 }),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.send('bob', project.id, {
            id: 'removed000000001',
            text: 'No longer allowed',
          }),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          users.lookup('bob', ['alice'], project.id),
          code('NOT_FOUND'),
        );
        assert.deepEqual(await users.lookup('alice', ['bob']), []);
        assert.equal(
          (await users.lookup('alice', ['bob'], project.id))[0].name,
          'Bob',
        );
      },
    );

    await t.test(
      'authenticated HTTP/RPC routes validate requests and server-side sender identity',
      async () => {
        const auth = {
          api: {
            getSession: async ({ headers }: { headers: Headers }) =>
              headers.get('x-test-user')
                ? {
                    user: { id: headers.get('x-test-user') },
                    session: { id: 'test' },
                  }
                : null,
          },
        } as unknown as Auth;
        const app = createApp(auth, undefined, {
          threads: {} as ThreadService,
          models: {} as LanguageModelService,
          groupChats: rooms,
          users,
          webOrigin: 'http://localhost',
        });
        const request = (
          path: string,
          method = 'GET',
          body?: unknown,
          user = 'alice',
          origin = 'http://localhost',
        ) =>
          app.request(`http://localhost/api${path}`, {
            method,
            headers: {
              'x-test-user': user,
              origin,
              'content-type': 'application/json',
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        assert.equal(
          (await request('/group-chats', 'GET', undefined, '')).status,
          401,
        );
        assert.equal(
          (
            await request(
              '/group-chats',
              'POST',
              { title: 'bad origin' },
              'alice',
              'https://other.invalid',
            )
          ).status,
          403,
        );
        assert.equal(
          (await request('/group-chats', 'POST', { title: '' })).status,
          400,
        );
        assert.equal(
          (
            await request(
              `/group-chats/${project.id}/messages?before=1&after=2`,
            )
          ).status,
          400,
        );
        const defaultRoom = await request('/group-chats/default', 'POST', {
          projectId: project.projectId,
        });
        assert.equal(defaultRoom.status, 200);
        assert.equal((await defaultRoom.json()).id, project.id);
        const sent = await request(
          `/group-chats/${project.id}/messages`,
          'POST',
          {
            id: 'httpmessage00001',
            text: 'HTTP message',
            senderId: 'outsider',
          },
        );
        assert.equal(sent.status, 201);
        assert.equal((await sent.json()).senderId, 'alice');
        const lookup = await request('/users/lookup', 'POST', {
          userIds: ['bob'],
          roomId: project.id,
        });
        assert.equal(lookup.status, 200);
        assert.equal((await lookup.json())[0].image, '/bob.png');
        const rpc = await request('/rpc/groupChats/get', 'POST', {
          json: { params: { roomId: project.id } },
        });
        assert.equal(rpc.status, 200);
        assert.equal((await rpc.json()).json.id, project.id);
      },
    );

    await t.test(
      'deleted project denies access and room deletion cascades messages',
      async () => {
        await database.query('UPDATE projects SET deleted_at = now()');
        await assert.rejects(rooms.get('alice', project.id), code('NOT_FOUND'));
        await database.query('UPDATE projects SET deleted_at = NULL');
        await rooms.remove('alice', project.id);
        assert.equal(
          (
            await database.query(
              'SELECT count(*)::int AS count FROM group_chat_messages WHERE room_id = $1',
              [project.id],
            )
          )[0].count,
          0,
        );
        await assert.rejects(rooms.get('alice', project.id), code('NOT_FOUND'));
        assert.equal((await rooms.get('alice', personal.id)).title, 'Private');
      },
    );
  },
);
