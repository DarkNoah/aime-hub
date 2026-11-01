import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';
import type { RunInput } from '@aime/shared/threads';
import { CreateGroupChats1780000024000 } from '../../../../../packages/db/src/migrations/1780000024000-create-group-chats.js';
import { GroupChatAgents1780000026000 } from '../../../../../packages/db/src/migrations/1780000026000-group-chat-agents.js';
import { GroupChatMembers1780000027000 } from '../../../../../packages/db/src/migrations/1780000027000-group-chat-members.js';
import { GroupChatIdleWake1780000029000 } from '../../../../../packages/db/src/migrations/1780000029000-group-chat-idle-wake.js';
import { GroupChatA2aMembers1780000030000 } from '../../../../../packages/db/src/migrations/1780000030000-group-chat-a2a-members.js';
import { GroupChatA2aMemberDeletion1780000031000 } from '../../../../../packages/db/src/migrations/1780000031000-group-chat-a2a-member-deletion.js';
import { GroupChatA2aCard1780000033000 } from '../../../../../packages/db/src/migrations/1780000033000-group-chat-a2a-card.js';
import { IssueEvents1780000038000 } from '../../../../../packages/db/src/migrations/1780000038000-issue-events.js';
import { AutomationBotEvents1780000040000 } from '../../../../../packages/db/src/migrations/1780000040000-automation-bot-events.js';
import { GroupChatService } from '../group-chats/service.js';
import { createGroupChatRuntime } from '../group-chats/runtime.js';
import type { ThreadService } from '../threads/service.js';
import { AutomationBotEvents } from './bot-events.js';
import {
  fixture,
  input,
  personal,
  project,
  system,
  until,
} from './test-fixture.js';

