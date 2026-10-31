import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import { CreateGroupChats1780000024000 } from '../../../../../packages/db/src/migrations/1780000024000-create-group-chats.js';
import { GroupChatAgents1780000026000 } from '../../../../../packages/db/src/migrations/1780000026000-group-chat-agents.js';
import { GroupChatIdleWake1780000029000 } from '../../../../../packages/db/src/migrations/1780000029000-group-chat-idle-wake.js';
import { CreateIssues1780000035000 } from '../../../../../packages/db/src/migrations/1780000035000-create-issues.js';
import { IssueSourceThread1780000036000 } from '../../../../../packages/db/src/migrations/1780000036000-issue-source-thread.js';
import { IssueEvents1780000038000 } from '../../../../../packages/db/src/migrations/1780000038000-issue-events.js';
import { botAgent } from '../../mastra/agents/bot-agent.js';
import { createIssueTool } from '../../mastra/tools/issue.js';
import { ThreadService } from '../threads/service.js';
import { createChatRunner } from '../threads/runner.js';
import type { LanguageModelService } from '../models/language-model.js';
import type { ToolService } from '../tools/service.js';
import type { ProjectService } from '../projects/service.js';
import { GroupChatService } from '../group-chats/service.js';
import { createGroupChatRuntime } from '../group-chats/runtime.js';
import { IssueService } from './service.js';

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Issue handoff did not settle');
}

