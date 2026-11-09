import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { PLUGIN_API_VERSION, pluginManifestSchema } from '@app/plugin-sdk';
import { groupChatScopeSchema } from '@aime/shared/group-chats';
import { createRoomUnreadResource } from '../apps/web/src/pages/group-chats/unread-resource.js';
import { PluginService } from '../apps/server/src/modules/plugins/service.js';
import { PluginRoomAccess } from '../apps/server/src/modules/group-chats/plugin-access.js';
import { GroupChatService } from '../apps/server/src/modules/group-chats/service.js';
import { createGroupChatRuntime } from '../apps/server/src/modules/group-chats/runtime.js';
import { groupChatThreadBinding } from '../apps/server/src/modules/group-chats/metadata.js';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { createApp } from '../apps/server/src/app.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { CreatePluginTables1780000014000 } from '../packages/db/src/migrations/1780000014000-create-plugin-tables.js';
import { PluginConfiguration1780000022000 } from '../packages/db/src/migrations/1780000022000-plugin-configuration.js';
import { PluginAccess1780000025000 } from '../packages/db/src/migrations/1780000025000-plugin-access.js';
import { CreateGroupChats1780000024000 } from '../packages/db/src/migrations/1780000024000-create-group-chats.js';
import { GroupChatAgents1780000026000 } from '../packages/db/src/migrations/1780000026000-group-chat-agents.js';
import { GroupChatMembers1780000027000 } from '../packages/db/src/migrations/1780000027000-group-chat-members.js';
import { GroupChatMemberRoles1780000043000 } from '../packages/db/src/migrations/1780000043000-group-chat-member-roles.js';
import { GroupChatIdleWake1780000029000 } from '../packages/db/src/migrations/1780000029000-group-chat-idle-wake.js';
import { GroupChatA2aMembers1780000030000 } from '../packages/db/src/migrations/1780000030000-group-chat-a2a-members.js';
import { GroupChatA2aMemberDeletion1780000031000 } from '../packages/db/src/migrations/1780000031000-group-chat-a2a-member-deletion.js';
import { GroupChatReads1780000032000 } from '../packages/db/src/migrations/1780000032000-group-chat-reads.js';
import { GroupChatA2aCard1780000033000 } from '../packages/db/src/migrations/1780000033000-group-chat-a2a-card.js';
import { GroupChatChoices1780000034000 } from '../packages/db/src/migrations/1780000034000-group-chat-choices.js';
import { PluginGroupChats1780000042000 } from '../packages/db/src/migrations/1780000042000-plugin-group-chats.js';

const manifest = (id: string, groupChat = true) =>
  pluginManifestSchema.parse({
    id,
    name: id,
    description: '',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    workspace: true,
    groupChat,
  });
