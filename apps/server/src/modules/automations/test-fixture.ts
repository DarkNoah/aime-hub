import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { InMemoryStore, type MastraCompositeStore } from '@mastra/core/storage';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import type { ScheduleHooks } from '@mastra/core/schedules';
import { assistantAgent } from '../../mastra/agents/code.js';
import { ThreadService } from '../threads/service.js';
import { ThreadError } from '../threads/errors.js';
import type { ResolvedChatModel } from '../models/language-model.js';
import { createAutomationRuntime } from './runtime.js';
import type { NotificationService } from '../notifications/service.js';

export const input = {
  name: 'Daily summary',
  prompt: 'Summarize the workspace.',
  cron: '0 9 * * *',
  separateThread: false,
  desktopNotification: false,
  enabled: false,
  settings: { model: null, agentId: null, reasoningEffort: 'auto' as const },
};
export const personal = { scope: 'personal' } as const;
export const project = {
  scope: 'project',
  projectId: 'project000000001',
} as const;
export const system = { scope: 'system' } as const;
export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const end = Date.now() + 10000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end)
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await delay(30);
  }
}
export async function fixture(
  t: TestContext,
  options: {
    store?: MastraCompositeStore;
    model?: ReturnType<typeof createMockModel>;
    workspaceRoot?: string;
    notifications?: Pick<NotificationService, 'publish'>;
  } = {},
) {
  const root =
    options.workspaceRoot ?? (await mkdtemp('/tmp/automation-thread-'));
  const store = options.store ?? new InMemoryStore();
  const scheduleHooks: ScheduleHooks<Mastra> = {};
  const mastra = new Mastra({
    storage: store,
    logger: false,
    schedules: scheduleHooks,
  });
  const model =
    options.model ??
    createMockModel({ mockText: 'Native generated result', version: 'v2' });
  const users = new Map(
    ['alice', 'bob', 'owner', 'member', 'admin'].map((id) => [
      id,
      { role: id === 'admin' ? 'admin' : 'user', banned: false },
    ]),
  );
  const members = new Map<string, 'owner' | 'admin' | 'member'>([
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['member', 'member'],
  ]);
  const projects = {
    list: async (userId: string, page = 0) => ({
      projects: members.has(userId)
        ? [
            {
              id: project.projectId,
              name: 'Project',
              role: members.get(userId)!,
              createdBy: 'owner',
              createdAt: '',
              updatedAt: '',
              pinned: false,
              archived: false,
            },
          ]
        : [],
      page,
      hasMore: false,
    }),
    assertMember: async (userId: string, id: string) => {
      const role = members.get(userId);
      if (id !== project.projectId || !role)
        throw new ThreadError('PROJECT_NOT_FOUND', 404);
      return { role };
    },
    get: async (_id: string, projectId: string) => ({
      id: projectId,
      name: 'Project',
      role: 'owner' as const,
      createdBy: 'owner',
      createdAt: '',
      updatedAt: '',
      pinned: false,
      archived: false,
      settings: { model: null, reasoningEffort: 'auto' as const },
      workspace: { mode: 'simple' as const, provider: 'local' as const },
    }),
  };
  const memory = new Memory({
    storage: store,
    options: { semanticRecall: false },
  });
  const threads = new ThreadService(
    memory,
    {
      validate: async () => {},
      createWorkspace: async () => root,
      open: async () => {
        assert.fail('Chat generation is not used by the automation');
      },
    },
    projects,
    undefined,
    async (id) => users.get(id)?.role === 'admin',
  );
  const calls: { userId: string; projectId?: string }[] = [];
  const runtime = createAutomationRuntime({
    mastra,
    scheduleHooks,
    threads,
    notifications: options.notifications,
    pool: {
      query: async (_sql: string, params: string[]) => ({
        rows: users.has(params[0]) ? [users.get(params[0])] : [],
      }),
    } as unknown as Pool,
    workspaceRoot: root,
    agents: { getConfig: async () => ({ ...assistantAgent, tools: [] }) },
    models: {
      getLanguageModel: async (userId, _settings, projectId) => {
        calls.push({ userId, projectId });
        return {
          model: model as unknown as ResolvedChatModel['model'],
          reference: 'fixture/model',
          providerOptions: {},
          supportsImages: false,
          toolCall: false,
        };
      },
    },
    projects,
    tools: { buildTools: async () => ({}) },
  });
  t.after(async () => {
    await runtime.shutdown();
    await threads.shutdown();
    await mastra.shutdown();
    if (!options.workspaceRoot)
      await rm(root, { recursive: true, force: true });
  });
  await runtime.initialize();
  await mastra.startWorkers();
  return {
    ...runtime,
    mastra,
    store,
    threads,
    users,
    members,
    calls,
    root,
    model,
  };
}
