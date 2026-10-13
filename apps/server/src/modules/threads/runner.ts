import { mastraDBMessageToSignal } from '@mastra/core/agent';
import {
  buildAgent,
  type AgentRuntimeOptions,
} from '../../mastra/agents/factory.js';
import type { AgentService } from '../agents/service.js';
import { fallbackAgentId, getCodeAgent } from '../../mastra/agents/index.js';
import { AgentError } from '../agents/errors.js';
import type {
  AgentExecutionOptions,
  AgentMessageInput,
} from '@mastra/core/agent';
import type { MastraModelOutput } from '@mastra/core/stream';
import { RequestContext } from '@mastra/core/request-context';
import { createObservabilityContext } from '@mastra/core/observability';
import { ThreadMessageMemory } from './message-memory.js';
import { chatSettingsSchema, type ChatSettings } from '@aime/shared/threads';
import type { Mastra } from '@mastra/core/mastra';
import type { UIMessage } from 'ai';
import type { LanguageModelService } from '../models/language-model.js';
import type { ProjectService } from '../projects/service.js';
import { defaultProjectWorkspace } from '@aime/shared/projects';
import type { ChatRunner } from './service.js';
import { ThreadError } from './errors.js';
import {
  createPersonalWorkspace,
  removePersonalWorkspace,
  createProjectFilesystem,
  createProjectWorkspace,
  getWorkspace,
  projectDirectory,
} from './workspace.js';
import { threadScope } from './scope.js';
import { listChatSkills, resolveAgentSkillPaths } from './skills.js';
import { getChatUsage } from './usage.js';
import { getBrowser } from './browser.js';
import { threadMessages } from './message-conversion.js';
import { consumeSessionStream } from './session-stream.js';
import { PendingInputs } from './pending-inputs.js';
import type { RunInput } from '@aime/shared/threads';
import { GOAL_MAX_RUNS, readThreadGoal } from './goals.js';
import { compactMemory } from './compact-memory.js';
import { buildTools, type ToolService } from '../tools/service.js';

