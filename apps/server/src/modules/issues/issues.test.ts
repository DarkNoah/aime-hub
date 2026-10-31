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
  for (const command of [
    'create --title "oops',
    'view -1',
    'list --project-id elsewhere',
    'edit 1 --stop --message go',
    'edit 1 --state done --message go',
    'create --title x --state done --start',
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
    await new CreateIssues1780000035000().up(migration);
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
    threads.setIssueObserver((id, state) => issues.observeThread(id, state));
    const personal = await issues.create(
      'alice',
      {},
      issueCreateSchema.parse({ title: '私有任务', body: '验收目标' }),
    );
    const project = await issues.create(
      'alice',
      { projectId: 'project000000001' },
      issueCreateSchema.parse({ title: '共同任务' }),
    );
    const scope = { projectId: 'project000000001' };
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
      issueCreateSchema.parse({ title: '第二项' }),
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
      issues.create('alice', {}, issueCreateSchema.parse({ title: 'reject' })),
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
        issueCreateSchema.parse({ title: '取消' }),
        aborted.signal,
      ),
    );
    assert.equal(stored.size, beforeFailure);

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
          const created = await execute(
            'create --title "Bot task" --body "Keep this acceptance criterion"',
          );
          assert.equal(created.projectId, projectId ?? null);
          const target = stored.get(created.threadId)!;
          assert.equal(target.metadata?.agentId, fallbackAgentId);
          assert.equal(target.metadata?.reasoningEffort, 'high');
          assert.equal(target.metadata?.groupChat, undefined);
          assert.equal(target.metadata?.issueId, created.id);
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
        }
        ctx.set('projectId', undefined);
        ctx.set('chatSettings', { ...settings, agentId: 'default' });
        const workerIssue = await execute(
          'create --title "Keep ordinary Agent"',
        );
        assert.equal(
          stored.get(workerIssue.threadId)?.metadata?.agentId,
          'default',
        );
      },
    );
  },
);
