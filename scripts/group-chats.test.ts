import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Project, ProjectMember } from '@aime/db';
import type { Auth } from '@aime/auth';
import {
  groupChatCreateSchema,
  groupChatMessageSchema,
  mentionedRoomAgentIds,
  roomAgentMention,
} from '@aime/shared/group-chats';
import { groupChatMessagesQuery } from '../packages/shared/src/rpc/group-chats.js';
import { GroupChatA2aMembers1780000030000 } from '../packages/db/src/migrations/1780000030000-group-chat-a2a-members.js';
import { GroupChatA2aMemberDeletion1780000031000 } from '../packages/db/src/migrations/1780000031000-group-chat-a2a-member-deletion.js';
import { GroupChatA2aCard1780000033000 } from '../packages/db/src/migrations/1780000033000-group-chat-a2a-card.js';
import { GroupChatIdleWake1780000029000 } from '../packages/db/src/migrations/1780000029000-group-chat-idle-wake.js';
import { GroupChatAgents1780000026000 } from '../packages/db/src/migrations/1780000026000-group-chat-agents.js';
import { GroupChatMembers1780000027000 } from '../packages/db/src/migrations/1780000027000-group-chat-members.js';
import { GroupChatReads1780000032000 } from '../packages/db/src/migrations/1780000032000-group-chat-reads.js';
import { CreateGroupChats1780000024000 } from '../packages/db/src/migrations/1780000024000-create-group-chats.js';
import { GroupChatService } from '../apps/server/src/modules/group-chats/service.js';
import { UserService } from '../apps/server/src/modules/users/service.js';
import { ProjectService } from '../apps/server/src/modules/projects/service.js';
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

test('room mentions match exact local names, multiple members and unambiguous IDs', () => {
  const agents = [
    { id: 'a', name: '调研' },
    { id: 'b', name: '调研助手' },
    { id: 'c', name: 'QA Team' },
    { id: 'd', name: '同名' },
    { id: 'e', name: '同名' },
  ];
  assert.deepEqual(
    mentionedRoomAgentIds(
      '@调研助手 帮忙，@QA Team 检查 @调研 再审 @调研助手',
      agents,
    ),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    mentionedRoomAgentIds(
      'email@调研助手.com `@QA Team` ```\n@调研\n``` @调研助手Extra @其他',
      agents,
    ),
    [],
  );
  assert.deepEqual(mentionedRoomAgentIds('@同名 @d @e', agents), ['d', 'e']);
  assert.equal(roomAgentMention(agents[3], agents), '@d');
});