test(
  'native scheduled results persist once, route to the correct Bot, survive dispatcher restart and enforce current access',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `automation_bot_${randomBytes(6).toString('hex')}`;
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const db = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      extra: { options: `-c search_path=${schema}` },
    });
    await db.initialize();
    let roomRuntime: ReturnType<typeof createGroupChatRuntime> | undefined;
    t.after(async () => {
      await roomRuntime?.shutdown();
      await pool.end();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.destroy();
    });
    await db.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE users(id text PRIMARY KEY,name text,role text,banned boolean DEFAULT false);
      INSERT INTO users(id,name,role) VALUES ('alice','Alice','user'),('bob','Bob','user'),('admin','Admin','admin');
      CREATE TABLE projects(id text PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE project_members(project_id text,user_id text,role text,deleted_at timestamptz,created_at timestamptz DEFAULT now());
      INSERT INTO projects(id) VALUES ('${project.projectId}'),('otherproject0001');
      INSERT INTO project_members(project_id,user_id,role) VALUES ('${project.projectId}','admin','owner'),('otherproject0001','admin','owner')`);
    const runner = db.createQueryRunner();
    for (const migration of [
      new CreateGroupChats1780000024000(),
      new GroupChatAgents1780000026000(),
      new GroupChatMembers1780000027000(),
      new GroupChatIdleWake1780000029000(),
      new GroupChatA2aMembers1780000030000(),
      new GroupChatA2aMemberDeletion1780000031000(),
      new GroupChatA2aCard1780000033000(),
      new IssueEvents1780000038000(),
      new AutomationBotEvents1780000040000(),
    ])
      await migration.up(runner);
    await runner.release();
    const rooms = new GroupChatService(db);
    const events = new AutomationBotEvents(pool, rooms);
    const mine = await rooms.openDefault('alice');
    const other = await rooms.openDefault('bob');
    const shared = await rooms.openDefault('admin', project.projectId);
    const admin = await rooms.openDefault('admin');
    const foreign = await rooms.openDefault('admin', 'otherproject0001');
    const f = await fixture(t, {
      botEvents: events,
      notifications: {
        async publish() {
          throw new Error('notification unavailable');
        },
      },
    });
    const rows = () =>
      db.query(
        `SELECT * FROM group_chat_events WHERE kind='automation' ORDER BY created_at,id`,
      );
    const task = await f.service.create('alice', personal, input, mine.id);
    await assert.rejects(() =>
      f.service.create('alice', personal, input, other.id),
    );
    await assert.rejects(() =>
      f.service.create('admin', project, input, foreign.id),
    );
    await assert.rejects(() =>
      f.service.create('admin', personal, input, shared.id),
    );
    assert.equal((await rows()).length, 0, 'saving must not wake any Bot');
    await f.mastra.schedules.run(task.id);
    const first = (await until(rows, (rows) => rows.length === 1))[0];
    const payload = JSON.parse(first.text);
    assert.equal(first.agent_id, mine.botAgentId);
    assert.equal(payload.status, 'succeeded');
    assert.equal(payload.result, 'Native generated result');
    assert.equal(payload.threadId, task.threadId);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        events.publish(
          task,
          { status: 'succeeded', text: 'duplicate', error: null },
          payload.executionId,
        ),
      ),
    );
    assert.equal(
      (await rows()).length,
      1,
      'concurrent callbacks must deduplicate',
    );
    await events.publish(
      task,
      { status: 'skipped', text: '', error: 'AUTOMATION_ALREADY_RUNNING' },
      'skipped',
    );
    assert.equal((await rows()).length, 1);

    const deliveries: { threadId: string; input: RunInput }[] = [];
    const dispatcher = () =>
      createGroupChatRuntime(new GroupChatService(db), {
        async ensureGroupChatThread() {},
        async disposeGroupChatThread() {},
        async validateGroupChatSettings() {},
        setGroupChatObserver() {},
        async getThread() {
          return { thread: { status: 'running', queueCount: 1 } } as Awaited<
            ReturnType<ThreadService['getThread']>
          >;
        },
        async runGroupChat(_userId, threadId, input) {
          deliveries.push({ threadId, input });
          return {} as Awaited<ReturnType<ThreadService['runGroupChat']>>;
        },
        async resolveWorkspaceFile() {
          throw new Error('unused');
        },
        async withWorkspaceFiles() {
          throw new Error('unused');
        },
      });
    roomRuntime = dispatcher();
    await roomRuntime.shutdown();
    roomRuntime = dispatcher();
    await roomRuntime.tick();
    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0].threadId,
      mine.agents.find((a) => a.role === 'bot')!.threadId,
    );
    assert.match(
      JSON.stringify(deliveries[0].input.parts),
      /Native generated result/,
    );
    assert.equal((await rows())[0].status, 'completed');
    await roomRuntime.tick();
    assert.equal(deliveries.length, 1);

    // Page-created and old metadata without a source route by scope, never to another room.
    for (const [userId, scope, room] of [
      ['alice', personal, mine],
      ['admin', project, shared],
      ['admin', system, admin],
    ] as const) {
      const legacy = await f.service.create(userId, scope, input);
      await events.publish(
        legacy,
        { status: 'failed', text: '', error: 'AUTOMATION_RUN_FAILED' },
        `legacy-${scope.scope}`,
      );
      const event = (await rows()).find(
        (r: { text: string }) => JSON.parse(r.text).taskId === legacy.id,
      );
      assert.equal(event.agent_id, room.botAgentId);
      assert.equal(event.actor_id, userId);
      assert.equal(JSON.parse(event.text).status, 'failed');
    }
    // Real native model errors and preparation errors reach the completion hook.
    t.mock.method(f.model, 'doStream', async () => {
      throw new Error('private provider body');
    });
    await f.mastra.schedules.run(task.id).catch(() => {});
    await until(rows, (rows) =>
      rows.some((r: { text: string }) => {
        const p = JSON.parse(r.text);
        return p.taskId === task.id && p.status === 'failed';
      }),
    );
    assert.ok(!JSON.stringify(await rows()).includes('private provider body'));
    const broken = await f.service.create('alice', personal, input, mine.id);
    await f.service.prepare(broken.id);
    await f.memory.deleteThread(broken.threadId);
    await f.mastra.schedules.run(broken.id).catch(() => {});
    await until(rows, (rows) =>
      rows.some(
        (r: { text: string }) => JSON.parse(r.text).taskId === broken.id,
      ),
    );

    const total = (await rows()).length;
    await db.query("UPDATE users SET banned=true WHERE id='alice'");
    await events.publish(
      task,
      { status: 'failed', text: '', error: 'FORBIDDEN' },
      'banned',
    );
    assert.equal((await rows()).length, total);
    await db.query("UPDATE users SET banned=false WHERE id='alice'");
    await db.query('UPDATE group_chats SET deleting=true WHERE id=$1', [
      mine.id,
    ]);
    await assert.rejects(() =>
      events.publish(
        task,
        { status: 'succeeded', text: 'private', error: null },
        'deleted',
      ),
    );
    assert.equal(
      (await rows()).length,
      total,
      'deleted source must not redirect to another room',
    );
    await db.query(
      "UPDATE project_members SET deleted_at=now() WHERE project_id=$1 AND user_id='admin'",
      [project.projectId],
    );
    const revoked = await f.service.create('admin', project, input);
    await assert.rejects(() =>
      events.publish(
        revoked,
        { status: 'succeeded', text: 'private', error: null },
        'revoked',
      ),
    );
    assert.equal((await rows()).length, total);
  },
);
