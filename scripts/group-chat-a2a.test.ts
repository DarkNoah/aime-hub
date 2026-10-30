import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { GroupChatService } from '../apps/server/src/modules/group-chats/service.js';
import { groupChatA2aRoutes } from '../apps/server/src/modules/group-chats/a2a-routes.js';
import { CreateGroupChats1780000024000 } from '../packages/db/src/migrations/1780000024000-create-group-chats.js';
import { GroupChatAgents1780000026000 } from '../packages/db/src/migrations/1780000026000-group-chat-agents.js';
import { GroupChatMembers1780000027000 } from '../packages/db/src/migrations/1780000027000-group-chat-members.js';
import { GroupChatIdleWake1780000029000 } from '../packages/db/src/migrations/1780000029000-group-chat-idle-wake.js';
import { GroupChatA2aMembers1780000030000 } from '../packages/db/src/migrations/1780000030000-group-chat-a2a-members.js';
import { GroupChatA2aMemberDeletion1780000031000 } from '../packages/db/src/migrations/1780000031000-group-chat-a2a-member-deletion.js';
import { GroupChatA2aCard1780000033000 } from '../packages/db/src/migrations/1780000033000-group-chat-a2a-card.js';

const code = (expected: string) => (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === expected;

test(
  'A2A room credentials preserve independent identities and room access boundaries',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    const schema = `group_chat_a2a_test_${randomBytes(8).toString('hex')}`;
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
    await database.query(`CREATE TABLE users (id text PRIMARY KEY,name text NOT NULL,username text,banned boolean DEFAULT false);
    CREATE TABLE projects (id text PRIMARY KEY,deleted_at timestamptz);
    CREATE TABLE project_members (project_id text REFERENCES projects(id),user_id text,role text,created_at timestamptz DEFAULT now(),deleted_at timestamptz,PRIMARY KEY(project_id,user_id));
    INSERT INTO users(id,name) VALUES ('alice','Alice'),('bob','Bob'),('outsider','Outsider');
    INSERT INTO projects(id) VALUES ('project000000001');
    INSERT INTO project_members(project_id,user_id,role) VALUES ('project000000001','alice','owner'),('project000000001','bob','member')`);
    const runner = database.createQueryRunner();
    for (const migration of [
      new CreateGroupChats1780000024000(),
      new GroupChatAgents1780000026000(),
      new GroupChatMembers1780000027000(),
      new GroupChatIdleWake1780000029000(),
      new GroupChatA2aMembers1780000030000(),
      new GroupChatA2aMemberDeletion1780000031000(),
      new GroupChatA2aCard1780000033000(),
    ])
      await migration.up(runner);
    await runner.release();
    const rooms = new GroupChatService(database);
    const room = await rooms.create('alice', { title: 'A2A room' });
    const other = await rooms.create('alice', { title: 'Another room' });
    const first = await rooms.createA2aMember('alice', room.id, {
      name: 'Research',
      publicOrigin: 'https://public.example/',
      description: '调研与核验协作室',
    });
    const second = await rooms.createA2aMember('alice', room.id, {
      name: 'Research',
    });

    await t.test(
      'one-time keys are hashed, room-scoped, and independent members without local threads',
      async () => {
        assert.notEqual(first.apiKey, second.apiKey);
        assert.notEqual(first.member.id, second.member.id);
        assert.equal(first.member.enabled, true);
        assert.equal(first.member.lastUsedAt, null);
        const rows = await database.query(
          'SELECT key_hash,key_prefix FROM group_chat_a2a_members WHERE id=$1',
          [first.member.id],
        );
        assert.equal(
          rows[0].key_hash,
          createHash('sha256').update(first.apiKey).digest('hex'),
        );
        assert.notEqual(rows[0].key_hash, first.apiKey);
        assert.ok(first.apiKey.startsWith(rows[0].key_prefix));
        const detail = await rooms.get('alice', room.id);
        assert.equal(detail.agents.length, 1);
        assert.equal(detail.a2aMembers?.length, 2);
        assert.equal(JSON.stringify(detail).includes(first.apiKey), false);
        assert.equal(JSON.stringify(detail).includes(rows[0].key_hash), false);
        const auth = await rooms.authenticateA2a(room.id, first.apiKey);
        assert.equal(auth.member.id, first.member.id);
        assert.equal(auth.room.id, room.id);
        assert.ok(auth.member.lastUsedAt);
        assert.equal(
          (await rooms.authenticateA2a(room.id, first.apiKey)).member
            .lastUsedAt,
          auth.member.lastUsedAt,
        );
        assert.deepEqual(
          Object.keys(auth.member).sort(),
          [
            'id',
            'roomId',
            'name',
            'publicOrigin',
            'description',
            'enabled',
            'keyPrefix',
            'createdAt',
            'lastUsedAt',
            'revokedAt',
          ].sort(),
        );
        await assert.rejects(
          rooms.authenticateA2a(other.id, first.apiKey),
          code('UNAUTHORIZED'),
        );
        await assert.rejects(
          rooms.authenticateA2a(room.id, first.apiKey + 'x'),
          code('UNAUTHORIZED'),
        );
        await assert.rejects(
          rooms.createA2aMember('outsider', room.id, { name: 'No' }),
          code('NOT_FOUND'),
        );
      },
    );

    await t.test(
      'card settings persist and updates preserve omitted values',
      async () => {
        const app = groupChatA2aRoutes(rooms);
        const readCard = async (apiKey: string) => {
          const response = await app.request(
            `http://internal:8088/${room.id}/.well-known/agent-card.json`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
          );
          assert.equal(response.status, 200);
          return response.json();
        };
        assert.equal(first.member.publicOrigin, 'https://public.example');
        assert.equal(first.member.description, '调研与核验协作室');
        assert.equal(second.member.publicOrigin, null);
        assert.equal(second.member.description, '');
        const card = await readCard(first.apiKey);
        assert.equal(
          card.url,
          `https://public.example/api/a2a/rooms/${room.id}`,
        );
        assert.equal(card.description, first.member.description);
        const saved = await rooms.updateA2aMember(
          'alice',
          room.id,
          first.member.id,
          {
            publicOrigin: 'https://new.example',
            description: '新的协作说明',
          },
        );
        assert.equal(saved.publicOrigin, 'https://new.example');
        assert.equal(saved.description, '新的协作说明');
        const enabled = await rooms.updateA2aMember(
          'alice',
          room.id,
          first.member.id,
          {
            enabled: true,
          },
        );
        assert.equal(enabled.publicOrigin, saved.publicOrigin);
        assert.equal(enabled.description, saved.description);
        const updatedCard = await readCard(first.apiKey);
        assert.equal(
          updatedCard.url,
          `https://new.example/api/a2a/rooms/${room.id}`,
        );
        assert.equal(updatedCard.description, saved.description);
        await rooms.updateA2aMember('alice', room.id, first.member.id, {
          description: '',
        });
        const defaultCard = await readCard(second.apiKey);
        assert.equal(
          (await readCard(first.apiKey)).description,
          defaultCard.description,
        );
        assert.equal(
          defaultCard.url,
          `http://internal:8088/api/a2a/rooms/${room.id}`,
        );
        const refreshed = await rooms.get('alice', room.id);
        const member = refreshed.a2aMembers?.find(
          (item) => item.id === first.member.id,
        );
        assert.equal(member?.publicOrigin, 'https://new.example');
        assert.equal(member?.description, '');
      },
    );

    await t.test(
      'send identity is derived from the credential and retries cannot impersonate another member',
      async () => {
        const id = 'a2amessage0000001';
        const sent = await rooms.sendA2a(room.id, first.apiKey, {
          id,
          text: 'Hello from A2A',
        });
        assert.equal(sent.senderKind, 'a2a');
        assert.equal(sent.senderId, first.member.id);
        assert.equal(sent.senderName, 'Research');
        assert.deepEqual(
          await rooms.sendA2a(room.id, first.apiKey, {
            id,
            text: 'Hello from A2A',
          }),
          sent,
        );
        await assert.rejects(
          rooms.sendA2a(room.id, second.apiKey, { id, text: 'Hello from A2A' }),
          code('CONFLICT'),
        );
        const next = await rooms.sendA2a(room.id, second.apiKey, {
          id: 'a2amessage0000002',
          text: `@${room.botAgentId} Respond`,
          replyToId: sent.id,
        });
        assert.equal(next.senderId, second.member.id);
        assert.equal(next.replyToId, sent.id);
        const events = await database.query(
          'SELECT actor_id,kind FROM group_chat_events WHERE room_id=$1 ORDER BY kind',
          [room.id],
        );
        assert.deepEqual(events, [
          { actor_id: 'alice', kind: 'messages' },
          { actor_id: 'alice', kind: 'task' },
        ]);
        const page = await rooms.messagesA2a(room.id, first.apiKey, {
          after: sent.sequence,
          limit: 10,
        });
        assert.deepEqual(
          page.messages.map((message) => message.id),
          [next.id],
        );
        await assert.rejects(
          rooms.messagesA2a(other.id, first.apiKey, { limit: 10 }),
          code('UNAUTHORIZED'),
        );
        await assert.rejects(
          rooms.sendA2a(other.id, first.apiKey, {
            id: 'a2amessage0000003',
            text: 'No',
          }),
          code('UNAUTHORIZED'),
        );
        await rooms.updateA2aMember('alice', room.id, first.member.id, {
          name: 'Research renamed',
        });
        assert.equal(
          (await rooms.messages('alice', room.id, { limit: 10 })).messages[0]
            .senderName,
          'Research renamed',
        );
      },
    );

    await t.test(
      'A2A and local agent names share mention disambiguation',
      async () => {
        const worker = await rooms.addAgent('alice', room.id, {
          name: 'Research',
          settings: { agentId: null, model: null, reasoningEffort: 'auto' },
        });
        await rooms.sendA2a(room.id, first.apiKey, {
          id: 'a2amessage0000005',
          text: '@Research is ambiguous',
        });
        assert.deepEqual(
          await database.query(
            'SELECT id FROM group_chat_events WHERE agent_id=$1',
            [worker.id],
          ),
          [],
        );
        await rooms.sendA2a(room.id, first.apiKey, {
          id: 'a2amessage0000006',
          text: `@${worker.id} local work`,
        });
        assert.equal(
          (
            await database.query(
              'SELECT actor_id FROM group_chat_events WHERE agent_id=$1',
              [worker.id],
            )
          )[0].actor_id,
          'alice',
        );
      },
    );

    await t.test(
      'disabled and revoked credentials lose both read and write access while authors remain visible',
      async () => {
        await rooms.updateA2aMember('alice', room.id, first.member.id, {
          enabled: false,
        });
        await assert.rejects(
          rooms.authenticateA2a(room.id, first.apiKey),
          code('UNAUTHORIZED'),
        );
        await assert.rejects(
          rooms.messagesA2a(room.id, first.apiKey, { limit: 10 }),
          code('UNAUTHORIZED'),
        );
        await assert.rejects(
          rooms.sendA2a(room.id, first.apiKey, {
            id: 'a2amessage0000004',
            text: 'No',
          }),
          code('UNAUTHORIZED'),
        );
        await rooms.updateA2aMember('alice', room.id, first.member.id, {
          enabled: true,
        });
        await rooms.authenticateA2a(room.id, first.apiKey);
        const revoked = await rooms.revokeA2aMember(
          'alice',
          room.id,
          first.member.id,
        );
        assert.equal(revoked.enabled, false);
        assert.ok(revoked.revokedAt);
        assert.deepEqual(
          await rooms.revokeA2aMember('alice', room.id, first.member.id),
          revoked,
        );
        await assert.rejects(
          rooms.updateA2aMember('alice', room.id, first.member.id, {
            enabled: true,
          }),
          code('CONFLICT'),
        );
        await assert.rejects(
          rooms.authenticateA2a(room.id, first.apiKey),
          code('UNAUTHORIZED'),
        );
        assert.equal(
          (await rooms.messages('alice', room.id, { limit: 10 })).messages[0]
            .senderName,
          'Research renamed',
        );
        await rooms.authenticateA2a(room.id, second.apiKey);
      },
    );

    await t.test(
      'deleting active or revoked members removes room access and roster entries while preserving history',
      async () => {
        const deletionRoom = await rooms.create('alice', {
          title: 'Remove external integrations',
        });
        const active = await rooms.createA2aMember('alice', deletionRoom.id, {
          name: 'Collision',
        });
        const revoked = await rooms.createA2aMember('alice', deletionRoom.id, {
          name: 'Historical integration',
        });
        const survivor = await rooms.createA2aMember('alice', deletionRoom.id, {
          name: 'Remaining integration',
        });
        const worker = await rooms.addAgent('alice', deletionRoom.id, {
          name: 'Collision',
          settings: { agentId: null, model: null, reasoningEffort: 'auto' },
        });
        const historicalMessages = await Promise.all([
          rooms.sendA2a(deletionRoom.id, active.apiKey, {
            id: 'a2adelete00000001',
            text: 'Message from an active member',
          }),
          rooms.sendA2a(deletionRoom.id, revoked.apiKey, {
            id: 'a2adelete00000002',
            text: 'Message from a later revoked member',
          }),
        ]);
        await rooms.revokeA2aMember(
          'alice',
          deletionRoom.id,
          revoked.member.id,
        );
        await database.query(
          'INSERT INTO group_chat_members(room_id,user_id) VALUES($1,$2)',
          [deletionRoom.id, 'bob'],
        );
        await assert.rejects(
          rooms.removeA2aMember('bob', deletionRoom.id, active.member.id),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.removeA2aMember('outsider', deletionRoom.id, active.member.id),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.removeA2aMember('alice', other.id, active.member.id),
          code('NOT_FOUND'),
        );
        await rooms.authenticateA2a(deletionRoom.id, active.apiKey);
        await rooms.send('alice', deletionRoom.id, {
          id: 'a2adelete00000003',
          text: '@Collision is ambiguous before deletion',
        });
        assert.deepEqual(
          await database.query(
            'SELECT id FROM group_chat_events WHERE agent_id=$1',
            [worker.id],
          ),
          [],
        );

        for (const deleted of [active, revoked]) {
          assert.equal(
            await rooms.removeA2aMember(
              'alice',
              deletionRoom.id,
              deleted.member.id,
            ),
            undefined,
          );
          assert.equal(
            await rooms.removeA2aMember(
              'alice',
              deletionRoom.id,
              deleted.member.id,
            ),
            undefined,
          );
          assert.equal(
            (await rooms.get('alice', deletionRoom.id)).a2aMembers?.some(
              (member) => member.id === deleted.member.id,
            ),
            false,
          );
          await assert.rejects(
            rooms.authenticateA2a(deletionRoom.id, deleted.apiKey),
            code('UNAUTHORIZED'),
          );
          await assert.rejects(
            rooms.messagesA2a(deletionRoom.id, deleted.apiKey, { limit: 10 }),
            code('UNAUTHORIZED'),
          );
          await assert.rejects(
            rooms.sendA2a(deletionRoom.id, deleted.apiKey, {
              id: 'a2adelete00000004',
              text: 'Deleted members cannot send',
            }),
            code('UNAUTHORIZED'),
          );
          await assert.rejects(
            rooms.updateA2aMember('alice', deletionRoom.id, deleted.member.id, {
              name: 'Recreated',
              enabled: true,
            }),
            code('NOT_FOUND'),
          );
          await assert.rejects(
            rooms.revokeA2aMember('alice', deletionRoom.id, deleted.member.id),
            code('NOT_FOUND'),
          );
        }
        const detail = await rooms.get('alice', deletionRoom.id);
        assert.deepEqual(
          detail.a2aMembers?.map((member) => member.id),
          [survivor.member.id],
        );
        await rooms.authenticateA2a(deletionRoom.id, survivor.apiKey);
        const history = await rooms.messagesA2a(
          deletionRoom.id,
          survivor.apiKey,
          { limit: 10 },
        );
        for (const original of historicalMessages) {
          const historical = history.messages.find(
            (message) => message.id === original.id,
          );
          assert.equal(historical?.senderId, original.senderId);
          assert.equal(historical?.senderName, original.senderName);
          assert.equal(historical?.senderKind, 'a2a');
          assert.equal(historical?.text, original.text);
        }
        await rooms.sendA2a(deletionRoom.id, survivor.apiKey, {
          id: 'a2adelete00000005',
          text: '@Collision now identifies the local agent',
        });
        assert.deepEqual(
          await database.query(
            'SELECT id FROM group_chat_events WHERE agent_id=$1',
            [worker.id],
          ),
          [{ id: `mention:a2adelete00000005:${worker.id}` }],
        );
      },
    );

    await t.test(
      'the sponsor must remain active and currently allowed to manage room members',
      async () => {
        const project = await rooms.create('bob', {
          title: 'Project room by ordinary member',
          projectId: 'project000000001',
        });
        assert.equal(project.canManage, true);
        assert.equal(project.canManageMembers, false);
        await assert.rejects(
          rooms.createA2aMember('bob', project.id, { name: 'No' }),
          code('FORBIDDEN'),
        );
        const key = await rooms.createA2aMember('alice', project.id, {
          name: 'Project bot',
        });
        await rooms.authenticateA2a(project.id, key.apiKey);
        await assert.rejects(
          rooms.updateA2aMember('bob', project.id, key.member.id, {
            enabled: false,
          }),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.revokeA2aMember('bob', project.id, key.member.id),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.removeA2aMember('bob', project.id, key.member.id),
          code('FORBIDDEN'),
        );
        await database.query(
          "UPDATE project_members SET role='member' WHERE user_id='alice'",
        );
        await assert.rejects(
          rooms.authenticateA2a(project.id, key.apiKey),
          code('UNAUTHORIZED'),
        );
        await database.query(
          "UPDATE project_members SET role='owner' WHERE user_id='alice'",
        );
        await database.query("UPDATE users SET banned=true WHERE id='alice'");
        await assert.rejects(
          rooms.authenticateA2a(project.id, key.apiKey),
          code('UNAUTHORIZED'),
        );
        await assert.rejects(
          rooms.authenticateA2a(room.id, second.apiKey),
          code('UNAUTHORIZED'),
        );
        await database.query("UPDATE users SET banned=false WHERE id='alice'");
        await database.query(
          "UPDATE project_members SET deleted_at=now() WHERE user_id='alice'",
        );
        await assert.rejects(
          rooms.authenticateA2a(project.id, key.apiKey),
          code('UNAUTHORIZED'),
        );
        await database.query(
          "UPDATE project_members SET deleted_at=NULL WHERE user_id='alice'",
        );
        await database.query('UPDATE projects SET deleted_at=now()');
        await assert.rejects(
          rooms.authenticateA2a(project.id, key.apiKey),
          code('UNAUTHORIZED'),
        );
        await database.query(
          'UPDATE group_chats SET deleting=true WHERE id=$1',
          [room.id],
        );
        await assert.rejects(
          rooms.authenticateA2a(room.id, second.apiKey),
          code('UNAUTHORIZED'),
        );
        await database.query(
          'UPDATE group_chats SET deleting=false WHERE id=$1',
          [room.id],
        );
        await rooms.remove('alice', room.id);
        assert.deepEqual(
          await database.query(
            'SELECT id FROM group_chat_a2a_members WHERE room_id=$1',
            [room.id],
          ),
          [],
        );
        await assert.rejects(
          rooms.authenticateA2a(room.id, second.apiKey),
          code('UNAUTHORIZED'),
        );
      },
    );
  },
);