test(
  'Postgres rooms, membership, concurrent sends, pagination and HTTP contracts',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `group_chat_test_${randomBytes(8).toString('hex')}`;
    const database = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      entities: [Project, ProjectMember],
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
    await database.query(`CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL, username text, image text, email text, banned boolean DEFAULT false);
    CREATE TABLE projects (id text PRIMARY KEY, name text NOT NULL DEFAULT 'Project', created_by text NOT NULL DEFAULT 'alice', metadata jsonb NOT NULL DEFAULT '{}', archived boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
    CREATE TABLE project_members (project_id text REFERENCES projects(id), user_id text, role text, pinned boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz, PRIMARY KEY(project_id, user_id));
    INSERT INTO users(id,name,username,image,email) VALUES ('alice','Alice','alice','/alice.png','private@example.com'), ('bob','Bob','bob','/bob.png','private2@example.com'), ('outsider','Outsider',NULL,NULL,NULL),('guest','Guest','guest','/guest.png','guest-private@example.com');
    INSERT INTO users(id,name,username,banned) VALUES ('banned','Banned','banned',true);
    INSERT INTO projects(id,deleted_at) VALUES ('project000000001',NULL);
    INSERT INTO project_members(project_id,user_id,role) VALUES ('project000000001','alice','owner'), ('project000000001','bob','member');`);
    const runner = database.createQueryRunner();
    await new CreateGroupChats1780000024000().up(runner);
    await new GroupChatAgents1780000026000().up(runner);
    await runner.query(`INSERT INTO group_chats(id,title,created_by) VALUES('legacybotroom001','Legacy','alice');
      INSERT INTO group_chat_agents(id,room_id,thread_id,name,role,enabled) VALUES('legacybot0000001','legacybotroom001','legacythread0001','Bot','bot',false)`);
    await new GroupChatMembers1780000027000().up(runner);
    await new GroupChatIdleWake1780000029000().up(runner);
    await new GroupChatA2aMembers1780000030000().up(runner);
    await new GroupChatA2aMemberDeletion1780000031000().up(runner);
    await new GroupChatA2aCard1780000033000().up(runner);
    await new GroupChatReads1780000032000().up(runner);
    assert.equal(
      (
        await runner.query(
          "SELECT enabled FROM group_chat_agents WHERE id='legacybot0000001'",
        )
      )[0].enabled,
      true,
    );
    await runner.query("DELETE FROM group_chats WHERE id='legacybotroom001'");
    await runner.release();
    const projects = new ProjectService(database);
    const rooms = new GroupChatService(database, projects);
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
      'unread receipts isolate members, exclude own messages and reactions, and never consume a newer reply',
      async () => {
        const room = await rooms.create('alice', { title: 'Unread room' });
        await rooms.addMember('alice', room.id, 'bob');
        const state = async (userId: string) =>
          (await rooms.unread(userId)).rooms.find(
            (item) => item.roomId === room.id,
          );
        const hasUnread = async (userId: string) => {
          const item = await state(userId);
          return (
            !!item && BigInt(item.latestSequence) > BigInt(item.readSequence)
          );
        };
        assert.equal(await hasUnread('alice'), false);
        const own = await rooms.send('alice', room.id, {
          id: 'unreadmessage001',
          text: 'Question',
        });
        assert.equal(await hasUnread('alice'), false);
        assert.equal(await hasUnread('bob'), true);
        assert.equal(await state('outsider'), undefined);
        await assert.rejects(
          rooms.markRead('outsider', room.id, { sequence: own.sequence }),
          code('NOT_FOUND'),
        );
        await rooms.markRead('bob', room.id, { sequence: own.sequence });
        const bot = room.agents.find((agent) => agent.role === 'bot')!;
        const reply = await rooms.sendAgent('alice', room.id, bot.id, {
          id: 'unreadmessage002',
          text: 'First answer',
        });
        const newer = await rooms.sendAgent('alice', room.id, bot.id, {
          id: 'unreadmessage003',
          text: 'Newer answer',
        });
        await rooms.markRead('alice', room.id, { sequence: reply.sequence });
        assert.equal(await hasUnread('alice'), true);
        assert.equal(await hasUnread('bob'), true);
        await Promise.all([
          rooms.markRead('alice', room.id, { sequence: newer.sequence }),
          rooms.markRead('alice', room.id, { sequence: own.sequence }),
        ]);
        assert.equal((await state('alice'))?.readSequence, newer.sequence);
        assert.equal(await hasUnread('alice'), false);
        assert.equal(await hasUnread('bob'), true);
        await rooms.react('bob', room.id, newer.id, {
          emoji: '👍',
          active: true,
        });
        assert.equal(await hasUnread('alice'), false);
        await rooms.send('alice', room.id, {
          id: 'unreadmessage004',
          text: 'Thanks',
        });
        assert.equal(await hasUnread('alice'), false);
        const external = await rooms.createA2aMember('alice', room.id, {
          name: 'Remote',
        });
        const remote = await rooms.sendA2a(room.id, external.apiKey, {
          id: 'unreadmessage005',
          text: 'Remote answer',
        });
        assert.equal((await state('alice'))?.latestSequence, remote.sequence);
        assert.equal(await hasUnread('alice'), true);
        assert.equal(
          (
            await rooms.markRead('alice', room.id, {
              sequence: '9223372036854775807',
            })
          ).readSequence,
          remote.sequence,
        );
        const afterRead = await rooms.send('bob', room.id, {
          id: 'unreadmessage006',
          text: 'Next message',
        });
        assert.equal(await hasUnread('alice'), true);
        assert.equal(
          (await state('alice'))?.latestSequence,
          afterRead.sequence,
        );
        assert.equal(
          (await rooms.get('alice', room.id)).agents.find(
            (agent) => agent.role === 'bot',
          )?.lastReadSequence,
          '0',
        );
        await database.query(
          'DELETE FROM group_chat_members WHERE room_id=$1 AND user_id=$2',
          [room.id, 'bob'],
        );
        assert.equal(await state('bob'), undefined);
        await assert.rejects(
          rooms.markRead('bob', room.id, { sequence: afterRead.sequence }),
          code('NOT_FOUND'),
        );
        const projectStates = (await rooms.unread('bob')).rooms.filter(
          (item) => item.projectId === project.projectId,
        );
        assert.deepEqual(
          projectStates.map((item) => item.roomId),
          [project.id],
        );
        await rooms.remove('alice', room.id);
        assert.equal(await state('alice'), undefined);
        assert.equal(
          (
            await database.query(
              'SELECT * FROM group_chat_reads WHERE room_id=$1',
              [room.id],
            )
          ).length,
          0,
        );
      },
    );

    await t.test(
      'idle wake-ups persist, respect plans and activity, and cannot duplicate a period',
      async () => {
        const room = await rooms.create('alice', { title: 'Idle bot' });
        const bot = room.agents[0];
        const worker = await rooms.addAgent('alice', room.id, {
          name: 'Worker',
          settings: { model: null, reasoningEffort: 'auto' },
        });
        const eventId = `idle:${bot.id}`;
        const readIdle = async () =>
          (
            await database.query(
              'SELECT * FROM group_chat_events WHERE id=$1',
              [eventId],
            )
          )[0];
        const age = () =>
          database.query(
            "UPDATE group_chat_agents SET idle_since=now()-interval '2 hours' WHERE id=$1",
            [bot.id],
          );
        const idleSince = async () =>
          (
            await database.query(
              'SELECT idle_since FROM group_chat_agents WHERE id=$1',
              [bot.id],
            )
          )[0].idle_since?.toISOString();
        assert.equal(bot.idleWakeHours, null);
        await age();
        await rooms.scheduleIdleEvents();
        assert.equal(await readIdle(), undefined);
        await assert.rejects(
          rooms.updateAgent('bob', room.id, bot.id, { idleWakeHours: 1 }),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.updateAgent('alice', room.id, worker.id, { idleWakeHours: 1 }),
          code('BAD_REQUEST'),
        );
        for (const idleWakeHours of [0, -1, Infinity, 8761])
          await assert.rejects(
            rooms.updateAgent('alice', room.id, bot.id, { idleWakeHours }),
          );
        assert.equal(
          (
            await rooms.updateAgent('alice', room.id, bot.id, {
              idleWakeHours: 0.5,
            })
          ).idleWakeHours,
          0.5,
        );
        await rooms.scheduleIdleEvents();
        assert.equal(
          await readIdle(),
          undefined,
          'Enabling starts a fresh timer',
        );
        await age();
        const beforeSnapshot = await idleSince();
        await rooms.setAgentStatus(bot.id, 'idle');
        assert.equal(
          await idleSince(),
          beforeSnapshot,
          'Repeated idle snapshots cannot reset the timer',
        );
        await Promise.all([
          rooms.scheduleIdleEvents(),
          rooms.scheduleIdleEvents(),
        ]);
        const first = await readIdle();
        assert.equal(first.kind, 'idle');
        assert.equal(first.agent_id, bot.id);
        assert.equal(first.actor_id, 'alice');
        assert.deepEqual(
          (
            await Promise.all([
              rooms.claimEvent(eventId, first.version),
              rooms.claimEvent(eventId, first.version),
            ])
          ).sort(),
          [false, true],
        );
        await rooms.acknowledgeEvent(eventId, first.version);
        await rooms.scheduleIdleEvents();
        assert.equal(
          (await readIdle()).version,
          first.version,
          'Completed triggers cannot spin while no new run has happened',
        );
        await rooms.setAgentStatus(bot.id, 'running');
        assert.equal(await idleSince(), undefined);
        await rooms.scheduleIdleEvents();
        assert.equal((await readIdle()).version, first.version);
        await rooms.setAgentStatus(bot.id, 'failed', 'MODEL_UNAVAILABLE');
        await rooms.scheduleIdleEvents();
        assert.equal(
          (await readIdle()).status,
          'completed',
          'Completion starts a new full interval',
        );
        await database.query(
          "UPDATE group_chat_events SET created_at=now()-interval '4 hours' WHERE id=$1",
          [eventId],
        );
        await age();
        const plan = await rooms.createPlan('alice', room.id, bot.id, {
          text: 'Tomorrow',
          runAt: new Date(Date.now() + 86400000).toISOString(),
        });
        await rooms.scheduleIdleEvents();
        assert.equal(
          (await readIdle()).status,
          'completed',
          'A future pending plan blocks idle startup',
        );
        await rooms.cancelPlan('alice', room.id, plan.id);
        await new GroupChatService(database, projects).scheduleIdleEvents();
        const afterRestart = await readIdle();
        assert.equal(afterRestart.status, 'pending');
        assert.notEqual(afterRestart.version, first.version);
        const racingPlan = await rooms.createPlan('alice', room.id, bot.id, {
          text: 'New plan',
          runAt: new Date(Date.now() + 86400000).toISOString(),
        });
        assert.equal(
          await rooms.claimEvent(eventId, afterRestart.version),
          false,
          'Recheck plans at dispatch, after enqueue',
        );
        assert.equal((await readIdle()).status, 'cancelled');
        await rooms.cancelPlan('alice', room.id, racingPlan.id);
        await rooms.scheduleIdleEvents();
        const beforeActivity = await readIdle();
        await rooms.setAgentStatus(bot.id, 'running');
        await rooms.setAgentStatus(bot.id, 'idle');
        assert.equal(
          await rooms.claimEvent(eventId, beforeActivity.version),
          false,
          'A newer run invalidates an old idle trigger',
        );
        await age();
        await rooms.scheduleIdleEvents();
        const beforeMessage = await readIdle();
        await rooms.send('alice', room.id, {
          id: 'pendinghuman0001',
          text: 'User work takes priority',
        });
        assert.equal(
          await rooms.claimEvent(eventId, beforeMessage.version),
          false,
        );
        await database.query(
          "UPDATE group_chat_events SET status='completed' WHERE room_id=$1 AND kind='messages'",
          [room.id],
        );
        await rooms.scheduleIdleEvents();
        assert.equal((await readIdle()).status, 'pending');
        await rooms.updateAgent('alice', room.id, bot.id, {
          idleWakeHours: null,
        });
        assert.equal((await readIdle()).status, 'cancelled');
        await rooms.scheduleIdleEvents();
        assert.equal((await readIdle()).status, 'cancelled');
        await rooms.remove('alice', room.id);
      },
    );

    await t.test(
      'reaction filters support bookmarks alone, keyword ranking and multiple labels without duplicates',
      async () => {
        const room = await rooms.create('alice', { title: 'Bookmarks' });
        const other = await rooms.create('alice', { title: 'Other bookmarks' });
        const bot = room.agents[0];
        for (const [id, text] of [
          ['searchbookmark01', 'report report report'],
          ['searchbookmark02', 'report decision'],
          ['searchbookmark03', 'important reference'],
        ]) {
          await rooms.send('alice', room.id, { id, text });
        }
        await rooms.send('alice', other.id, {
          id: 'otherbookmark001',
          text: 'report secret',
        });
        await rooms.react('alice', other.id, 'otherbookmark001', {
          emoji: '⭐',
          active: true,
        });
        await rooms.react('alice', room.id, 'searchbookmark02', {
          emoji: '⭐',
          active: true,
        });
        await rooms.react('alice', room.id, 'searchbookmark02', {
          emoji: '✅',
          active: true,
        });
        await rooms.react(
          'alice',
          room.id,
          'searchbookmark02',
          { emoji: '⭐', active: true },
          bot.id,
        );
        await rooms.react('alice', room.id, 'searchbookmark03', {
          emoji: '⭐',
          active: true,
        });
        const bookmarks = await rooms.search('alice', room.id, {
          reactions: ['⭐'],
          limit: 1,
        });
        assert.deepEqual(
          bookmarks.messages.map((item) => item.id),
          ['searchbookmark03'],
        );
        assert.equal(bookmarks.hasMore, true);
        const ranked = await rooms.search('alice', room.id, {
          query: 'report',
          reactions: ['⭐', '✅'],
          limit: 1,
        });
        assert.deepEqual(
          ranked.messages.map((item) => item.id),
          ['searchbookmark02'],
        );
        assert.equal(ranked.hasMore, false);
        assert.ok(ranked.messages[0].score > 0);
        await rooms.react('alice', room.id, 'searchbookmark02', {
          emoji: '⭐',
          active: false,
        });
        assert.equal(
          (
            await rooms.search('alice', room.id, {
              reactions: ['⭐'],
              limit: 10,
            })
          ).messages.length,
          2,
          'Other members can still bookmark the message',
        );
        await rooms.react(
          'alice',
          room.id,
          'searchbookmark02',
          { emoji: '⭐', active: false },
          bot.id,
        );
        assert.equal(
          (
            await rooms.search('alice', room.id, {
              query: 'report',
              reactions: ['⭐'],
              limit: 10,
            })
          ).messages.length,
          0,
        );
        assert.equal(
          (
            await rooms.search('alice', room.id, {
              query: 'report',
              reactions: ['✅'],
              limit: 10,
            })
          ).messages.length,
          1,
        );
        await rooms.remove('alice', other.id);
        await rooms.remove('alice', room.id);
      },
    );

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
        await database.query(`INSERT INTO projects(id,deleted_at) VALUES ('project000000002', NULL);
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
      'personal invitations share room access without granting management',
      async () => {
        const room = await rooms.create('alice', { title: 'Invited room' });
        assert.equal(room.canManageMembers, true);
        await assert.rejects(rooms.get('guest', room.id), code('NOT_FOUND'));
        assert.deepEqual(await rooms.searchUsers('alice', room.id, 'g'), []);
        assert.deepEqual(
          (await rooms.searchUsers('alice', room.id, 'guest')).map(
            (user) => user.id,
          ),
          ['guest'],
        );
        assert.deepEqual(
          await rooms.searchUsers('alice', room.id, 'banned'),
          [],
        );
        const added = await Promise.all([
          rooms.addMember('alice', room.id, 'guest'),
          rooms.addMember('alice', room.id, 'guest'),
        ]);
        assert.equal(added[0].id, 'guest');
        assert.deepEqual(Object.keys(added[0]).sort(), [
          'id',
          'image',
          'name',
          'username',
        ]);
        const shared = await rooms.get('guest', room.id);
        assert.deepEqual(shared.memberIds, ['alice', 'guest']);
        assert.equal(shared.canManage, false);
        assert.equal(shared.canManageMembers, false);
        assert.deepEqual(
          await rooms.searchUsers('alice', room.id, 'guest'),
          [],
        );
        assert.equal(
          (await rooms.list('guest', { page: 0, perPage: 20 })).rooms[0]
            .ownerName,
          'Alice',
        );
        const own = await rooms.openDefault('guest');
        assert.notEqual(own.id, room.id);
        assert.equal((await rooms.openDefault('guest')).id, own.id);
        await rooms.send('guest', room.id, {
          id: 'guestmessage0001',
          text: 'Joined',
        });
        assert.equal(
          (await rooms.messages('alice', room.id, { limit: 50 })).messages[0]
            .senderId,
          'guest',
        );
        assert.equal(
          (await users.lookup('guest', ['alice'], room.id))[0].id,
          'alice',
        );
        await assert.rejects(
          rooms.addMember('guest', room.id, 'bob'),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.searchUsers('guest', room.id, 'bob'),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.addMember('alice', room.id, 'banned'),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.addMember('alice', room.id, 'missing'),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.update('guest', room.id, 'No'),
          code('FORBIDDEN'),
        );
        await rooms.remove('alice', room.id);
        assert.equal(
          (
            await database.query(
              'SELECT count(*)::int AS count FROM group_chat_members WHERE room_id=$1',
              [room.id],
            )
          )[0].count,
          0,
        );
        await assert.rejects(rooms.get('guest', room.id), code('NOT_FOUND'));
        await rooms.remove('guest', own.id);
      },
    );

    await t.test(
      'project invitations use project member permissions and workspace membership',
      async () => {
        await database.query(`INSERT INTO projects(id) VALUES('project000000003');
        INSERT INTO project_members(project_id,user_id,role) VALUES('project000000003','alice','owner'),('project000000003','bob','member')`);
        const room = await rooms.create('bob', {
          title: 'Managed project room',
          projectId: 'project000000003',
        });
        assert.equal(room.canManage, true);
        assert.equal(room.canManageMembers, false);
        await assert.rejects(
          rooms.addMember('bob', room.id, 'guest'),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.searchUsers('bob', room.id, 'guest'),
          code('FORBIDDEN'),
        );
        assert.equal(
          (await rooms.searchUsers('alice', room.id, 'guest'))[0].id,
          'guest',
        );
        await Promise.all([
          rooms.addMember('alice', room.id, 'guest'),
          rooms.addMember('alice', room.id, 'guest'),
        ]);
        assert.equal(
          (await projects.assertMember('guest', room.projectId!)).role,
          'member',
        );
        assert.ok(
          (await rooms.get('guest', room.id)).memberIds.includes('guest'),
        );
        assert.deepEqual(
          await rooms.searchUsers('alice', room.id, 'guest'),
          [],
        );
        await projects.changeMember('alice', room.projectId!, 'bob');
        assert.equal(
          (await rooms.searchUsers('alice', room.id, 'bob'))[0].id,
          'bob',
        );
        await rooms.addMember('alice', room.id, 'bob');
        await projects.changeMember('alice', room.projectId!, 'guest');
        await assert.rejects(rooms.get('guest', room.id), code('NOT_FOUND'));
        await rooms.remove('alice', room.id);
        await database.query(
          "DELETE FROM project_members WHERE project_id='project000000003'",
        );
        await database.query(
          "DELETE FROM projects WHERE id='project000000003'",
        );
      },
    );

    await t.test(
      'lead agents remain enabled and only model/reasoning can change',
      async () => {
        const room = await rooms.create('alice', { title: 'Fixed leader' });
        const bot = room.agents[0];
        for (const update of [
          { name: 'Renamed' },
          { enabled: false },
          { enabled: true },
          { settings: { ...bot.settings, agentId: 'another-agent' } },
          {},
        ])
          await assert.rejects(
            rooms.updateAgent('alice', room.id, bot.id, update),
            code('FORBIDDEN'),
          );
        await assert.rejects(
          rooms.removeAgent('alice', room.id, bot.id),
          code('CONFLICT'),
        );
        const updated = await rooms.updateAgent('alice', room.id, bot.id, {
          settings: {
            ...bot.settings,
            model: 'provider/test-model',
            reasoningEffort: 'high',
          },
        });
        assert.equal(updated.settings.model, 'provider/test-model');
        assert.equal(updated.settings.reasoningEffort, 'high');
        assert.equal(updated.name, bot.name);
        assert.equal(updated.enabled, true);
        assert.equal(updated.threadId, bot.threadId);
        await assert.rejects(
          database.query(
            'UPDATE group_chat_agents SET enabled=false WHERE id=$1',
            [bot.id],
          ),
        );
        await rooms.remove('alice', room.id);
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
      'human attachments validate workspace access before persisting, including retries',
      async () => {
        const fileRooms = new GroupChatService(database, projects);
        const validations: Array<{
          userId: string;
          role: string;
          files: unknown;
        }> = [];
        fileRooms.setLifecycle({
          ensureAgent: async () => {},
          validateFiles: async (userId, agent, files) => {
            validations.push({ userId, role: agent.role, files });
            if (files.some((file) => !file.path.startsWith('./.uploads/')))
              throw new Error('File outside room workspace');
          },
        });
        const room = await fileRooms.create('alice', {
          title: 'Attachments',
          projectId: project.projectId!,
        });
        const files = [
          { path: './.uploads/drawing/sketch.png', name: 'sketch.png' },
        ];
        const body = { id: 'attachment0000001', text: 'sketch.png', files };
        const sent = await fileRooms.send('bob', room.id, body);
        assert.deepEqual(sent.files, files);
        assert.equal(sent.senderKind, 'user');
        assert.deepEqual(validations[0], { userId: 'bob', role: 'bot', files });
        assert.equal((await fileRooms.send('bob', room.id, body)).id, sent.id);
        await assert.rejects(
          fileRooms.send('bob', room.id, {
            ...body,
            files: [{ ...files[0], name: 'different.png' }],
          }),
          code('CONFLICT'),
        );
        await assert.rejects(
          fileRooms.send('bob', room.id, {
            ...body,
            id: 'attachment0000002',
            files: [{ path: '../private.png', name: 'private.png' }],
          }),
          /outside room workspace/,
        );
        const validationCount = validations.length;
        await assert.rejects(
          fileRooms.send('outsider', room.id, body),
          code('NOT_FOUND'),
        );
        assert.equal(validations.length, validationCount);
        const history = await fileRooms.messages('alice', room.id, {
          limit: 50,
        });
        assert.equal(history.messages.length, 1);
        assert.deepEqual(history.messages[0].files, files);
        await assert.rejects(
          rooms.send('alice', room.id, { ...body, id: 'attachment0000003' }),
          code('CONFLICT'),
        );
        await fileRooms.remove('alice', room.id);
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
      'agent membership, reactions, revisions, unread cursors and nonblocking UI',
      async () => {
        const room = await rooms.create('alice', {
          title: 'Agent room',
          projectId: project.projectId!,
        });
        const visits = await Promise.all(
          Array.from({ length: 10 }, () => rooms.get('bob', room.id)),
        );
        assert.equal(new Set(visits.map((value) => value.botAgentId)).size, 1);
        assert.equal(
          new Set(visits.map((value) => value.agents[0].threadId)).size,
          1,
        );
        const bot = room.agents[0];
        assert.equal(bot.role, 'bot');
        const worker = await rooms.addAgent('alice', room.id, {
          name: 'Research',
          settings: { agentId: null, model: null, reasoningEffort: 'auto' },
        });
        assert.notEqual(worker.threadId, bot.threadId);
        await assert.rejects(
          rooms.addAgent('bob', room.id, {
            name: 'No',
            settings: { model: null, reasoningEffort: 'auto' },
          }),
          code('FORBIDDEN'),
        );
        await assert.rejects(
          rooms.removeAgent('alice', room.id, bot.id),
          code('CONFLICT'),
        );
        const first = await rooms.send('bob', room.id, {
          id: 'roomfirst0000001',
          text: 'First',
        });
        const snapshot = await rooms.messages('alice', room.id, { limit: 50 });
        await rooms.react('bob', room.id, first.id, {
          emoji: '👍',
          active: true,
        });
        await rooms.react('alice', room.id, first.id, {
          emoji: '👍',
          active: true,
        });
        await rooms.react(
          'alice',
          room.id,
          first.id,
          { emoji: '🎉', active: true },
          bot.id,
        );
        const changes = await rooms.messages('alice', room.id, {
          limit: 50,
          afterRevision: snapshot.revision,
        });
        assert.equal(changes.messages.length, 1);
        assert.equal(changes.messages[0].sequence, first.sequence);
        assert.equal(changes.messages[0].reactions.length, 2);
        assert.deepEqual(
          changes.messages[0].reactions.find((r) => r.emoji === '👍')
            ?.memberIds,
          ['alice', 'bob'],
        );
        const removed = await rooms.react('bob', room.id, first.id, {
          emoji: '👍',
          active: false,
        });
        assert.deepEqual(
          removed.reactions.find((r) => r.emoji === '👍')?.memberIds,
          ['alice'],
        );
        await rooms.send('alice', room.id, {
          id: 'roomsecond000001',
          text: 'Second',
          replyToId: first.id,
        });
        const concurrent = await Promise.all([
          rooms.recentMessages('alice', room.id, bot.id, 1),
          rooms.recentMessages('alice', room.id, bot.id, 1),
        ]);
        assert.equal(
          new Set(concurrent.flatMap((page) => page.messages.map((m) => m.id)))
            .size,
          2,
        );
        assert.equal(
          (await rooms.recentMessages('alice', room.id, bot.id, 50)).messages
            .length,
          0,
        );
        assert.equal(
          (await rooms.recentMessages('alice', room.id, worker.id, 50)).messages
            .length,
          2,
        );
        const panel = await rooms.sendAgent('alice', room.id, bot.id, {
          id: 'roompanel0000001',
          text: 'Choose a task',
          ui: { html: '<button>Research</button>', title: 'Suggestions' },
        });
        const response = await rooms.respondUi('bob', room.id, panel.id, {
          id: 'roomresponse0001',
          data: { choice: 'research' },
        });
        assert.equal(response.senderKind, 'user');
        assert.equal(response.replyToId, panel.id);
        assert.deepEqual(response.uiResponse?.data, { choice: 'research' });
        assert.equal(
          (
            await rooms.respondUi('bob', room.id, panel.id, {
              id: response.id,
              data: { choice: 'research' },
            })
          ).sequence,
          response.sequence,
        );
        const other = await rooms.create('alice', { title: 'Other' });
        await assert.rejects(
          rooms.respondUi('alice', other.id, panel.id, {
            id: 'wrongresponse001',
            data: {},
          }),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          rooms.send('alice', other.id, {
            id: 'wrongreply000001',
            text: 'No',
            replyToId: first.id,
          }),
          code('NOT_FOUND'),
        );
        await rooms.updateAgent('alice', room.id, worker.id, {
          enabled: false,
        });
        await assert.rejects(
          rooms.sendAgent('alice', room.id, worker.id, {
            id: 'disabledsend0001',
            text: 'No',
          }),
          code('CONFLICT'),
        );
        await rooms.remove('alice', other.id);
        await rooms.remove('alice', room.id);
      },
    );

    await t.test(
      'human and agent mentions dispatch once to the existing room members',
      async () => {
        const room = await rooms.create('alice', { title: 'Mentions' });
        const bot = room.agents[0];
        const worker = await rooms.addAgent('alice', room.id, {
          name: '调研助手',
          settings: { model: null, reasoningEffort: 'auto' },
        });
        const disabled = await rooms.addAgent('alice', room.id, {
          name: '停用助手',
          enabled: false,
          settings: { model: null, reasoningEffort: 'auto' },
        });
        const message = {
          id: 'humanmention0001',
          text: '@调研助手 请调研 @调研助手 @停用助手',
        };
        await rooms.send('alice', room.id, message);
        await rooms.send('alice', room.id, message);
        let events = (await rooms.dueEvents()).filter(
          (event) => event.roomId === room.id,
        );
        assert.equal(events.length, 1);
        assert.equal(events[0].agentId, worker.id);
        assert.match(events[0].text, /from user Alice \(alice\)/);
        assert.match(events[0].text, /humanmention0001/);
        assert.notEqual(events[0].agentId, disabled.id);
        await rooms.sendAgent('alice', room.id, bot.id, {
          id: 'botmention000001',
          text: `@调研助手 分析 ${roomAgentMention(bot, room.agents)} 自己不触发`,
        });
        events = (await rooms.dueEvents()).filter(
          (event) => event.roomId === room.id,
        );
        assert.equal(events.length, 2);
        assert.ok(events.every((event) => event.agentId === worker.id));
        assert.match(events[1].text, /from agent/);
        const other = await rooms.create('alice', { title: 'Different room' });
        await rooms.send('alice', other.id, {
          id: 'outsidemention01',
          text: `@${worker.id} 不跨房间触发`,
        });
        assert.ok(
          !(await rooms.dueEvents()).some((event) => event.roomId === other.id),
        );
        await rooms.send('alice', room.id, {
          id: 'directbot0000001',
          text: `${roomAgentMention(bot, room.agents)} 请检查`,
        });
        assert.equal(
          (await rooms.dueEvents()).filter(
            (event) => event.roomId === room.id && event.agentId === bot.id,
          ).length,
          1,
        );
        assert.equal(
          (await rooms.getAgent('alice', room.id, worker.id)).threadId,
          worker.threadId,
        );
        await rooms.remove('alice', other.id);
        await rooms.remove('alice', room.id);
      },
    );

    await t.test(
      'durable trailing debounce, lease claims, delegation and one-shot plans',
      async () => {
        const room = await rooms.create('alice', { title: 'Event room' }),
          bot = room.agents[0];
        await rooms.send('alice', room.id, {
          id: 'eventmessage0001',
          text: 'Hello',
        });
        const eventId = `messages:${room.id}`;
        const [initial] = await database.query(
          'SELECT version,due_at FROM group_chat_events WHERE id=$1',
          [eventId],
        );
        assert.ok(initial.due_at.getTime() > Date.now() + 28_000);
        assert.equal(await rooms.claimEvent(eventId, initial.version), false);
        await database.query(
          "UPDATE group_chat_events SET due_at=now()-interval '1 second' WHERE id=$1",
          [eventId],
        );
        assert.equal(
          (await rooms.dueEvents()).filter((event) => event.id === eventId)
            .length,
          1,
        );
        await rooms.send('alice', room.id, {
          id: 'eventmessage0002',
          text: 'More',
        });
        const [updated] = await database.query(
          'SELECT version,due_at FROM group_chat_events WHERE id=$1',
          [eventId],
        );
        assert.notEqual(updated.version, initial.version);
        assert.equal(await rooms.claimEvent(eventId, initial.version), false);
        await rooms.acknowledgeEvent(eventId, initial.version);
        assert.equal(
          (
            await database.query(
              'SELECT status FROM group_chat_events WHERE id=$1',
              [eventId],
            )
          )[0].status,
          'pending',
        );
        await rooms.sendAgent('alice', room.id, bot.id, {
          id: 'eventbotsend0001',
          text: 'Visible response',
        });
        assert.equal(
          (
            await database.query(
              'SELECT version FROM group_chat_events WHERE id=$1',
              [eventId],
            )
          )[0].version,
          updated.version,
        );
        await database.query(
          "UPDATE group_chat_events SET due_at=now()-interval '1 second' WHERE id=$1",
          [eventId],
        );
        const claims = await Promise.all([
          rooms.claimEvent(eventId, updated.version),
          rooms.claimEvent(eventId, updated.version),
        ]);
        assert.deepEqual(claims.sort(), [false, true]);
        await rooms.acknowledgeEvent(eventId, updated.version);
        assert.equal(
          (await rooms.dueEvents()).some((event) => event.id === eventId),
          false,
        );
        const worker = await rooms.addAgent('alice', room.id, {
          name: 'Worker',
          settings: { model: null, reasoningEffort: 'auto' },
        });
        await rooms.sendAgent('alice', room.id, bot.id, {
          id: 'delegatedtask001',
          text: 'Research this',
          targetAgentId: worker.id,
        });
        assert.ok(
          (await rooms.dueEvents()).some(
            (event) => event.agentId === worker.id && event.kind === 'task',
          ),
        );
        const plan = await rooms.createPlan('alice', room.id, bot.id, {
          id: 'scheduledplan001',
          text: 'Check progress',
          runAt: new Date(Date.now() + 60_000).toISOString(),
        });
        assert.equal(plan.agentId, bot.id);
        assert.equal(
          (await rooms.getAgent('alice', room.id, bot.id)).threadId,
          bot.threadId,
        );
        assert.equal((await rooms.plans('alice', room.id))[0].id, plan.id);
        await rooms.deferEvent(plan.id, plan.version, undefined, 1000);
        assert.equal(
          (await rooms.plans('alice', room.id))[0].dueAt,
          plan.dueAt,
        );
        await rooms.cancelPlan('alice', room.id, plan.id);
        assert.equal(
          (await rooms.plans('alice', room.id))[0].status,
          'cancelled',
        );
        const retry = await rooms.createPlan('alice', room.id, bot.id, {
          text: 'Retry',
          runAt: new Date(Date.now() + 60_000).toISOString(),
        });
        for (let i = 0; i < 3; i++)
          await rooms.deferEvent(
            retry.id,
            retry.version,
            'MODEL_UNAVAILABLE',
            1000,
          );
        assert.equal(
          (await rooms.plans('alice', room.id)).find((p) => p.id === retry.id)
            ?.status,
          'failed',
        );
        await rooms.remove('alice', room.id);
      },
    );

    await t.test(
      'messages include server-resolved sender names in history, unread, search and mutation responses',
      async () => {
        await database.query(`INSERT INTO users(id,name,username,email) VALUES
          ('named-sender','王小明','xiaoming','private-sender@example.com'),
          ('handle-sender','   ','handleonly','private-handle@example.com')`);
        const room = await rooms.create('alice', { title: 'Sender names' });
        try {
          await rooms.addMember('alice', room.id, 'named-sender');
          await rooms.addMember('alice', room.id, 'handle-sender');
          const named = await rooms.send('named-sender', room.id, {
            id: 'sendernames00001',
            text: 'senderidentity original content',
          });
          assert.equal(named.senderName, '王小明');
          assert.equal(named.senderUsername, 'xiaoming');
          assert.equal(named.text, 'senderidentity original content');
          const handle = await rooms.send('handle-sender', room.id, {
            id: 'sendernames00002',
            text: 'senderidentity username fallback',
          });
          assert.equal(handle.senderName, null);
          assert.equal(handle.senderUsername, 'handleonly');
          const bot = (await rooms.get('alice', room.id)).agents[0];
          const reply = await rooms.sendAgent('alice', room.id, bot.id, {
            id: 'sendernames00003',
            text: 'senderidentity agent reply',
            replyToId: named.id,
          });
          assert.equal(reply.senderName, bot.name);
          assert.equal(reply.senderUsername, null);
          const unread = await rooms.recentMessages('alice', room.id, bot.id);
          assert.deepEqual(
            unread.messages.map((message) => [
              message.senderName,
              message.senderUsername,
            ]),
            [
              ['王小明', 'xiaoming'],
              [null, 'handleonly'],
            ],
          );
          const history = await rooms.messages('alice', room.id, { limit: 50 });
          const search = await rooms.search('alice', room.id, {
            query: 'senderidentity',
            limit: 50,
          });
          for (const messages of [history.messages, search.messages]) {
            assert.equal(messages.length, 3);
            assert.equal(
              messages.find((message) => message.id === named.id)?.senderName,
              '王小明',
            );
            assert.equal(
              messages.find((message) => message.id === handle.id)
                ?.senderUsername,
              'handleonly',
            );
            assert.equal(
              JSON.stringify(messages).includes('private-sender@example.com'),
              false,
            );
          }
          const reaction = await rooms.react('alice', room.id, named.id, {
            emoji: '👍',
            active: true,
          });
          assert.equal(reaction.senderName, '王小明');
          assert.equal(reaction.senderUsername, 'xiaoming');
          await database.query(
            "UPDATE users SET name='小明新昵称' WHERE id='named-sender'",
          );
          assert.equal(
            (await rooms.messages('alice', room.id, { limit: 50 })).messages[0]
              .senderName,
            '小明新昵称',
          );
        } finally {
          await rooms.remove('alice', room.id);
          await database.query(
            "DELETE FROM users WHERE id IN ('named-sender','handle-sender')",
          );
        }
      },
    );

    await t.test(
      'room-scoped BM25 ranks Chinese and English messages and indexes legacy history',
      async () => {
        const room = await rooms.create('alice', { title: 'Search room' });
        const chinese = await rooms.send('alice', room.id, {
          id: 'searchchinese001',
          text: '量化策略回测结果分析',
        });
        await rooms.send('alice', room.id, {
          id: 'searchenglish001',
          text: 'Strategy backtest results with market analysis',
        });
        await rooms.send('alice', room.id, {
          id: 'searchenglish002',
          text: 'Strategy strategy strategy',
        });
        const zh = await rooms.search('alice', room.id, {
          query: '策略回测',
          limit: 20,
        });
        assert.equal(zh.messages[0].id, chinese.id);
        assert.ok(zh.messages[0].score > 0);
        const en = await rooms.search('alice', room.id, {
          query: 'strategy',
          limit: 1,
        });
        assert.equal(en.messages.length, 1);
        assert.equal(en.messages[0].id, 'searchenglish002');
        assert.equal(en.hasMore, true);
        await database.query(
          "UPDATE group_chat_messages SET search_terms='{}',token_count=0 WHERE room_id=$1 AND id=$2",
          [room.id, chinese.id],
        );
        assert.equal(
          (await rooms.search('alice', room.id, { query: '回测', limit: 20 }))
            .messages[0].id,
          chinese.id,
        );
        await assert.rejects(
          rooms.search('bob', room.id, { query: 'strategy', limit: 20 }),
          code('NOT_FOUND'),
        );
        await rooms.remove('alice', room.id);
      },
    );

    await t.test(
      'deletion tombstones prevent thread reprovisioning and cleanup can retry',
      async () => {
        const room = await rooms.create('alice', { title: 'Delete room' });
        let fail = true,
          provisions = 0;
        rooms.setLifecycle({
          ensureAgent: async () => {
            provisions++;
          },
          removeAgents: async () => {
            if (fail) throw new Error('cleanup failed');
          },
        });
        await assert.rejects(rooms.remove('alice', room.id), /cleanup failed/);
        await assert.rejects(rooms.get('alice', room.id), code('NOT_FOUND'));
        assert.equal(provisions, 0);
        fail = false;
        await rooms.remove('alice', room.id);
        assert.equal(
          (
            await database.query(
              'SELECT count(*)::int AS count FROM group_chat_agents WHERE room_id=$1',
              [room.id],
            )
          )[0].count,
          0,
        );
        rooms.setLifecycle({ ensureAgent: async () => {} });
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
        assert.equal(
          (await request('/group-chats/unread', 'GET', undefined, '')).status,
          401,
        );
        const unread = await request('/group-chats/unread');
        assert.equal(unread.status, 200);
        assert.ok(
          (await unread.json()).rooms.some(
            (room: { roomId: string }) => room.roomId === project.id,
          ),
        );
        const receipt = await request(
          `/group-chats/${project.id}/read`,
          'POST',
          { sequence: '0' },
        );
        assert.equal(receipt.status, 200);
        assert.equal(typeof (await receipt.json()).readSequence, 'string');
        assert.equal(
          (
            await request(`/group-chats/${project.id}/read`, 'POST', {
              sequence: '-1',
            })
          ).status,
          400,
        );
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

        const a2aRoom = await rooms.create('alice', {
          title: 'HTTP A2A deletion',
        });
        await rooms.addMember('alice', a2aRoom.id, 'bob');
        const createdA2a = await request(
          `/group-chats/${a2aRoom.id}/a2a-members`,
          'POST',
          { name: 'HTTP integration' },
        );
        assert.equal(createdA2a.status, 201);
        const credential = await createdA2a.json();
        const memberPath = `/group-chats/${a2aRoom.id}/a2a-members/${credential.member.id}`;
        assert.equal(
          (await request(memberPath, 'DELETE', undefined, '')).status,
          401,
        );
        assert.equal(
          (await request(memberPath, 'DELETE', undefined, 'bob')).status,
          403,
        );
        assert.equal(
          (
            await request(
              memberPath,
              'DELETE',
              undefined,
              'alice',
              'https://other.invalid',
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await app.request(`http://localhost/api${memberPath}`, {
              method: 'DELETE',
              headers: {
                authorization: `Bearer ${credential.apiKey}`,
                'x-test-user': 'alice',
                origin: 'http://localhost',
              },
            })
          ).status,
          401,
        );
        await rooms.authenticateA2a(a2aRoom.id, credential.apiKey);
        const revokedA2a = await request(`${memberPath}/revoke`, 'POST');
        assert.equal(revokedA2a.status, 200);
        assert.ok((await revokedA2a.json()).revokedAt);
        assert.equal(
          (await rooms.get('alice', a2aRoom.id)).a2aMembers?.length,
          1,
        );
        const deletedA2a = await request(memberPath, 'DELETE');
        assert.equal(deletedA2a.status, 204);
        assert.equal(await deletedA2a.text(), '');
        assert.equal((await request(memberPath, 'DELETE')).status, 204);
        assert.deepEqual((await rooms.get('alice', a2aRoom.id)).a2aMembers, []);
        await assert.rejects(
          rooms.authenticateA2a(a2aRoom.id, credential.apiKey),
          code('UNAUTHORIZED'),
        );

        const rpcCredential = await rooms.createA2aMember('alice', a2aRoom.id, {
          name: 'RPC integration',
        });
        const removedViaRpc = await request(
          '/rpc/groupChats/removeA2aMember',
          'POST',
          {
            json: {
              params: { roomId: a2aRoom.id, memberId: rpcCredential.member.id },
            },
          },
        );
        assert.ok(removedViaRpc.ok);
        assert.deepEqual((await rooms.get('alice', a2aRoom.id)).a2aMembers, []);
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
