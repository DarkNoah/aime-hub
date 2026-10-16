import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Agent, type AgentExecutionOptions } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { ChatMemory, type ResolveMemoryConfig } from '../../mastra/memory.js';
import type { RequestContext } from '@mastra/core/request-context';
import type { ScheduleHooks } from '@mastra/core/schedules';
import { createObservabilityContext } from '@mastra/core/observability';
import type { Mastra } from '@mastra/core/mastra';
import type { Pool } from 'pg';
import type { Automation } from '@aime/shared/automations';
import type { AgentService } from '../agents/service.js';
import type { LanguageModelService } from '../models/language-model.js';
import type { ProjectService } from '../projects/service.js';
import type { ToolService } from '../tools/service.js';
import type { ThreadService } from '../threads/service.js';
import type { EnvironmentVariableService } from '../environment-variables/service.js';
import { ThreadError } from '../threads/errors.js';
import {
  createPersonalWorkspace,
  removePersonalWorkspace,
  createProjectFilesystem,
  createProjectWorkspace,
  discoverInstalledSkills,
  getWorkspace,
} from '../threads/workspace.js';
import {
  AutomationService,
  runStateType,
  type AutomationResult,
} from './service.js';
import { automationAgentId } from './metadata.js';
import type { NotificationService } from '../notifications/service.js';