const code = (code: string) => (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;

test('plugin room opt-in requires its workspace and forbids ambiguous scopes', () => {
  assert.equal(
    pluginManifestSchema.safeParse({ ...manifest('demo'), workspace: false })
      .success,
    false,
  );
  assert.equal(
    pluginManifestSchema.safeParse({
      ...manifest('demo'),
      workspace: undefined,
    }).success,
    false,
  );
  assert.equal(
    pluginManifestSchema.safeParse({
      ...manifest('demo'),
      groupChat: false,
      workspace: false,
    }).success,
    true,
  );
  assert.equal(
    groupChatScopeSchema.safeParse({
      projectId: 'project000000001',
      pluginId: 'demo',
    }).success,
    false,
  );
  assert.equal(
    groupChatScopeSchema.safeParse({ pluginId: '../escape' }).success,
    false,
  );
});

test('plugin unread markers cannot light up personal or other plugin navigation', () => {
  const resource = createRoomUnreadResource(async () => ({
    readSequence: '3',
  }));
  resource.receive([
    {
      roomId: 'room',
      projectId: null,
      pluginId: 'demo',
      latestSequence: '3',
      readSequence: '0',
    },
  ]);
  assert.equal(resource.hasUnread({ pluginId: 'demo' }), true);
  assert.equal(resource.hasUnread({}), false);
  assert.equal(resource.hasUnread({ pluginId: 'other' }), false);
  assert.equal(resource.hasUnread({ projectId: 'project000000001' }), false);
});

test(
  'plugin rooms: shared grants, isolation, native thread workspaces and lifecycle',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `plugin_rooms_${randomBytes(8).toString('hex')}`;
    const root = await mkdtemp('/tmp/plugin-rooms-');
    const db = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      extra: { options: `-c search_path=${schema}` },
    });
    await db.initialize();
    const resources: { plugins?: PluginService; threads?: ThreadService } = {};
    t.after(async () => {
      await resources.threads?.shutdown();
      await resources.plugins?.dispose();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.destroy();
      await rm(root, { recursive: true, force: true });
    });
    await db.query(`CREATE SCHEMA "${schema}";
    CREATE TABLE users(id text PRIMARY KEY,name text,username text,image text,role text,banned boolean DEFAULT false);
    INSERT INTO users(id,name,role) VALUES ('alice','Alice','user'),('bob','Bob','user'),('outsider','Outsider','user'),('admin','Admin','admin');
    CREATE TABLE projects(id text PRIMARY KEY,deleted_at timestamptz);
    CREATE TABLE project_members(project_id text,user_id text,role text,deleted_at timestamptz,created_at timestamptz DEFAULT now());`);
    const queryRunner = db.createQueryRunner();
    for (const migration of [
      new CreatePluginTables1780000014000(),
      new PluginConfiguration1780000022000(),
      new PluginAccess1780000025000(),
      new CreateGroupChats1780000024000(),
      new GroupChatAgents1780000026000(),
      new GroupChatMembers1780000027000(),
      new GroupChatMemberRoles1780000043000(),
      new GroupChatIdleWake1780000029000(),
      new GroupChatA2aMembers1780000030000(),
      new GroupChatA2aMemberDeletion1780000031000(),
      new GroupChatReads1780000032000(),
      new GroupChatA2aCard1780000033000(),
      new GroupChatChoices1780000034000(),
      new PluginGroupChats1780000042000(),
    ])
      await migration.up(queryRunner);
    await queryRunner.release();
    const definitions = ['demo', 'other', 'no-room'].map((id) => ({
      manifest: manifest(id, id !== 'no-room'),
      database: { entities: [], migrations: [] },
      createServer: () => ({}),
    }));
    await db.query(
      `INSERT INTO plugin_installations(id,version,enabled,access) SELECT id,'1.0.0',true,'{"mode":"selected","userIds":["alice","bob"]}'::jsonb FROM unnest($1::text[]) AS id`,
      [definitions.map((item) => item.manifest.id)],
    );
    const plugins = new PluginService(db, definitions, 0, {
      applicationRoot: root,
      workspaceRoot: root,
    });
    resources.plugins = plugins;
    await plugins.start();
    const rooms = new GroupChatService(
      db,
      undefined,
      new PluginRoomAccess(db, plugins),
    );
    const { memory } = fakeMemory();
    const threads = new ThreadService(memory, {
      open: async () => assert.fail('This test must not run a model'),
      pluginWorkspace: (id, userId) => plugins!.workspaceDirectory(id, userId),
      createWorkspace: async () =>
        assert.fail('Plugin rooms must never use project or personal storage'),
      personalSharedDirectory: async () =>
        assert.fail('Plugin rooms must never use personal shared storage'),
      validate: async () => {},
      assertPluginAccess: (id, userId) =>
        plugins!.access.assertAllowed(id, userId),
      assertGroupChatAccess: async (userId, thread) => {
        const binding = groupChatThreadBinding(thread.metadata)!;
        await rooms.getAgent(userId, binding.roomId, binding.memberId);
      },
    } satisfies ChatRunner);
    resources.threads = threads;
    const runtime = createGroupChatRuntime(rooms, threads);
    t.after(() => runtime.shutdown());
    await assert.rejects(
      threads.ensureGroupChatThread({
        roomId: 'missing-room',
        memberId: 'missing-agent',
        threadId: 'missing-thread',
        role: 'bot',
        userId: 'alice',
        pluginId: 'missing',
        title: 'Unavailable',
        settings: { model: null, reasoningEffort: 'auto' },
      }),
      code('WORKSPACE_UNAVAILABLE'),
    );
    assert.equal(
      await memory.getThreadById({ threadId: 'missing-thread' }),
      null,
    );
    const first = await rooms.openDefault('alice', undefined, 'demo');
    assert.deepEqual(first.memberIds, ['alice']);
    await assert.rejects(rooms.get('bob', first.id), code('NOT_FOUND'));
    assert.equal((await rooms.unread('bob')).rooms.length, 0);
    assert.deepEqual(
      (await rooms.searchUsers('alice', first.id, 'Bo')).map((user) => user.id),
      ['bob'],
    );
    assert.deepEqual(await rooms.searchUsers('alice', first.id, 'Out'), []);
    await rooms.addMember('alice', first.id, 'bob');
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        rooms.openDefault(i % 2 ? 'alice' : 'bob', undefined, 'demo'),
      ),
    );
    assert.ok(concurrent.every((room) => room.id === first.id));
    assert.deepEqual((await rooms.get('alice', first.id)).memberIds.sort(), [
      'alice',
      'bob',
    ]);
    assert.equal((await rooms.get('bob', first.id)).canManage, false);
    assert.equal((await rooms.get('admin', first.id)).canManage, true);
    assert.deepEqual((await rooms.get('admin', first.id)).removableMemberIds, [
      'bob',
    ]);
    await assert.rejects(
      rooms.removeMember('bob', first.id, 'alice'),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      rooms.removeMember('admin', first.id, 'alice'),
      code('FORBIDDEN'),
    );
    await rooms.removeMember('admin', first.id, 'bob');
    await assert.rejects(rooms.get('bob', first.id), code('NOT_FOUND'));
    await rooms.addMember('alice', first.id, 'bob');
    await rooms.updateMemberRole('alice', first.id, 'bob', 'admin');
    const roomAdmin = await rooms.get('bob', first.id);
    assert.equal(roomAdmin.canManage, true);
    assert.equal(roomAdmin.canManageMembers, true);
    assert.equal(roomAdmin.canManageMemberRoles, false);
    assert.equal(
      roomAdmin.members?.find((member) => member.userId === 'bob')?.role,
      'admin',
    );
    await assert.rejects(
      rooms.updateMemberRole('bob', first.id, 'alice', 'member'),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      rooms.addMember('bob', first.id, 'outsider'),
      code('FORBIDDEN'),
    );
    await db.query(
      'INSERT INTO group_chat_members(room_id,user_id) VALUES($1,$2)',
      [first.id, 'admin'],
    );
    const systemAdmin = (await rooms.get('alice', first.id)).members?.find(
      (member) => member.userId === 'admin',
    );
    assert.equal(systemAdmin?.role, 'admin');
    assert.equal(systemAdmin?.systemAdmin, true);
    assert.equal(systemAdmin?.canChangeRole, false);
    assert.equal(systemAdmin?.canRemove, false);
    await assert.rejects(
      rooms.updateMemberRole('alice', first.id, 'admin', 'member'),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      rooms.removeMember('alice', first.id, 'admin'),
      code('FORBIDDEN'),
    );
    await rooms.updateMemberRole('admin', first.id, 'bob', 'member');
    assert.equal((await rooms.get('bob', first.id)).canManage, false);
    await db.query(
      'DELETE FROM group_chat_members WHERE room_id=$1 AND user_id=$2',
      [first.id, 'admin'],
    );
    assert.equal(
      (await rooms.create('bob', { title: 'Same', pluginId: 'demo' })).id,
      first.id,
    );
    assert.equal(
      (await rooms.list('alice', { page: 0, perPage: 20 })).rooms.length,
      0,
    );
    assert.equal(
      (await rooms.list('alice', { pluginId: 'demo', page: 0, perPage: 20 }))
        .rooms.length,
      1,
    );
    await assert.rejects(rooms.get('outsider', first.id), code('NOT_FOUND'));
    await assert.rejects(
      rooms.openDefault('alice', undefined, 'no-room'),
      code('NOT_FOUND'),
    );
    await assert.rejects(
      rooms.openDefault('alice', undefined, 'missing'),
      code('NOT_FOUND'),
    );
    await assert.rejects(
      rooms.addMember('alice', first.id, 'outsider'),
      code('FORBIDDEN'),
    );
    const worker = await rooms.addAgent('alice', first.id, {
      name: 'Worker',
      settings: { model: null, reasoningEffort: 'auto' },
    });
    const directory = join(root, 'plugins', 'demo');
    for (const agent of [first.agents[0], worker]) {
      assert.equal(
        await threads.workspaceDirectory('bob', agent.threadId),
        directory,
      );
      assert.equal(
        (await memory.getThreadById({ threadId: agent.threadId }))?.metadata
          ?.workspacePlugin,
        'demo',
      );
      assert.equal(
        (await memory.getThreadById({ threadId: agent.threadId }))?.resourceId,
        'plugin:demo',
      );
    }
    await writeFile(join(directory, 'keep.txt'), 'plugin-owned');
    await assert.rejects(
      threads.withWorkspaceFiles(
        'bob',
        worker.threadId,
        async () => 'forbidden',
        'shared',
      ),
      code('FILE_FORBIDDEN'),
    );
    await assert.rejects(
      threads.resolveWorkspaceFile(
        'bob',
        worker.threadId,
        '../shared/private.txt',
      ),
      code('FILE_OUTSIDE_WORKSPACE'),
    );
    const other = await rooms.openDefault('alice', undefined, 'other');
    assert.notEqual(other.id, first.id);
    await assert.rejects(rooms.get('bob', other.id), code('NOT_FOUND'));
    const otherGrants = await plugins.access.get('other');
    await plugins.access.save('other', {
      access: { mode: 'all', userIds: [] },
      revision: otherGrants.revision,
    });
    assert.deepEqual(
      (await rooms.searchUsers('alice', other.id, 'Out')).map(
        (user) => user.id,
      ),
      ['outsider'],
    );
    await rooms.addMember('alice', other.id, 'outsider');
    await rooms.addMember('alice', other.id, 'bob');
    assert.equal((await rooms.get('outsider', other.id)).id, other.id);
    assert.notEqual(
      await threads.workspaceDirectory('bob', other.agents[0].threadId),
      directory,
    );
    await rooms.send('alice', first.id, {
      id: 'message000000001',
      text: 'Shared room',
    });
    assert.equal(
      (await rooms.messages('bob', first.id, { limit: 50 })).messages[0].text,
      'Shared room',
    );
    assert.ok(
      !(await rooms.unread('outsider')).rooms.some(
        (room) => room.roomId === first.id,
      ),
    );
    assert.equal(
      (await rooms.unread('bob')).rooms.find((room) => room.roomId === first.id)
        ?.pluginId,
      'demo',
    );
    const external = await rooms.createA2aMember('alice', first.id, {
      name: 'External',
    });
    const grants = await plugins.access.get('demo');
    await plugins.access.save('demo', {
      access: { mode: 'selected', userIds: ['alice'] },
      revision: grants.revision,
    });
    await assert.rejects(
      threads.workspaceDirectory('bob', worker.threadId),
      code('NOT_FOUND'),
    );
    await assert.rejects(
      rooms.send('bob', first.id, { id: 'message000000002', text: 'Blocked' }),
      code('NOT_FOUND'),
    );
    assert.ok(!(await rooms.get('alice', first.id)).memberIds.includes('bob'));
    await db.query(
      'UPDATE group_chat_events SET due_at=now() WHERE room_id=$1',
      [first.id],
    );
    const due = await rooms.dueEvents();
    assert.ok(due.some((event) => event.roomId === first.id));
    await plugins.setEnabled('demo', false);
    await runtime.tick();
    await assert.rejects(rooms.get('alice', first.id), code('NOT_FOUND'));
    await assert.rejects(
      rooms.authenticateA2a(first.id, external.apiKey),
      code('UNAUTHORIZED'),
    );
    await assert.rejects(
      threads.workspaceDirectory('alice', worker.threadId),
      code('NOT_FOUND'),
    );
    assert.ok(
      !(await rooms.dueEvents()).some((event) => event.roomId === first.id),
    );
    const pending = await db.query(
      'SELECT status,attempts FROM group_chat_events WHERE room_id=$1',
      [first.id],
    );
    assert.ok(
      pending.every(
        (event: { status: string; attempts: number }) =>
          event.status === 'pending' && event.attempts === 0,
      ),
    );
    assert.ok(await memory.getThreadById({ threadId: worker.threadId }));
    assert.equal(
      await readFile(join(directory, 'keep.txt'), 'utf8'),
      'plugin-owned',
    );
    await plugins.setEnabled('demo', true);
    assert.equal(
      (await rooms.openDefault('alice', undefined, 'demo')).id,
      first.id,
    );
    assert.ok(
      (await rooms.dueEvents()).some((event) => event.roomId === first.id),
    );
    assert.equal(
      (await rooms.get('alice', first.id)).a2aMembers?.[0].id,
      external.member.id,
    );
    // Removing the creator's grant must not prevent the administrator provisioning new agents.
    const next = await plugins.access.get('demo');
    await plugins.access.save('demo', {
      access: { mode: 'selected', userIds: [] },
      revision: next.revision,
    });
    await rooms.addAgent('admin', first.id, {
      name: 'Admin worker',
      settings: { model: null, reasoningEffort: 'auto' },
    });
    await assert.rejects(rooms.get('alice', first.id), code('NOT_FOUND'));
    await assert.rejects(
      rooms.authenticateA2a(first.id, external.apiKey),
      code('UNAUTHORIZED'),
    );

    const app = createApp(
      {
        api: {
          getSession: async () => ({
            user: { id: 'admin' },
            session: { id: 'test' },
          }),
        },
      } as Parameters<typeof createApp>[0],
      undefined,
      {
        threads,
        groupChats: rooms,
        webOrigin: 'http://localhost:5173',
        models: {} as never,
      },
    );
    const response = await app.request('/api/group-chats/default', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pluginId: 'demo' }),
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { id: string }).id, first.id);
  },
);
