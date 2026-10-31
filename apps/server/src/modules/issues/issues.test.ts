import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { Project, ProjectMember } from '@aime/db';
import type { Auth } from '@aime/auth';
import {
  issueCreateSchema,
  issueListSchema,
  issuePatchSchema,
  type Issue,
} from '@aime/shared/issues';
import type { RunInput } from '@aime/shared/threads';
import { CreateIssues1780000035000 } from '../../../../../packages/db/src/migrations/1780000035000-create-issues.js';
import { IssueSourceThread1780000036000 } from '../../../../../packages/db/src/migrations/1780000036000-issue-source-thread.js';
import { CreateGroupChats1780000024000 } from '../../../../../packages/db/src/migrations/1780000024000-create-group-chats.js';
import { GroupChatAgents1780000026000 } from '../../../../../packages/db/src/migrations/1780000026000-group-chat-agents.js';
import { GroupChatIdleWake1780000029000 } from '../../../../../packages/db/src/migrations/1780000029000-group-chat-idle-wake.js';
import { IssueEvents1780000038000 } from '../../../../../packages/db/src/migrations/1780000038000-issue-events.js';
import { IssueOptionalThread1780000039000 } from '../../../../../packages/db/src/migrations/1780000039000-issue-optional-thread.js';
import { fakeMemory } from '../../../../../scripts/fixtures/thread-memory.js';
import { sessionStub } from '../../../../../scripts/fixtures/thread-session.js';
import { ThreadService } from '../threads/service.js';
import type { ChatSessionContext } from '../threads/session.js';
import { ProjectService } from '../projects/service.js';
import { IssueService } from './service.js';
import { parseIssueCommand } from './command.js';
import {
  createIssueTool,
  type ResolveIssues,
} from '../../mastra/tools/issue.js';
import {
  buildTools,
  parseToolConfig,
  registeredToolIds,
} from '../tools/registry.js';
import { createApp } from '../../app.js';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from '../threads/runner.js';
import { botAgent } from '../../mastra/agents/bot-agent.js';
import { fallbackAgentId } from '../../mastra/agents/index.js';
import type { GroupChatService } from '../group-chats/service.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const code = (expected: string) => (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === expected;

test('issue patches change only supplied fields and allow explicitly clearing the body', () => {
  assert.deepEqual(issuePatchSchema.parse({ state: 'in_progress' }), {
    state: 'in_progress',
  });
  assert.deepEqual(issuePatchSchema.parse({ title: 'renamed' }), {
    title: 'renamed',
  });
  assert.deepEqual(issuePatchSchema.parse({ body: '' }), { body: '' });
  assert.deepEqual(issuePatchSchema.parse({}), {});
});

test('issue command parser handles quoted Markdown, literal shell text, aliases and rejects ambiguous mutations', () => {
  const parsed = parseIssueCommand(
    'issue create --title "修复 登录" --body \'## 验收\n保留 $HOME 和 $(literal)\' --state 待决策',
  );
  assert.equal(parsed.values.title, '修复 登录');
  assert.equal(parsed.values.body, '## 验收\n保留 $HOME 和 $(literal)');
  assert.equal(parsed.values.state, 'decision');
  assert.equal(parseIssueCommand('edit #123 --body=""').values.body, '');
  assert.equal(
    parseIssueCommand('comment 123 --body "--stop 是文本"').values.body,
    '--stop 是文本',
  );
  assert.equal(parseIssueCommand('list --state closed').values.state, 'done');
  assert.equal(
    parseIssueCommand('create --title record').values['run-in-thread'],
    undefined,
  );
  assert.equal(
    parseIssueCommand('create --title task --run-in-thread').values[
      'run-in-thread'
    ],
    'true',
  );
  assert.equal(
    parseIssueCommand('edit 123 --run-in-thread').values['run-in-thread'],
    'true',
  );
  for (const command of [
    'create --title "oops',
    'view -1',
    'list --project-id elsewhere',
    'edit 1 --stop --message go',
    'edit 1 --state done --message go',
    'create --title x --state done --start',
    'create --title x --start --no-start',
    'create --title x --run-in-thread false --start',
    'create --title x --run-in-thread yes',
    'create --title x --run-in-thread false',
    'create --title x --run-in-thread true',
    'create --title x --run-in-thread=true',
    'create --title x --run-in-thread --no-start',
    'create --title x --run-in-thread --state done',
    'edit 1 --run-in-thread false',
    'edit 1 --run-in-thread=true',
    'edit 1 --run-in-thread --message go',
    'edit 1 --run-in-thread --stop',
    'edit 1 --run-in-thread --state done',
    'edit 1 --run-in-thread --delivery immediate',
    'edit 1 --delivery immediate',
    'edit 1 --state invalid',
    'create --title x --title y',
    'edit 1',
    'list --limit 2x',
  ])
    assert.throws(() => parseIssueCommand(command), command);
});