export function createAutomationRuntime({
  mastra,
  pool,
  agents,
  models,
  projects,
  tools,
  workspaceRoot,
  scheduleHooks,
  threads,
  notifications,
  environmentVariables,
  getMemoryConfig,
}: {
  mastra: Mastra;
  pool: Pick<Pool, 'query'>;
  agents: Pick<AgentService, 'getConfig'>;
  models: Pick<LanguageModelService, 'getLanguageModel'>;
  projects: Pick<ProjectService, 'get' | 'assertMember'>;
  tools: Pick<ToolService, 'buildTools'>;
  workspaceRoot: string;
  scheduleHooks: ScheduleHooks<Mastra>;
  threads?: Pick<
    ThreadService,
    'refreshAutomationThread' | 'refreshNavigation'
  >;
  notifications?: Pick<NotificationService, 'publish'>;
  environmentVariables?: Pick<EnvironmentVariableService, 'getEnv'>;
  getMemoryConfig?: ResolveMemoryConfig;
}) {
  const storage = mastra.getStorage()!;
  const memory = new Memory({
    storage,
    options: { semanticRecall: false, generateTitle: false, lastMessages: 40 },
  });
  const stopping = new AbortController();
  const notify = async (
    task: Automation,
    status: 'succeeded' | 'failed',
    executionId: string,
  ) => {
    try {
      await notifications?.publish(task, status, executionId);
    } catch {
      console.error('Automation notification could not be saved');
    }
  };
  const resolveModel = async (
    task: Pick<Automation, 'scope' | 'createdBy' | 'settings'>,
  ) => {
    const config = await agents.getConfig(task.settings.agentId);
    const model = await models.getLanguageModel(
      task.scope.scope === 'system' ? 'system' : task.createdBy,
      { ...task.settings, model: config.model ?? task.settings.model },
      task.scope.scope === 'project' ? task.scope.projectId : undefined,
    );
    return { config, model };
  };
  const assertThread = async (task: Automation) => {
    const thread = await memory.getThreadById({ threadId: task.threadId });
    if (!thread && !task.threadCreated) return null;
    if (
      !thread ||
      thread.resourceId !== task.resourceId ||
      (thread.metadata?.automation as { id?: string } | undefined)?.id !==
        task.id ||
      thread.metadata?.archivedAt
    )
      throw new ThreadError('AUTOMATION_THREAD_UNAVAILABLE', 409);
    return thread;
  };
  const service = new AutomationService(
    mastra,
    projects,
    {
      async user(id) {
        const result = await pool.query(
          'SELECT role, banned FROM users WHERE id = $1',
          [id],
        );
        return result.rows[0] ?? null;
      },
    },
    async (meta) => {
      await resolveModel({
        scope: meta.scope,
        createdBy: meta.ownerId,
        settings: meta.data.settings,
      });
    },
    {
      async create(task) {
        // A failed metadata write can leave a valid thread; retry without replacing it.
        if (await assertThread(task)) return;
        const userId =
          task.scope.scope === 'system' ? 'system' : task.createdBy;
        const projectId =
          task.scope.scope === 'project' ? task.scope.projectId : undefined;
        const workspace = projectId
          ? await createProjectWorkspace(workspaceRoot, projectId)
          : await createPersonalWorkspace(workspaceRoot, userId);
        try {
          await memory.createThread({
            threadId: task.threadId,
            resourceId: task.resourceId,
            title: task.name,
            metadata: {
              ...task.settings,
              createdBy: task.createdBy,
              workspace,
              autoTitle: false,
              status: 'idle',
              activeId: null,
              automation: { id: task.id, visible: false },
            },
          });
        } catch (error) {
          if (!projectId)
            await removePersonalWorkspace(workspaceRoot, userId, workspace);
          throw error;
        }
      },
      async update(task) {
        if (!(await assertThread(task))) return;
        await memory.updateThread({
          id: task.threadId,
          title: task.name,
          metadata: {
            ...task.settings,
            autoTitle: false,
            automation: { id: task.id, visible: task.separateThread },
          },
        });
        if (threads)
          await threads.refreshAutomationThread(task.createdBy, task.threadId);
      },
      assert: async (task) => {
        await assertThread(task);
      },
    },
  );

  const executions = new Map<string, Promise<Execution>>();
  type Execution = Awaited<ReturnType<typeof buildExecution>>;
  const byContext = new WeakMap<RequestContext, Promise<Execution>>();
  const buildExecution = async (task: Automation, key: string) => {
    const abortSignal = AbortSignal.any([
      stopping.signal,
      AbortSignal.timeout(10 * 60_000),
    ]);
    abortSignal.throwIfAborted();
    const { config, model } = await resolveModel(task);
    const thread = await assertThread(task);
    if (!thread) throw new ThreadError('AUTOMATION_THREAD_UNAVAILABLE', 409);
    const memoryConfig = await getMemoryConfig?.();
    const executionMemory = new ChatMemory({
      ...memoryConfig,
      storage,
      options: {
        lastMessages: 40,
        ...memoryConfig?.options,
        generateTitle: false,
      },
    });
    const projectId =
      task.scope.scope === 'project' ? task.scope.projectId : undefined;
    const userId = task.scope.scope === 'system' ? 'system' : task.createdBy;
    const directory = String(thread.metadata!.workspace);
    const filesystem = projectId
      ? createProjectFilesystem(
          directory,
          (await projects.get(userId, projectId)).workspace,
        )
      : undefined;
    const installed = await discoverInstalledSkills(workspaceRoot);
    const skillPaths = config.skillPaths.map((path) => {
      const found = installed.find(
        (skill) =>
          skill.path === resolve(workspaceRoot, '.agents', 'skills', path),
      );
      if (!found) throw new ThreadError('AGENT_SKILL_UNAVAILABLE');
      return found.path;
    });
    const workspace = getWorkspace(
      workspaceRoot,
      userId,
      directory,
      projectId,
      skillPaths,
      filesystem,
      environmentVariables,
    );
    try {
      await filesystem?.init?.();
    } catch (error) {
      await workspace.destroy();
      throw error;
    }
    let runId: string | undefined;
    let suspended = false;
    let finalResult: AutomationResult | undefined;
    let writes = Promise.resolve();
    let terminal: Promise<void> | undefined;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const publish = () =>
      (writes = writes.then(async () => {
        if (!runId) return;
        const result = finalResult ?? {
          status: 'running' as const,
          text: '',
          error: null,
        };
        await (await storage.getStore('threadState'))!.setState({
          threadId: task.threadId,
          type: runStateType(runId),
          value: result,
        });
        if (result.status === 'succeeded' || result.status === 'failed')
          await notify(task, result.status, key);
        await threads?.refreshAutomationThread(
          task.createdBy,
          task.threadId,
          result.error
            ? { type: 'error', error: new ThreadError(result.error), runId }
            : {
                type: 'status',
                status: result.status === 'running' ? 'running' : 'success',
                runId,
              },
        );
      }));
    const started = async (id: string) => {
      runId = id;
      await publish();
      if (finalResult) executions.delete(key);
    };
    const finish = (result: AutomationResult) => {
      if (terminal) return terminal;
      finalResult = result;
      return (terminal = (async () => {
        try {
          await executionMemory.settled();
          await publish();
        } finally {
          try {
            await workspace.destroy();
          } finally {
            if (runId) executions.delete(key);
            settled();
          }
        }
      })());
    };
    const modelSettings = {
      maxOutputTokens: model.maxOutputTokens,
      maxRetries: 1,
      headers: {
        'X-THREAD-ID': task.threadId,
        'X-RESOURCE-ID': task.resourceId,
        'X-USER-ID': userId,
        ...(projectId ? { 'X-PROJECT-ID': projectId } : {}),
      },
    };
    const options: AgentExecutionOptions = {
      abortSignal,
      maxSteps: task.maxSteps ?? Infinity,
      savePerStep: true,
      providerOptions: model.providerOptions,
      modelSettings,
      prepareStep: async () => ({
        modelSettings,
        providerOptions: model.providerOptions,
      }),
      ...createObservabilityContext(),
      async onChunk(chunk) {
        if (
          chunk.type === 'tool-call-suspended' ||
          chunk.type === 'tool-call-approval'
        )
          suspended = true;
      },
      async onFinish(result) {
        if (result.runId) runId = result.runId;
        const error = suspended
          ? 'AUTOMATION_REQUIRES_INPUT'
          : result.error ||
              ['error', 'other', 'tool-calls'].includes(
                result.finishReason ?? '',
              )
            ? 'AUTOMATION_RUN_FAILED'
            : null;
        await finish({
          status: error ? 'failed' : 'succeeded',
          text: result.text.slice(0, 100000),
          error,
        });
      },
      onError: async () => {
        await finish({
          status: 'failed',
          text: '',
          error: 'AUTOMATION_RUN_FAILED',
        });
      },
      onAbort: async () => {
        await finish({ status: 'failed', text: '', error: 'RUN_INTERRUPTED' });
      },
    };
    return {
      task,
      config,
      model,
      workspace,
      memory: executionMemory,
      options,
      finish,
      started,
      done,
    };
  };
  const execution = (requestContext: RequestContext) => {
    let pending = byContext.get(requestContext);
    if (!pending) {
      const id = requestContext.get('automationId');
      const key = requestContext.get('automationExecutionId');
      if (typeof id !== 'string' || typeof key !== 'string')
        throw new ThreadError('AUTOMATION_NOT_FOUND', 404);
      pending = executions.get(key);
      if (!pending) {
        pending = service.prepare(id).then((task) => buildExecution(task, key));
        executions.set(key, pending);
        void pending.catch(() => executions.delete(key));
      }
      byContext.set(requestContext, pending);
    }
    return pending;
  };
  // A registered native Agent resolves the selected code/stored Agent configuration
  // per fire. RequestContext keeps concurrent personal/project/system runs isolated.
  const agent = new Agent({
    id: automationAgentId,
    name: 'Scheduled task',
    memory: async ({ requestContext }) =>
      // The scheduler also reads thread metadata before it creates a run context.
      typeof requestContext.get('automationExecutionId') === 'string'
        ? (await execution(requestContext)).memory
        : memory,
    model: async ({ requestContext }) =>
      (await execution(requestContext)).model.model,
    instructions: async ({ requestContext }) =>
      `${(await execution(requestContext)).config.instructions}\nThis is an unattended scheduled task. Complete the task and return the result. Do not request interactive input. Do not unmount or replace shared workspace directories.`,
    tools: async ({ requestContext }) =>
      tools.buildTools(
        undefined,
        undefined,
        (await execution(requestContext)).config.disabledTools,
      ),
    workspace: async ({ requestContext }) => {
      const run = await execution(requestContext);
      return run.model.toolCall ? run.workspace : undefined;
    },
    defaultOptions: async ({ requestContext }) => {
      const run = await execution(requestContext);
      requestContext.set('chatSettings', run.task.settings);
      return run.options;
    },
  });
  mastra.addAgent(agent);
  scheduleHooks.prepare = async ({ schedule }) => {
    if (schedule.agentId !== automationAgentId) return;
    await service.prepare(schedule.id);
    return {
      ifActive: { behavior: 'discard' },
      ifIdle: {
        behavior: 'wake',
        streamOptions: {
          requestContext: {
            automationId: schedule.id,
            automationExecutionId: randomUUID(),
          },
        },
      },
    };
  };
  scheduleHooks.onError = async ({ effective, schedule, trigger }) => {
    const key =
      effective?.ifIdle?.streamOptions?.requestContext?.automationExecutionId;
    if (schedule.agentId !== automationAgentId) return;
    const run =
      typeof key === 'string'
        ? await executions.get(key)?.catch(() => undefined)
        : undefined;
    await run?.finish({
      status: 'failed',
      text: '',
      error: 'AUTOMATION_RUN_FAILED',
    });
    try {
      // Also covers failure before the native runId exists. Persisted IDs deduplicate
      // this fallback with the agent's terminal callback.
      await notify(
        run?.task ?? (await service.notificationTask(schedule.id)),
        'failed',
        typeof key === 'string'
          ? key
          : `${trigger.kind}:${trigger.firedAt.toISOString()}`,
      );
    } catch {
      /* Task may have been deleted while the trigger was being prepared. */
    }
    if (typeof key === 'string') executions.delete(key);
  };
  scheduleHooks.onFinish = async ({ effective, runId, outcome }) => {
    const key =
      effective.ifIdle?.streamOptions?.requestContext?.automationExecutionId;
    if (typeof key !== 'string') return;
    const run = await executions.get(key)?.catch(() => undefined);
    if (!run) return;
    if (runId && outcome === 'succeeded') await run.started(runId);
    else {
      await run.finish({
        status: 'skipped',
        text: '',
        error: 'AUTOMATION_ALREADY_RUNNING',
      });
      executions.delete(key);
    }
  };
  return {
    service,
    memory,
    agent,
    initialize: () => service.initialize(),
    async shutdown() {
      await mastra.scheduler?.stop();
      stopping.abort();
      const active = await Promise.allSettled([...executions.values()]);
      await Promise.allSettled(
        active.flatMap((entry) =>
          entry.status === 'fulfilled' ? [entry.value.done] : [],
        ),
      );
    },
  };
}