function response(text: string, tool?: { name: string; input: unknown }) {
  return {
    stream: new ReadableStream({
      start(controller) {
        if (tool)
          controller.enqueue({
            type: 'tool-call',
            toolCallId: `call-${randomBytes(6).toString('hex')}`,
            toolName: tool.name,
            input: JSON.stringify(tool.input),
          });
        else {
          controller.enqueue({ type: 'text-start', id: 'result' });
          controller.enqueue({ type: 'text-delta', id: 'result', delta: text });
          controller.enqueue({ type: 'text-end', id: 'result' });
        }
        controller.enqueue({
          type: 'finish',
          finishReason: tool ? 'tool-calls' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        controller.close();
      },
    }),
  };
}

for (const manual of [false, true])
  test(
    `native ${manual ? 'manual creation wakes the Bot' : 'Bot creates an Issue'}; task updates/finishes it; durable events return results and errors`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const schema = `issue_handoff_${randomBytes(6).toString('hex')}`;
      const directory = await mkdtemp('/tmp/issue-handoff-');
      const db = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
        extra: { options: `-c search_path=${schema}` },
      });
      await db.initialize();
      const storage = new InMemoryStore();
      const memory = new Memory({ storage, options: { generateTitle: false } });
      const mastra = new Mastra({
        storage,
        logger: false,
        backgroundTasks: { enabled: true },
      });
      let threads: ThreadService | undefined;
      let runtime: ReturnType<typeof createGroupChatRuntime> | undefined;
      t.after(async () => {
        await runtime?.shutdown();
        await threads?.shutdown();
        await mastra.shutdown();
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.destroy();
        await rm(directory, { recursive: true, force: true });
      });
      await db.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE projects(id text PRIMARY KEY); CREATE TABLE users(id text PRIMARY KEY,name text); INSERT INTO users VALUES ('alice','Alice')`,
      );
      const migrations = db.createQueryRunner();
      for (const migration of [
        new CreateGroupChats1780000024000(),
        new GroupChatAgents1780000026000(),
        new GroupChatIdleWake1780000029000(),
        new CreateIssues1780000035000(),
        new IssueSourceThread1780000036000(),
        new IssueEvents1780000038000(),
      ])
        await migration.up(migrations);
      await migrations.release();
      const member: GroupChatAgent = {
        id: 'bot000000000001',
        roomId: 'room000000000001',
        threadId: 'source0000000001',
        name: 'Bot',
        role: 'bot',
        settings: {
          agentId: botAgent.id,
          model: null,
          reasoningEffort: 'auto',
        },
        enabled: true,
        status: 'idle',
        error: null,
        lastReadSequence: '0',
        idleWakeHours: null,
      };
      await db.query(
        "INSERT INTO group_chats(id,title,created_by) VALUES($1,'Room','alice')",
        [member.roomId],
      );
      await db.query(
        "INSERT INTO group_chat_agents(id,room_id,thread_id,name,role) VALUES($1,$2,$3,'Bot','bot')",
        [member.id, member.roomId, member.threadId],
      );
      const published: string[] = [];
      const rooms = {
        openDefault: async (userId: string, projectId?: string) => {
          assert.equal(userId, 'alice');
          assert.equal(projectId, undefined);
          return { id: member.roomId, projectId: null, agents: [member] };
        },
        get: async () => ({
          id: member.roomId,
          agents: [member],
          createdBy: 'alice',
          projectId: null,
        }),
        getAgent: async () => member,
        recentMessages: async () => ({
          messages: [],
          hasMore: false,
          revision: '0',
        }),
        sendAgent: async (
          _user: string,
          _room: string,
          _member: string,
          input: { id: string; text: string },
        ) => {
          published.push(input.text);
          return { id: input.id };
        },
      } as unknown as GroupChatService;
      let issues!: IssueService;
      let botSteps = 0;
      let taskSteps = 0;
      const taskPrompts: string[] = [];
      const botPrompts: string[] = [];
      const model = new MastraLanguageModelV2Mock({
        doStream: async ({ prompt, tools }) => {
          const text = JSON.stringify(prompt);
          if (text.includes('This chat belongs to Issue #')) {
            taskPrompts.push(text);
            if (text.includes('TASK_PROVIDER_FAILURE'))
              throw new Error('TASK_PROVIDER_FAILURE');
            assert.ok(
              !tools?.some((tool) =>
                ['ask_user', 'submit_plan', 'intelligent_ui'].includes(
                  tool.name,
                ),
              ),
            );
            const id = /This chat belongs to Issue #(\d+)/.exec(text)![1];
            const step = taskSteps++;
            if (step === 0)
              return response('', {
                name: 'issue',
                input: {
                  command: `comment ${id} --body "Acceptance checks passed; artifact is report.txt"`,
                },
              });
            if (step === 1)
              return response('', {
                name: 'issue',
                input: { command: `close ${id}` },
              });
            return response('Verified task result: report.txt');
          }
          botPrompts.push(text);
          const step = botSteps++;
          if (manual && step === 0)
            return response('', {
              name: 'issue',
              input: { command: 'view 1' },
            });
          if (manual && step === 1)
            return response('', {
              name: 'issue',
              input: {
                command:
                  'edit 1 --message "Issue #1: Tracked task\n\nComplete the acceptance checks and report the artifact"',
              },
            });
          if (!manual && step === 0)
            return response('', {
              name: 'issue',
              input: {
                command:
                  'create --title "Tracked task" --body "Complete the acceptance checks and report the artifact"',
              },
            });
          const startSteps = manual ? 3 : 2;
          if (step === startSteps - 1) return response('Task delegated.');
          if ((step - startSteps) % 3 === 0)
            return response('', {
              name: 'issue',
              input: { command: 'view 1' },
            });
          if ((step - startSteps) % 3 === 1)
            return response('', {
              name: 'send_message',
              input: {
                text: text.includes('TASK_PROVIDER_FAILURE')
                  ? 'Issue #1 failed: TASK_PROVIDER_FAILURE. A new direction is needed.'
                  : 'Issue #1 completed; acceptance checks passed. Result: report.txt',
              },
            });
          return response('Result published.');
        },
      });
      const runner = createChatRunner(
        mastra,
        {
          getLanguageModel: async () => ({
            model,
            reference: 'fixture/model',
            providerOptions: {},
            supportsImages: true,
            toolCall: true,
          }),
        } as unknown as LanguageModelService,
        directory,
        undefined,
        {
          buildTools: async () => ({ issue: createIssueTool(() => issues) }),
        } as unknown as ToolService,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        rooms,
      );
      threads = new ThreadService(
        memory,
        runner,
        undefined,
        mastra.backgroundTaskManager,
      );
      const projects = {} as ProjectService;
      issues = new IssueService(db, projects, threads, rooms);
      threads.setIssueObserver((id, status, event) =>
        issues.observeThread(id, status, event),
      );
      await threads.ensureGroupChatThread({
        roomId: member.roomId,
        memberId: member.id,
        role: 'bot',
        threadId: member.threadId,
        userId: 'alice',
        title: 'Room Bot',
        settings: member.settings,
      });
      const events = new GroupChatService(db, projects);
      runtime = createGroupChatRuntime(
        {
          get: rooms.get,
          getAgent: rooms.getAgent,
          setLifecycle() {},
          async setAgentStatus() {},
          async scheduleIdleEvents() {},
          dueEvents: events.dueEvents.bind(events),
          claimEvent: events.claimEvent.bind(events),
          acknowledgeEvent: events.acknowledgeEvent.bind(events),
          deferEvent: events.deferEvent.bind(events),
        },
        threads,
      );
      if (manual) {
        const created = await issues.createManual(
          'alice',
          {},
          {
            title: 'Tracked task',
            body: 'Complete the acceptance checks and report the artifact',
            state: 'todo',
          },
        );
        assert.equal(created.source?.threadId, member.threadId);
        assert.equal(
          (await threads.getThread('alice', created.threadId)).thread.status,
          'idle',
        );
        const createdEvents = await events.dueEvents();
        assert.equal(createdEvents.length, 1);
        assert.equal(
          JSON.parse(createdEvents[0]!.text).event.actorThreadId,
          undefined,
        );
        await runtime.tick();
      } else
        await threads.runGroupChat('alice', member.threadId, {
          ...member.settings,
          id: 'human00000000001',
          parts: [
            {
              type: 'text',
              text: 'Carry out this substantial task and verify the result.',
            },
          ],
          isImmediate: true,
        });
      await until(async () => {
        const [issue] = await db.query('SELECT state,thread_id FROM issues');
        return (
          issue?.state === 'done' &&
          (await threads!.getThread('alice', issue.thread_id)).thread.status ===
            'success' &&
          (await threads!.getThread('alice', member.threadId)).thread.status ===
            'success'
        );
      });
      const [issue] = await db.query('SELECT id,state,thread_id FROM issues');
      const task = await memory.getThreadById({ threadId: issue.thread_id });
      assert.equal(task?.metadata?.issueId, issue.id);
      assert.equal(task?.metadata?.issueSourceThreadId, member.threadId);
      assert.notEqual(task?.id, member.threadId);
      assert.match(taskPrompts[0]!, /Issue #1: Tracked task/);
      assert.match(taskPrompts[0]!, /Complete the acceptance checks/);
      const pending = await events.dueEvents();
      assert.equal(
        pending.length,
        3,
        'Task comment, close and final result; no Bot creation echo',
      );
      assert.ok(
        pending.every(
          (event) => event.agentId === member.id && event.kind === 'issue',
        ),
      );
      const result = pending
        .map((event) => JSON.parse(event.text))
        .find((event) => event.event.execution);
      assert.equal(
        result.event.execution.result,
        'Verified task result: report.txt',
      );
      // Dispatch every durable event, including while the first Bot response is running.
      for (let i = 0; i < pending.length; i++) await runtime.tick();
      await until(
        async () =>
          published.length > 0 &&
          (await threads!.getThread('alice', member.threadId)).thread.status ===
            'success',
      );
      assert.match(published.join('\n'), /Issue #1 completed/);
      assert.ok(
        botPrompts.some((prompt) =>
          prompt.includes('An associated Issue changed'),
        ),
      );
      assert.equal((await events.dueEvents()).length, 0);
      const count = published.length;
      await runtime.tick();
      assert.equal(
        published.length,
        count,
        'Acknowledged events must not wake the Bot twice',
      );
      await issues.edit(
        'alice',
        issue.id,
        {},
        { state: 'todo' },
        member.threadId,
      );
      await issues.message(
        'alice',
        issue.id,
        {},
        'TASK_PROVIDER_FAILURE',
        'wait',
        undefined,
        member.threadId,
      );
      await until(
        async () =>
          (await threads!.getThread('alice', issue.thread_id)).thread.status ===
          'failed',
      );
      const failures = await events.dueEvents();
      assert.equal(
        failures.length,
        1,
        'One failure event, without echoing the Bot follow-up',
      );
      const failure = JSON.parse(failures[0]!.text);
      assert.equal(failure.event.execution.status, 'failed');
      assert.equal(
        failure.event.execution.result,
        '',
        'A failed run must not reuse the preceding success output',
      );
      assert.match(failure.event.execution.error, /TASK_PROVIDER_FAILURE/);
      await runtime.tick();
      await until(
        async () =>
          published.some((text) => text.includes('failed')) &&
          (await threads!.getThread('alice', member.threadId)).thread.status ===
            'success',
      );
    },
  );