test('issue tool inherits authenticated scope/settings, registers admin controls, and aborts immediately', async () => {
  const calls: unknown[][] = [];
  const ctx = new RequestContext();
  ctx.set('userId', 'alice');
  ctx.set('projectId', 'project000000001');
  ctx.set('issueSourceThreadId', 'roomthread000001');
  ctx.set('chatSettings', {
    ...settings,
    model: 'fixture/model',
    reasoningEffort: 'high',
  });
  const service = {
    create: async (...args: unknown[]) => {
      calls.push(args);
      return { id: 1 };
    },
    list: async (...args: unknown[]) => {
      calls.push(args);
      return { items: [] };
    },
  } as unknown as ReturnType<ResolveIssues>;
  const tool = createIssueTool(() => service);
  await tool.execute!(
    { command: 'create --title 测试 --body 描述' },
    { requestContext: ctx, observe: noopObserve },
  );
  assert.equal(calls[0]![0], 'alice');
  assert.deepEqual(calls[0]![1], { projectId: 'project000000001' });
  assert.equal(calls[0]![4], 'roomthread000001');
  assert.equal((calls[0]![2] as { runInThread: boolean }).runInThread, false);
  assert.equal(
    (calls[0]![2] as { settings: { reasoningEffort: string } }).settings
      .reasoningEffort,
    'high',
  );
  assert.ok(registeredToolIds.includes('issue'));
  assert.equal(
    parseToolConfig('issue', { enabled: false }).config.enabled,
    false,
  );
  assert.deepEqual(
    Object.keys(await buildTools(['issue'], { issue: { enabled: false } })),
    [],
  );
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    await tool.execute!(
      { command: 'create --title never' },
      { requestContext: ctx, observe: noopObserve, abortSignal: abort.signal },
    ),
    '用户中止了操作',
  );
  assert.equal(calls.length, 1);
  let release!: () => void;
  const slow = createIssueTool(() => ({
    ...service,
    list: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            items: [],
            counts: { decision: 0, todo: 0, in_progress: 0, done: 0 },
            nextCursor: null,
          });
      }),
  }));
  const active = new AbortController();
  const result = slow.execute!(
    { command: 'list' },
    { requestContext: ctx, observe: noopObserve, abortSignal: active.signal },
  );
  active.abort();
  assert.equal(await result, '用户中止了操作');
  release();
});

test('Issue creation only runs in a thread when requested, supports legacy flags, and preserves the Issue on submission failure', async () => {
  const ctx = new RequestContext();
  ctx.set('userId', 'alice');
  ctx.set('issueSourceThreadId', 'bot-source');
  ctx.set('issueActorThreadId', 'bot-source');
  ctx.set('chatSettings', { ...settings, agentId: botAgent.id });
  const submissions: unknown[][] = [];
  const edits: unknown[][] = [];
  let fail = false;
  const issue = {
    id: 42,
    title: 'Implement task',
    body: 'Acceptance details',
    state: 'todo',
    threadId: 'task-thread',
  };
  const tool = createIssueTool(
    () =>
      ({
        create: async (
          _userId: string,
          _scope: unknown,
          data: { runInThread: boolean },
        ) => (data.runInThread ? issue : { ...issue, threadId: null }),
        edit: async (...args: unknown[]) => {
          edits.push(args);
          return {
            ...issue,
            ...Object.fromEntries(
              Object.entries(args[3] as object).filter(
                ([, value]) => value !== undefined,
              ),
            ),
          };
        },
        message: async (...args: unknown[]) => {
          submissions.push(args);
          if (fail) throw new Error('Model unavailable');
          return issue;
        },
      }) as unknown as ReturnType<ResolveIssues>,
  );
  const execute = (command: string) =>
    tool.execute!({ command }, { requestContext: ctx, observe: noopObserve });
  assert.deepEqual(await execute('create --title task --run-in-thread'), {
    issue,
    taskSubmitted: true,
  });
  assert.match(
    String(submissions[0]![3]),
    /Issue #42: Implement task\n\nAcceptance details/,
  );
  assert.equal(submissions[0]![6], 'bot-source');
  for (const command of [
    'create --title backlog --no-start',
    'create --title decision --state decision --no-start',
  ])
    assert.deepEqual(await execute(command), { issue, taskSubmitted: false });
  assert.equal(submissions.length, 1);
  assert.deepEqual(await execute('create --title record'), {
    issue: { ...issue, threadId: null },
    taskSubmitted: false,
  });
  assert.equal(
    submissions.length,
    1,
    'Bot creates only a record without an execution flag',
  );
  ctx.set('chatSettings', settings);
  assert.deepEqual(await execute('create --title ordinary'), {
    issue: { ...issue, threadId: null },
    taskSubmitted: false,
  });
  assert.equal(submissions.length, 1);
  assert.deepEqual(
    await execute('create --title ordinary-task --run-in-thread'),
    { issue, taskSubmitted: true },
  );
  assert.equal(submissions.length, 2);
  const edited = {
    ...issue,
    title: 'Updated task',
    body: 'Updated acceptance',
  };
  await execute(
    'edit 42 --title "Updated task" --body "Updated acceptance" --run-in-thread',
  );
  assert.deepEqual(edits[0]!.slice(0, 5), [
    'alice',
    42,
    {},
    { title: edited.title, body: edited.body, state: undefined },
    'bot-source',
  ]);
  assert.match(
    String(submissions.at(-1)![3]),
    /Issue #42: Updated task\n\nUpdated acceptance/,
  );
  fail = true;
  const failure = (await execute('create --title retry --start')) as {
    issue: unknown;
    taskSubmitted: boolean;
    error: string;
  };
  assert.equal(failure.issue, issue);
  assert.equal(failure.taskSubmitted, false);
  assert.match(failure.error, /已创建/);
  const editFailure = (await execute(
    'edit 42 --run-in-thread',
  )) as typeof failure;
  assert.deepEqual(editFailure.issue, issue);
  assert.equal(editFailure.taskSubmitted, false);
  assert.match(editFailure.error, /任务线程已保留/);
});