export function createChatRunner(
  mastra: Mastra,
  models: LanguageModelService,
  workspaceRoot: string,
  projects?: Pick<ProjectService, 'get'>,
  tools?: Pick<ToolService, 'buildTools'>,
  agents?: Pick<AgentService, 'getConfig' | 'getAgent'>,
): ChatRunner {
  const getConfig = async (id?: string | null) => {
    if (agents) return agents.getConfig(id);
    const config = getCodeAgent(id ?? fallbackAgentId);
    if (!config) throw new AgentError('AGENT_NOT_FOUND', 404);
    return config;
  };
  const getAgent = async (id: string, options: AgentRuntimeOptions) =>
    agents
      ? agents.getAgent(id, options)
      : buildAgent(await getConfig(id), options);
  const getModel = async (
    userId: string,
    input: ChatSettings,
    projectId?: string,
  ) => {
    const config = await getConfig(input.agentId);
    return models.getLanguageModel(
      userId,
      { ...input, model: config.model ?? input.model },
      projectId,
    );
  };
  const storage = mastra.getStorage();
  if (!storage) throw new Error('Mastra storage is required for chat');
  const projectFilesystem = async (userId: string, projectId: string) => {
    const config = projects
      ? (await projects.get(userId, projectId)).workspace
      : defaultProjectWorkspace;
    const directory = await createProjectWorkspace(workspaceRoot, projectId);
    return createProjectFilesystem(directory, config);
  };
  return {
    resolveSettings: async (settings) => ({
      ...settings,
      agentId: (await getConfig(settings.agentId)).id,
    }),
    sessionKey: async (settings) => {
      const config = await getConfig(settings.agentId);
      return `${config.id}:${config.source === 'database' ? config.versionId : 'code'}`;
    },
    getGoal: (threadId) => readThreadGoal(storage, threadId),
    async clearGoal(threadId) {
      const store = await storage.getStore('threadState');
      await store?.deleteState({ threadId, type: 'goal' });
    },
    projectFilesystem,
    async listSkills(userId, projectId) {
      const filesystem = projectId
        ? await projectFilesystem(userId, projectId)
        : undefined;
      try {
        await filesystem?.init?.();
        return await listChatSkills(workspaceRoot, userId, projectId);
      } finally {
        await filesystem?.destroy?.();
      }
    },
    async validate(userId, input, projectId) {
      const model = await getModel(userId, input, projectId);
      if (
        'parts' in input &&
        input.parts.some((part) => part.type === 'file') &&
        !model.supportsImages
      )
        throw new ThreadError('MODEL_NO_IMAGES');
    },
    async createWorkspace(userId, projectId) {
      if (!projectId) return createPersonalWorkspace(workspaceRoot, userId);
      return createProjectWorkspace(workspaceRoot, projectId);
    },
    removePersonalWorkspace: (userId, directory) =>
      removePersonalWorkspace(workspaceRoot, userId, directory),
    async open({ thread, settings, onEvent }) {
      const scope = threadScope(thread.resourceId);
      const userId = scope.userId ?? String(thread.metadata?.createdBy ?? '');
      const projectId = scope.projectId;
      const target = { threadId: thread.id, resourceId: thread.resourceId! };
      const config = await getConfig(settings.agentId);
      settings = { ...settings, agentId: config.id };
      // Pin the configuration for this native session, including queued inputs and tool resumes.
      const sessionModel = (next: ChatSettings) =>
        models.getLanguageModel(
          userId,
          { ...next, model: config.model ?? next.model },
          projectId,
        );
      let currentSettings = settings;
      let runAbort = new AbortController();
      let resolved = await sessionModel(settings);
      const memory = new ThreadMessageMemory(
        {
          storage,
          options: {
            semanticRecall: false,
            // ThreadService generates and publishes the first title independently.
            generateTitle: false,
            observationalMemory: {
              model: resolved.model,
              scope: 'thread',
              observation: {
                messageTokens: 200_000,
                bufferTokens: false,
              },
            },
          },
        },
        target,
        (message) => {
          onEvent({ type: 'message', message, active: false });
        },
      );
      const filesystem = projectId
        ? await projectFilesystem(userId, projectId)
        : undefined;
      let workspace: ReturnType<typeof getWorkspace> | undefined;
      try {
        await filesystem?.init?.();
        workspace = getWorkspace(
          workspaceRoot,
          userId,
          projectId
            ? projectDirectory(workspaceRoot, projectId)
            : String(thread.metadata?.workspace),
          projectId,
          // The native resolver runs per execution, so automatic skills follow
          // current installations while the Agent configuration stays pinned.
          () =>
            resolveAgentSkillPaths(workspaceRoot, userId, config, projectId),
          filesystem,
        );
        const agent = await getAgent(config.id, {
          versionId:
            config.source === 'database' ? config.versionId : undefined,
          mastra,
          instructions:
            config.instructions +
            (projectId
              ? ' This is a shared project conversation. Its workspace is shared by project members and other project conversations. File tools and the command sandbox share the same mounted storage. In composite mode, a file tool path such as /data/file.txt is data/file.txt relative to the command working directory. Do not unmount or replace mount directories.'
              : ''),
          model: resolved.model,
          goal: {
            judge: () => resolved.model,
            maxRuns: GOAL_MAX_RUNS,
          },
          browser: getBrowser(),
          buildTools: (ids, defaults, disabledTools) =>
            tools
              ? tools.buildTools(ids, defaults, disabledTools)
              : buildTools(ids, defaults, { disabledTools }),
          memory,
          workspace: async ({ requestContext }) => {
            const selected =
              chatSettingsSchema.safeParse(requestContext.get('chatSettings'))
                .data ?? settings;
            return (await sessionModel(selected)).toolCall
              ? workspace
              : undefined;
          },
        });
        const messages = new Map<string, UIMessage>();
        const refreshMessages = async (streamedMessageIds: string[] = []) => {
          await memory.settled();
          const history = await memory.recall({ ...target, perPage: 80 });
          const persisted = threadMessages(history.messages);
          const persistedIds = new Set(persisted.map((message) => message.id));
          const removedMessageIds = streamedMessageIds.filter(
            (id) => !persistedIds.has(id),
          );
          for (const id of removedMessageIds) messages.delete(id);
          for (const message of persisted) {
            messages.set(message.id, structuredClone(message));
          }
          onEvent({
            type: 'reconcile',
            messages: persisted,
            removedMessageIds,
          });
          onEvent({ type: 'goal' });
        };
        await refreshMessages();
        const subscription = await agent.subscribeToThread({
          ...target,
          withInitialHistory: { perPage: 80 },
        });
        let queueCount = 0;
        const publishQueue = () =>
          onEvent({
            type: 'queue',
            count: queueCount,
            messages: pending.summaries(),
          });
        const pending = new PendingInputs(
          (input) => prepareSubmission(input),
          (signalIds) => agent.cancelQueuedMessages({ ...target, signalIds }),
          publishQueue,
          (output) => consume(output),
        );
        const unsubscribeQueue = agent.subscribeThreadEvents(
          target,
          (event) => {
            queueCount = event.count;
            publishQueue();
          },
        );
        const observing = consumeSessionStream(
          subscription,
          messages,
          () => currentSettings,
          onEvent,
          (id) => pending.consumed(id),
          refreshMessages,
        ).catch((error: unknown) => onEvent({ type: 'error', error }));
        // Track only in-flight stream consumption, never queued messages or turn order.
        const streams = new Set<Promise<void>>();
        const consume = (output: MastraModelOutput<unknown>) => {
          const consuming = (async () => {
            for await (const chunk of output.fullStream) {
              void chunk; // Subscription publishes output.
            }
            await memory.settled();
            await refreshMessages();
          })()
            .catch((error: unknown) =>
              onEvent({ type: 'error', error, runId: output.runId }),
            )
            .finally(() => streams.delete(consuming));
          streams.add(consuming);
        };
        const optionsFor = async (
          next: ChatSettings,
          createdBy?: string,
        ): Promise<AgentExecutionOptions> => {
          const selection = await sessionModel(next);
          const abortSignal = runAbort.signal;
          const requestContext = new RequestContext();
          requestContext.set('userId', createdBy ?? userId);
          requestContext.set('chatSettings', {
            agentId: config.id,
            model: next.model,
            reasoningEffort: next.reasoningEffort,
          });
          const headers = {
            'X-THREAD-ID': thread.id,
            'X-RESOURCE-ID': thread.resourceId,
            'X-USER-ID': userId,
            ...(projectId ? { 'X-PROJECT-ID': projectId } : {}),
          };
          return {
            memory: { thread: thread.id, resource: thread.resourceId },
            abortSignal,
            requestContext,
            maxSteps: 300,
            providerOptions: selection.providerOptions,
            modelSettings: {
              maxOutputTokens: selection.maxOutputTokens,
              maxRetries: 1,
              headers,
            },
            savePerStep: true,
            prepareStep: async ({ messageList }) => {
              // Native signals have already entered the message list at this point.
              // Read their settings; do not drain or inject application-owned input.
              const latest = [...messageList.get.all.db()]
                .reverse()
                .find((message) => {
                  if (message.role !== 'signal') return false;
                  return mastraDBMessageToSignal(message).type === 'user';
                });
              const metadata =
                latest && mastraDBMessageToSignal(latest).metadata;
              const fromMessage = metadata?.chatSettings;
              // Queued project messages can have different authors in one stream.
              requestContext.set(
                'userId',
                metadata?.createdBy ?? createdBy ?? userId,
              );
              currentSettings =
                chatSettingsSchema.safeParse(fromMessage).data ?? next;
              resolved = await sessionModel(currentSettings);
              return {
                model: resolved.model,
                providerOptions: resolved.providerOptions,
                // prepareStep replaces modelSettings, including request headers.
                modelSettings: {
                  maxOutputTokens: resolved.maxOutputTokens,
                  maxRetries: 1,
                  headers,
                },
              };
            },
            onStepFinish: async (event) => {
              onEvent({
                type: 'usage',
                usage: getChatUsage(event.usage, resolved),
              });
            },
            onError: ({ error }) => {
              if (!abortSignal.aborted) onEvent({ type: 'error', error });
            },
          };
        };
        const prepareSubmission = async (input: RunInput) => {
          const selection = await sessionModel(input);
          if (
            input.parts.some((part) => part.type === 'file') &&
            !selection.supportsImages
          )
            throw new ThreadError('MODEL_NO_IMAGES');
          const message: AgentMessageInput = {
            contents: input.parts.map((part) =>
              part.type === 'text'
                ? part
                : {
                    type: 'file' as const,
                    data: part.url,
                    mediaType: part.mediaType,
                    filename: part.filename,
                  },
            ),
            metadata: {
              clientMessageId: input.id,
              createdBy: input.createdBy,
              createdAt: input.createdAt,
              chatSettings: {
                agentId: config.id,
                model: input.model,
                reasoningEffort: input.reasoningEffort,
              },
            },
          };
          const destination = {
            ...target,
            ifIdle: {
              streamOptions: {
                ...(await optionsFor(input, input.createdBy)),
                untilIdle: true,
              },
            },
          };
          return () =>
            input.isImmediate
              ? agent.sendMessage(message, destination)
              : agent.queueMessage(message, {
                  ...destination,
                  queueOwnerId: thread.id,
                });
        };
        return {
          async generateTitle(input) {
            const selection = await sessionModel(input);
            const requestContext = new RequestContext();
            requestContext.set('chatSettings', {
              agentId: config.id,
              model: input.model,
              reasoningEffort: input.reasoningEffort,
            });
            return agent.genTitle(
              undefined,
              requestContext,
              createObservabilityContext(),
              selection.model,
              undefined,
              [{ role: 'user', parts: input.parts }],
            );
          },
          async compact() {
            if (streams.size) throw new ThreadError('COMPACTION_BUSY', 409);
            const selection = await sessionModel(currentSettings);
            try {
              return await compactMemory(memory, target, selection.model);
            } finally {
              await refreshMessages();
            }
          },
          async send(input) {
            if (!input.goal) {
              await pending.send(input);
              return;
            }
            const objective = input.parts
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
              .trim();
            if (!objective) throw new ThreadError('VALIDATION_ERROR', 400);
            const previous = await agent.getObjective(target);
            // A retry of an accepted submission must not reset its budget.
            const starting =
              previous?.id !== input.id && previous?.status !== 'active';
            if (starting)
              await agent.setObjective(objective, {
                ...target,
                id: input.id,
                maxRuns: GOAL_MAX_RUNS,
              });
            try {
              // New goals enter the live turn immediately, not the FIFO queue.
              await pending.send({
                ...input,
                goal: undefined,
                isImmediate: true,
              });
            } catch (error) {
              if (starting) {
                const store = await storage.getStore('threadState');
                if (previous)
                  await store?.setState({
                    threadId: thread.id,
                    type: 'goal',
                    value: previous,
                  });
                else await agent.clearObjective(target);
              }
              throw error;
            } finally {
              onEvent({ type: 'goal' });
            }
          },
          async clearGoal() {
            const goal = await agent.getObjective(target);
            if (!goal) return;
            // The native judge can finish a storage write after abort. Drain the
            // current streams before clearing so an in-flight score cannot revive it.
            if (goal.status === 'active') {
              runAbort.abort();
              agent.abortThreadStream({ ...target, clearPendingSignals: true });
              pending.discard();
              await Promise.allSettled([...streams]);
              runAbort = new AbortController();
            }
            await agent.clearObjective(target);
            onEvent({ type: 'goal' });
          },
          getQueued: (id) => pending.detail(id),
          updateQueued: (id, patch) => pending.update(id, patch),
          moveQueued: (id, beforeId) => pending.move(id, beforeId),
          cancelQueued: (id) => pending.remove(id),
          async respond(interaction, response, next) {
            await refreshMessages();
            const options = {
              ...(await optionsFor(next)),
              runId: interaction.runId,
              toolCallId: interaction.toolCallId,
            };
            const output =
              response.action === 'approve'
                ? await agent.approveToolCall({
                    ...options,
                    runId: interaction.runId,
                    untilIdle: true,
                  })
                : response.action === 'decline' &&
                    interaction.kind === 'approval'
                  ? await agent.declineToolCall({
                      ...options,
                      runId: interaction.runId,
                      reason: response.reason,
                      untilIdle: true,
                    })
                  : await agent.resumeStreamUntilIdle(
                      response.action === 'decline'
                        ? `The user declined to answer this question.${response.reason ? ` Reason: ${response.reason}` : ''}`
                        : response.action === 'resume'
                          ? response.data
                          : undefined,
                      options,
                    );
            consume(output);
          },
          async retry(next) {
            consume(await agent.streamUntilIdle([], await optionsFor(next)));
          },
          abort() {
            runAbort.abort();
            agent.abortThreadStream({ ...target, clearPendingSignals: true });
            pending.discard();
            runAbort = new AbortController();
          },
          clearQueue() {
            pending.clear();
          },
          async close() {
            runAbort.abort();
            agent.abortThreadStream({ ...target, clearPendingSignals: true });
            subscription.unsubscribe();
            unsubscribeQueue();
            await observing;
            await Promise.allSettled([...streams]);
            await memory.settled();
            await workspace?.destroy();
          },
        };
      } catch (error) {
        if (workspace) await workspace.destroy();
        else await filesystem?.destroy?.();
        throw error;
      }
    },
  };
}