test(
  'PostgreSQL issues isolate scopes, bind chats, persist comments, paginate and route messages',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `issue_test_${randomBytes(6).toString('hex')}`;
    const db = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      entities: [Project, ProjectMember],
      extra: { options: `-c search_path=${schema}` },
    });
    await db.initialize();
    const mastra = new Mastra({ storage: new InMemoryStore(), logger: false });
    const resolver = createChatRunner(
      mastra,
      {} as LanguageModelService,
      '/tmp/issue-fixture',
    );
    const { memory, threads: stored } = fakeMemory();
    const cleanup: { threads?: ThreadService } = {};
    t.after(async () => {
      await cleanup.threads?.shutdown();
      await mastra.shutdown();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.destroy();
    });
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`CREATE TABLE users(id text PRIMARY KEY,name text NOT NULL);
    CREATE TABLE projects(id text PRIMARY KEY,name text NOT NULL DEFAULT 'Project',created_by text NOT NULL DEFAULT 'alice',metadata jsonb NOT NULL DEFAULT '{}',archived boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),deleted_at timestamptz);
    CREATE TABLE project_members(project_id text REFERENCES projects(id),user_id text,role text,pinned boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),deleted_at timestamptz,PRIMARY KEY(project_id,user_id));
    INSERT INTO users VALUES ('alice','Alice'),('bob','Bob');
    INSERT INTO projects(id) VALUES ('project000000001'),('project000000002');
    INSERT INTO project_members(project_id,user_id,role) VALUES ('project000000001','alice','owner'),('project000000001','bob','member'),('project000000002','alice','owner');`);
    const migration = db.createQueryRunner();
    await new CreateGroupChats1780000024000().up(migration);
    await new GroupChatAgents1780000026000().up(migration);
    await new GroupChatIdleWake1780000029000().up(migration);
    await new CreateIssues1780000035000().up(migration);
    await new IssueSourceThread1780000036000().up(migration);
    await new IssueEvents1780000038000().up(migration);
    await new IssueOptionalThread1780000039000().up(migration);
    await migration.release();
    const projects = new ProjectService(db);
    const sends: RunInput[] = [];
    let lastSession: ChatSessionContext | undefined;
    let stopped = 0,
      cleared = 0;
    const threads = new ThreadService(
      memory,
      {
        // Use the real Agent resolver: room-only Agents are unavailable to normal chats.
        resolveSettings: resolver.resolveSettings,
        async createWorkspace() {
          return '/tmp/issue-fixture';
        },
        async validate() {},
        async open(context) {
          lastSession = context;
          return sessionStub({
            async send(input) {
              sends.push(input);
            },
            clearQueue() {
              cleared++;
            },
            abort() {
              stopped++;
            },
          });
        },
      },
      projects,
    );
    cleanup.threads = threads;
    const issues = new IssueService(db, projects, threads);
    threads.setIssueObserver((id, state, execution) =>
      issues.observeThread(id, state, execution),
    );
    const personal = await issues.create(
      'alice',
      {},
      issueCreateSchema.parse({
        runInThread: true,
        title: '私有任务',
        body: '验收目标',
      }),
    );
    const project = await issues.create(
      'alice',
      { projectId: 'project000000001' },
      issueCreateSchema.parse({ runInThread: true, title: '共同任务' }),
    );
    const scope = { projectId: 'project000000001' };
    assert.ok(personal.threadId);
    assert.ok(project.threadId);
    assert.equal(stored.get(personal.threadId)?.metadata?.issueId, personal.id);
    assert.equal(
      stored.get(project.threadId)?.resourceId,
      'project:project000000001',
    );
    assert.equal(
      (await issues.list('bob', issueListSchema.parse({}))).items.length,
      0,
    );
    for (const attempt of [
      () => issues.get('bob', personal.id, {}),
      () => issues.comment('bob', personal.id, {}, 'stolen'),
      () => issues.edit('bob', personal.id, {}, { title: 'stolen' }),
      () => issues.message('bob', personal.id, {}, 'stolen'),
      () => issues.get('alice', project.id, {}),
      () => issues.get('alice', project.id, { projectId: 'project000000002' }),
    ])
      await assert.rejects(attempt, code('NOT_FOUND'));
    assert.equal(await issues.forThread('bob', personal.threadId, {}), null);
    await assert.rejects(
      threads.deleteThread('alice', personal.threadId),
      code('ISSUE_THREAD_REQUIRED'),
    );
    await issues.comment('bob', project.id, scope, '不会执行');
    assert.equal(sends.length, 0);
    assert.equal(
      (await issues.view('alice', project.id, scope)).comments[0]?.authorName,
      'Bob',
    );
    await issues.message('bob', project.id, scope, '排队', 'wait');
    await issues.message('alice', project.id, scope, '立即', 'immediate');
    assert.deepEqual(
      sends.map((item) => [item.createdBy, item.isImmediate]),
      [
        ['bob', false],
        ['alice', true],
      ],
    );
    assert.equal(
      (await issues.get('alice', project.id, scope)).state,
      'in_progress',
    );
    await lastSession!.onEvent({
      type: 'status',
      status: 'success',
      runId: 'finished',
    });
    assert.equal(
      (await issues.get('alice', project.id, scope)).state,
      'decision',
    );
    const closed = await issues.edit('bob', project.id, scope, {
      state: 'done',
    });
    assert.ok(closed.closedAt);
    await issues.observeThread(project.id, 'running');
    assert.equal((await issues.get('alice', project.id, scope)).state, 'done');
    await assert.rejects(
      issues.message('bob', project.id, scope, 'no'),
      code('ISSUE_CLOSED'),
    );
    await issues.comment('bob', project.id, scope, '完成后仍可评论');
    await issues.edit('bob', project.id, scope, { state: 'todo' });
    await issues.stop('bob', project.id, scope);
    assert.equal(stopped, 1);
    assert.equal(cleared, 1);
    assert.equal((await issues.get('bob', project.id, scope)).closedAt, null);
    await Promise.all([
      issues.edit('alice', project.id, scope, { title: '新标题' }),
      issues.edit('bob', project.id, scope, { body: '新描述' }),
    ]);
    assert.equal(
      (await issues.get('alice', project.id, scope)).title,
      '新标题',
    );
    assert.equal((await issues.get('alice', project.id, scope)).body, '新描述');
    const another = await issues.create(
      'alice',
      {},
      issueCreateSchema.parse({ runInThread: true, title: '第二项' }),
    );
    const page = await issues.list(
      'alice',
      issueListSchema.parse({ limit: 1 }),
    );
    assert.equal(page.items[0]?.id, another.id);
    assert.equal(page.counts.todo, 2);
    assert.equal(
      (
        await issues.list(
          'alice',
          issueListSchema.parse({ limit: 1, cursor: page.nextCursor }),
        )
      ).items[0]?.id,
      personal.id,
    );
    for (let i = 0; i < 52; i++)
      await issues.comment('alice', personal.id, {}, `评论 ${i}`);
    const latest = await issues.view('alice', personal.id, {});
    assert.equal(latest.comments.length, 50);
    assert.ok(latest.nextCursor);
    assert.equal(
      (await issues.view('alice', personal.id, {}, latest.nextCursor!)).comments
        .length,
      2,
    );
    await db.query(
      'DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',
      [scope.projectId, 'bob'],
    );
    await assert.rejects(
      issues.get('bob', project.id, scope),
      code('PROJECT_NOT_FOUND'),
    );
    const beforeFailure = stored.size;
    // A DB rejection after provisioning must compensate the linked thread.
    await db.query(`CREATE FUNCTION reject_issue_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='reject' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_issue BEFORE INSERT ON issues FOR EACH ROW EXECUTE FUNCTION reject_issue_fixture()`);
    await assert.rejects(
      issues.create(
        'alice',
        {},
        issueCreateSchema.parse({ runInThread: true, title: 'reject' }),
      ),
    );
    assert.equal(stored.size, beforeFailure);
    assert.equal(
      (await issues.list('alice', issueListSchema.parse({}))).items.length,
      2,
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      issues.create(
        'alice',
        {},
        issueCreateSchema.parse({ runInThread: true, title: '取消' }),
        aborted.signal,
      ),
    );
    assert.equal(stored.size, beforeFailure);

    await t.test(
      'record-only Issues retain normal tracking without creating or running a thread',
      async () => {
        const before = { threads: stored.size, sends: sends.length, stopped };
        for (const recordScope of [{}, scope]) {
          const record = await issues.create(
            'alice',
            recordScope,
            issueCreateSchema.parse({
              title: 'Record only',
              runInThread: false,
            }),
          );
          assert.equal(record.threadId, null);
          await issues.comment(
            'alice',
            record.id,
            recordScope,
            'Progress without execution',
          );
          assert.equal(
            (await issues.view('alice', record.id, recordScope)).comments
              .length,
            1,
          );
          await assert.rejects(
            issues.message('alice', record.id, recordScope, 'Do not execute'),
            code('ISSUE_NO_THREAD'),
          );
          await assert.rejects(
            issues.stop('alice', record.id, recordScope),
            code('ISSUE_NO_THREAD'),
          );
          assert.equal(
            (
              await issues.edit('alice', record.id, recordScope, {
                state: 'done',
              })
            ).state,
            'done',
          );
          assert.equal(
            (
              await issues.edit('alice', record.id, recordScope, {
                state: 'todo',
              })
            ).threadId,
            null,
          );
          await assert.rejects(
            issues.get('bob', record.id, recordScope),
            code(
              'projectId' in recordScope ? 'PROJECT_NOT_FOUND' : 'NOT_FOUND',
            ),
          );
        }
        assert.deepEqual(
          { threads: stored.size, sends: sends.length, stopped },
          before,
        );
      },
    );

    await t.test(
      'edit --run-in-thread binds once, sends updated details, reuses settings, and protects closed or inaccessible Issues',
      async () => {
        const ctx = new RequestContext();
        ctx.set('userId', 'alice');
        const tool = createIssueTool(() => issues);
        const execute = async (command: string) =>
          tool.execute!(
            { command },
            { requestContext: ctx, observe: noopObserve },
          ) as Promise<{
            issue?: Issue;
            taskSubmitted?: boolean;
            error?: string;
          }>;
        for (const recordScope of [{}, scope]) {
          ctx.set(
            'projectId',
            'projectId' in recordScope ? recordScope.projectId : undefined,
          );
          ctx.set('chatSettings', {
            ...settings,
            agentId: botAgent.id,
            reasoningEffort: 'high',
          });
          const record = await issues.create(
            'alice',
            recordScope,
            issueCreateSchema.parse({
              title: 'Saved task',
              body: 'Old acceptance',
            }),
          );
          const before = stored.size;
          const first = await execute(
            `edit ${record.id} --title "Updated task" --body "Latest acceptance" --run-in-thread`,
          );
          assert.equal(first.error, undefined);
          assert.equal(first.taskSubmitted, true);
          assert.equal(first.issue?.id, record.id);
          assert.ok(first.issue?.threadId);
          assert.equal(stored.size, before + 1);
          assert.equal(
            stored.get(first.issue.threadId)?.metadata?.issueId,
            record.id,
          );
          assert.equal(
            stored.get(first.issue.threadId)?.metadata?.agentId,
            fallbackAgentId,
          );
          assert.match(
            JSON.stringify(sends.at(-1)?.parts),
            new RegExp(`Issue #${record.id}: Updated task`),
          );
          assert.match(
            JSON.stringify(sends.at(-1)?.parts),
            /Latest acceptance/,
          );
          ctx.set('chatSettings', {
            ...settings,
            agentId: 'default',
            reasoningEffort: 'low',
          });
          const again = await execute(`edit ${record.id} --run-in-thread`);
          assert.equal(again.taskSubmitted, true);
          assert.equal(again.issue?.threadId, first.issue.threadId);
          assert.equal(stored.size, before + 1);
          assert.equal(sends.at(-1)?.reasoningEffort, 'high');
          assert.equal(
            (
              await issues.view('alice', record.id, recordScope)
            ).comments.filter((c) => c.kind === 'message').length,
            2,
          );
          await issues.edit('alice', record.id, recordScope, { state: 'done' });
          const sentBefore = sends.length;
          assert.deepEqual(
            await execute(
              `edit ${record.id} --title "Must not change" --run-in-thread`,
            ),
            { error: 'ISSUE_CLOSED' },
          );
          assert.equal(
            (await issues.get('alice', record.id, recordScope)).title,
            'Updated task',
          );
          assert.equal(sends.length, sentBefore);
          const reopened = await execute(
            `edit ${record.id} --state todo --run-in-thread`,
          );
          assert.equal(reopened.taskSubmitted, true);
          assert.equal(reopened.issue?.threadId, first.issue.threadId);
          await assert.rejects(
            issues.edit('bob', record.id, recordScope, {}, undefined, {
              settings,
            }),
            code(
              'projectId' in recordScope ? 'PROJECT_NOT_FOUND' : 'NOT_FOUND',
            ),
          );
        }
      },
    );

    await t.test(
      'concurrent binding uses one thread and failed binding rolls back fields and the newly provisioned thread',
      async () => {
        const record = await issues.create(
          'alice',
          {},
          issueCreateSchema.parse({ title: 'Concurrent task' }),
        );
        const other = new IssueService(db, projects, threads);
        const before = stored.size;
        const [first, second] = await Promise.all([
          issues.edit('alice', record.id, {}, {}, undefined, { settings }),
          other.edit('alice', record.id, {}, {}, undefined, { settings }),
        ]);
        assert.ok(first.threadId);
        assert.equal(second.threadId, first.threadId);
        assert.equal(stored.size, before + 1);

        const rejected = await issues.create(
          'alice',
          {},
          issueCreateSchema.parse({
            title: 'Before binding',
            body: 'Keep acceptance',
          }),
        );
        const beforeRejected = stored.size;
        await db.query(`CREATE FUNCTION reject_issue_binding_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='Reject binding' AND NEW.thread_id IS NOT NULL THEN RAISE EXCEPTION 'fixture binding rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_binding BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION reject_issue_binding_fixture()`);
        await assert.rejects(
          issues.edit(
            'alice',
            rejected.id,
            {},
            { title: 'Reject binding', body: 'Rollback' },
            undefined,
            { settings },
          ),
        );
        assert.equal(stored.size, beforeRejected);
        assert.deepEqual(await issues.get('alice', rejected.id, {}), rejected);
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(
          issues.edit('alice', rejected.id, {}, {}, undefined, {
            settings,
            signal: abort.signal,
          }),
        );
        assert.equal(stored.size, beforeRejected);
        assert.equal(
          (await issues.get('alice', rejected.id, {})).threadId,
          null,
        );
      },
    );

    const auth = {
      api: {
        async getSession({ headers }: { headers: Headers }) {
          const userId = headers.get('cookie');
          return userId
            ? { user: { id: userId, role: 'user' }, session: {} }
            : null;
        },
      },
    } as unknown as Auth;
    const app = createApp(auth, undefined, {
      threads,
      issues,
      models: {} as LanguageModelService,
      projects,
      webOrigin: ['http://issues.test'],
    });
    const request = (
      user: string | null,
      body: unknown,
      origin = 'http://issues.test',
    ) =>
      app.request('/api/rpc/issues/view', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          ...(user ? { cookie: user } : {}),
        },
        body: JSON.stringify({ json: body }),
      });
    assert.equal((await request('alice', { id: personal.id })).status, 200);
    assert.equal((await request('bob', { id: personal.id })).status, 404);
    assert.equal((await request(null, { id: personal.id })).status, 401);
    assert.equal(
      (await request('alice', { id: personal.id }, 'http://untrusted.test'))
        .status,
      403,
    );

    await t.test(
      'room Bot creates personal/project issues with a normal Agent and edits preserve other fields',
      async () => {
        const ctx = new RequestContext();
        ctx.set('userId', 'alice');
        ctx.set('chatSettings', {
          ...settings,
          agentId: botAgent.id,
          reasoningEffort: 'high',
        });
        const tool = createIssueTool(() => issues);
        const execute = async (command: string) => {
          const result = (await tool.execute!(
            { command },
            { requestContext: ctx, observe: noopObserve },
          )) as { issue?: Issue; error?: string };
          assert.equal(
            result.error,
            undefined,
            JSON.stringify({ command, result }),
          );
          assert.ok(result.issue, command);
          return result.issue;
        };
        for (const projectId of [undefined, scope.projectId]) {
          ctx.set('projectId', projectId);
          const source = {
            roomId: projectId ? 'projectroom00001' : 'personalroom0001',
            agentId: projectId ? 'projectbot000001' : 'personalbot00001',
            threadId: projectId ? 'projectbotchat01' : 'personalbotchat1',
          };
          await db.query(
            "INSERT INTO group_chats(id,project_id,title,created_by) VALUES ($1,$2,'Room','alice')",
            [source.roomId, projectId ?? null],
          );
          await db.query(
            "INSERT INTO group_chat_agents(id,room_id,thread_id,name,role) VALUES ($1,$2,$3,'Bot','bot')",
            [source.agentId, source.roomId, source.threadId],
          );
          await memory.createThread({
            threadId: source.threadId,
            resourceId: projectId ? `project:${projectId}` : 'user:alice',
            title: 'Room Bot',
            metadata: {
              ...settings,
              createdBy: 'alice',
              groupChat: {
                roomId: source.roomId,
                memberId: source.agentId,
                role: 'bot',
              },
            },
          });
          ctx.set('issueSourceThreadId', source.threadId);
          const created = await execute(
            'create --title "Bot task" --body "Keep this acceptance criterion" --run-in-thread',
          );
          assert.equal(created.projectId, projectId ?? null);
          assert.ok(created.threadId);
          assert.deepEqual(created.source, source);
          assert.notEqual(created.threadId, source.threadId);
          assert.equal(lastSession?.thread.id, created.threadId);
          assert.match(
            JSON.stringify(sends.at(-1)?.parts),
            new RegExp(`Issue #${created.id}`),
          );
          assert.match(
            JSON.stringify(sends.at(-1)?.parts),
            /Keep this acceptance criterion/,
          );
          const events = async () =>
            (await db.query(
              "SELECT agent_id,actor_id,text FROM group_chat_events WHERE kind='issue' AND (text::jsonb->>'issueId')::int=$1 ORDER BY created_at,id",
              [created.id],
            )) as { agent_id: string; actor_id: string; text: string }[];
          assert.equal(
            (await events()).length,
            0,
            'Bot creation/submission must not echo',
          );
          await issues.edit(
            'alice',
            created.id,
            { projectId },
            { title: 'Human renamed' },
          );
          assert.equal(
            (await events()).length,
            1,
            'Same human identity must still notify',
          );
          await execute(`edit ${created.id} --title "Bot task"`);
          assert.equal((await events()).length, 1, 'Bot edits must not echo');
          await issues.comment(
            'alice',
            created.id,
            { projectId },
            'Verified task result',
            created.threadId,
          );
          await issues.edit(
            'alice',
            created.id,
            { projectId },
            { state: 'done' },
            created.threadId,
          );
          const completion = {
            threadId: created.threadId,
            runId: 'task-run',
            status: 'success' as const,
            result: 'Verified task result',
            error: null,
          };
          await issues.observeThread(created.id, 'success', completion);
          await issues.observeThread(created.id, 'success', completion);
          const received = await events();
          assert.equal(
            received.length,
            4,
            'Task updates and one deduplicated completion',
          );
          assert.ok(
            received.every((event) => event.agent_id === source.agentId),
          );
          assert.equal(JSON.parse(received.at(-1)!.text).state, 'done');
          assert.equal(
            JSON.parse(received.at(-1)!.text).event.execution.result,
            'Verified task result',
          );
          await issues.observeThread(created.id, 'failed', {
            ...completion,
            runId: 'failed-run',
            status: 'failed',
            error: 'TEST_FAILURE',
            result: '',
          });
          assert.equal((await events()).length, 5);
          assert.equal(
            JSON.parse((await events()).at(-1)!.text).event.execution.error,
            'TEST_FAILURE',
          );
          await issues.observeThread(created.id, 'canceled', {
            ...completion,
            runId: 'bot-stopped-run',
            status: 'canceled',
            actorThreadId: source.threadId,
          });
          assert.equal(
            (await events()).length,
            5,
            'Bot-initiated stops must not echo through completion events',
          );
          assert.deepEqual(
            (await issues.get('alice', created.id, { projectId })).source,
            source,
          );
          await assert.rejects(
            threads.getIssueSourceThread(
              'alice',
              source.threadId,
              projectId ? undefined : scope.projectId,
            ),
            code('FORBIDDEN'),
          );
          if (!projectId)
            await assert.rejects(
              threads.getIssueSourceThread('bob', source.threadId),
              code('THREAD_NOT_FOUND'),
            );
          const target = stored.get(created.threadId)!;
          assert.equal(target.metadata?.agentId, fallbackAgentId);
          assert.equal(target.metadata?.reasoningEffort, 'high');
          assert.equal(target.metadata?.groupChat, undefined);
          assert.equal(target.metadata?.issueId, created.id);
          assert.equal(target.metadata?.issueSourceThreadId, source.threadId);
          const workerThreadId = `worker-thread-${created.id}`;
          await db.query(
            "INSERT INTO group_chat_agents(id,room_id,thread_id,name,role) VALUES($1,$2,$3,'Worker','worker')",
            [`worker-${created.id}`, source.roomId, workerThreadId],
          );
          await memory.createThread({
            threadId: workerThreadId,
            resourceId: target.resourceId,
            title: 'Worker',
            metadata: {
              ...settings,
              createdBy: 'alice',
              groupChat: {
                roomId: source.roomId,
                memberId: `worker-${created.id}`,
                role: 'worker',
              },
            },
          });
          const external = await issues.create(
            'alice',
            { projectId },
            issueCreateSchema.parse({
              runInThread: true,
              title: 'Worker-created task',
            }),
            undefined,
            workerThreadId,
            workerThreadId,
          );
          const [externalEvent] = await db.query(
            "SELECT agent_id,text FROM group_chat_events WHERE kind='issue' AND (text::jsonb->>'issueId')::int=$1",
            [external.id],
          );
          assert.equal(
            externalEvent.agent_id,
            source.agentId,
            'Worker creation notifies the associated Bot',
          );
          assert.equal(JSON.parse(externalEvent.text).event.type, 'created');
          const defaultCalls: unknown[][] = [];
          const manualIssues = new IssueService(db, projects, threads, {
            openDefault: async (...args: unknown[]) => {
              defaultCalls.push(args);
              return {
                projectId: projectId ?? null,
                agents: [
                  { role: 'bot', enabled: true, threadId: source.threadId },
                ],
              };
            },
          } as unknown as Pick<GroupChatService, 'openDefault'>);
          const manualApp = createApp(auth, undefined, {
            threads,
            issues: manualIssues,
            models: {} as LanguageModelService,
            projects,
            webOrigin: ['http://issues.test'],
          });
          const response = await manualApp.request('/api/rpc/issues/create', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://issues.test',
              cookie: 'alice',
            },
            body: JSON.stringify({
              json: {
                projectId,
                data: {
                  title: 'Manually created',
                  body: 'Manual requirements',
                  state: 'todo',
                  runInThread: true,
                },
                actorThreadId: source.threadId,
                sourceThreadId: 'untrusted',
              },
            }),
          });
          assert.equal(response.status, 200);
          const manual = (await response.json()).json as Issue;
          assert.ok(manual.threadId);
          assert.deepEqual(defaultCalls, [['alice', projectId]]);
          assert.deepEqual(manual.source, source);
          assert.equal(
            stored.get(manual.threadId)?.metadata?.issueId,
            manual.id,
          );
          const [manualEvent] = await db.query(
            "SELECT agent_id,text FROM group_chat_events WHERE kind='issue' AND (text::jsonb->>'issueId')::int=$1",
            [manual.id],
          );
          assert.equal(manualEvent.agent_id, source.agentId);
          assert.equal(JSON.parse(manualEvent.text).event.type, 'created');
          assert.equal(JSON.parse(manualEvent.text).event.actorId, 'alice');
          assert.equal(
            JSON.parse(manualEvent.text).event.actorThreadId,
            undefined,
            'Human creation must not be suppressed as a Bot echo',
          );
          if (projectId) {
            await assert.rejects(
              manualIssues.createManual(
                'bob',
                { projectId },
                issueCreateSchema.parse({
                  runInThread: true,
                  title: 'No membership',
                }),
              ),
              code('PROJECT_NOT_FOUND'),
            );
            assert.equal(
              defaultCalls.length,
              1,
              'Check project membership before opening a room',
            );
          }
          const beforeRecord = { threads: stored.size, sends: sends.length };
          const recordResponse = await manualApp.request(
            '/api/rpc/issues/create',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                origin: 'http://issues.test',
                cookie: 'alice',
              },
              body: JSON.stringify({
                json: {
                  projectId,
                  data: { title: 'Manual record only' },
                },
              }),
            },
          );
          assert.equal(recordResponse.status, 200);
          const manualRecord = (await recordResponse.json()).json as Issue;
          assert.equal(manualRecord.threadId, null);
          assert.deepEqual(manualRecord.source, source);
          const [recordEvent] = await db.query(
            "SELECT agent_id,text FROM group_chat_events WHERE kind='issue' AND (text::jsonb->>'issueId')::int=$1",
            [manualRecord.id],
          );
          assert.equal(recordEvent.agent_id, source.agentId);
          assert.equal(JSON.parse(recordEvent.text).threadId, null);
          assert.equal(JSON.parse(recordEvent.text).event.type, 'created');
          const botRecord = await execute('create --title "Bot record only"');
          assert.equal(botRecord.threadId, null);
          assert.deepEqual(botRecord.source, source);
          const [recordCount] = await db.query(
            "SELECT count(*)::int AS count FROM group_chat_events WHERE kind='issue' AND (text::jsonb->>'issueId')::int=$1",
            [botRecord.id],
          );
          assert.equal(
            recordCount.count,
            0,
            'Record-only Bot operations still do not echo',
          );
          assert.deepEqual(
            { threads: stored.size, sends: sends.length },
            beforeRecord,
          );
          const activated = await execute(
            `edit ${botRecord.id} --run-in-thread`,
          );
          assert.ok(activated.threadId);
          assert.deepEqual(activated.source, source);
          assert.equal(
            stored.get(activated.threadId)?.metadata?.issueId,
            botRecord.id,
          );
          assert.equal(
            stored.get(activated.threadId)?.metadata?.issueSourceThreadId,
            source.threadId,
          );
          const [activationEvents] = await db.query(
            "SELECT count(*)::int AS count FROM group_chat_events WHERE kind='issue' AND (text::jsonb->>'issueId')::int=$1",
            [botRecord.id],
          );
          assert.equal(
            activationEvents.count,
            0,
            'Binding and submission retain Bot echo suppression',
          );
          const changed = await execute(
            `edit ${created.id} --state in_progress`,
          );
          assert.equal(changed.body, created.body);
          const renamed = await execute(
            `edit ${created.id} --title "Renamed Bot task"`,
          );
          assert.equal(renamed.state, 'in_progress');
          assert.equal(renamed.body, created.body);
          const closed = await execute(`close ${created.id}`);
          assert.equal(closed.state, 'done');
          assert.equal(closed.body, created.body);
          const reopened = await execute(`reopen ${created.id}`);
          assert.equal(reopened.state, 'todo');
          assert.equal(reopened.body, created.body);
          const cleared = await execute(`edit ${created.id} --body ""`);
          assert.equal(cleared.body, '');
          assert.equal(cleared.state, 'todo');
          await db.query('DELETE FROM group_chat_agents WHERE id=$1', [
            source.agentId,
          ]);
          await issues.comment(
            'alice',
            created.id,
            { projectId },
            'No recipient after source deletion',
          );
          assert.equal(
            (await events()).length,
            0,
            'Deleting the recipient cascades queued events',
          );
          assert.equal(
            (await issues.get('alice', created.id, { projectId })).source,
            null,
          );
          assert.equal(
            (await issues.get('alice', created.id, { projectId })).threadId,
            created.threadId,
          );
        }
        ctx.set('projectId', undefined);
        ctx.set('issueSourceThreadId', undefined);
        ctx.set('chatSettings', { ...settings, agentId: 'default' });
        const workerIssue = await execute(
          'create --title "Keep ordinary Agent" --no-start',
        );
        assert.ok(workerIssue.threadId);
        assert.equal(
          stored.get(workerIssue.threadId)?.metadata?.agentId,
          'default',
        );
      },
    );
  },
);
