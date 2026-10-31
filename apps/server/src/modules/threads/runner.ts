import { randomUUID } from 'node:crypto';
import { createGroupChatAgent } from '../../mastra/agents/group-chat.js';
import { botAgent } from '../../mastra/agents/bot-agent.js';
import {
  groupChatThreadBinding,
  type GroupChatThreadBinding,
} from '../group-chats/metadata.js';
import { groupChatMemoryLocation } from '../group-chats/memory.js';
import type { GroupChatService } from '../group-chats/service.js';
import { SpeechPlayback } from '../audio/playback.js';
import { runtimeTokenCounts } from '../usage/runtime.js';
import type { UsageService } from '../usage/service.js';
import type { EnvironmentVariableService } from '../environment-variables/service.js';
import type { LocalApiAccess } from '../auth/local-api.js';
import type { PluginService } from '../plugins/service.js';
import { mastraDBMessageToSignal } from '@mastra/core/agent';
import {
  buildAgent,
  type AgentRuntimeOptions,
} from '../../mastra/agents/factory.js';
import type { AgentService } from '../agents/service.js';
import { loadLocalAgents } from '../agents/local.js';
import { fallbackAgentId, getAgent } from '../../mastra/agents/index.js';
import { AgentError } from '../agents/errors.js';
import type {
  AgentExecutionOptions,
  AgentMessageInput,
  MessageList,
} from '@mastra/core/agent';
import type { MastraModelOutput } from '@mastra/core/stream';
import { RequestContext } from '@mastra/core/request-context';
import { createObservabilityContext } from '@mastra/core/observability';
import { ThreadMessageMemory } from './message-memory.js';
import type { ResolveMemoryConfig } from '../../mastra/memory.js';
import { chatSettingsSchema, type ChatSettings } from '@aime/shared/threads';
import {
  reconcileThreadMessages,
  sortThreadMessages,
} from '@aime/shared/thread-messages';
import type { Mastra } from '@mastra/core/mastra';
import type { UIMessage } from 'ai';
import type { LanguageModelService } from '../models/language-model.js';
import type { ProjectService } from '../projects/service.js';
import { defaultProjectWorkspace } from '@aime/shared/projects';
import type { ChatRunner } from './service.js';
import { ThreadError } from './errors.js';
import {
  createPersonalWorkspace,
  createPersonalSharedDirectory,
  removePersonalWorkspace,
  createProjectFilesystem,
  createProjectWorkspace,
  getWorkspace,
  projectDirectory,
  userDirectory,
} from './workspace.js';
import { threadScope } from './scope.js';
import { listChatSkills, resolveAgentSkillPaths } from './skills.js';
import { getChatUsage } from './usage.js';
import { ThreadBrowsers } from './browser/registry.js';
import { resolve } from 'node:path';
import { threadMessages } from './message-conversion.js';
import { consumeSessionStream } from './session-stream.js';
import { PendingInputs } from './pending-inputs.js';
import type { RunInput } from '@aime/shared/threads';
import { GOAL_MAX_RUNS, readThreadGoal } from './goals.js';
import { compactMemory } from './compact-memory.js';
import { buildTools, type ToolService } from '../tools/service.js';
import { CommandSandbox } from '../../mastra/tools/command/sandbox.js';
import { agentEnvironment } from './agent-environment.js';
import { AgentsMDProcessor } from '../../mastra/processors/agents-md.js';
import { ModelCompatibilityProcessor } from '../../mastra/processors/model-compatibility.js';
import { MemoryMDProcessor } from '../../mastra/processors/memory-md.js';
import { IncompleteToolCallsProcessor } from '../../mastra/processors/incomplete-tool-calls.js';
import { AttachmentProcessor } from './attachment-processor.js';
import { AttachmentMediaReader } from './attachment-media.js';
import {
  ContextBudget,
  ContextCompactionProcessor,
} from './context-compaction.js';
import type { ObservationalMemoryConfig } from '@mastra/memory/processors';

function latestInputMetadata(
  messageList: MessageList,
  requestContext?: RequestContext,
) {
  // A retry adopts the current selection until a new user signal arrives.
  // Stored signals retain the model originally used to submit that message.
  const source = requestContext?.get('chatRetry')
    ? messageList.get.input
    : messageList.get.all;
  const latest = [...source.db()]
    .reverse()
    .find(
      (message) =>
        message.role === 'signal' &&
        mastraDBMessageToSignal(message).type === 'user',
    );
  return latest && mastraDBMessageToSignal(latest).metadata;
}

export function createChatRunner(
  mastra: Mastra,
  models: LanguageModelService,
  workspaceRoot: string,
  projects?: Pick<ProjectService, 'get'>,
  tools?: Pick<ToolService, 'buildTools'>,
  agents?: Pick<AgentService, 'getConfig' | 'getAgent'>,
  usage?: Pick<UsageService, 'record'> &
    Partial<Pick<UsageService, 'latestThreadUsage' | 'threadConsumedTokens'>>,
  environmentVariables?: Pick<EnvironmentVariableService, 'getEnv'>,
  getMemoryConfig?: ResolveMemoryConfig,
  localApi?: LocalApiAccess,
  plugins?: Pick<PluginService, 'workspaceDirectory' | 'access'>,
  groupChats?: GroupChatService,
): ChatRunner {
  const getConfig = async (
    id?: string | null,
    userId?: string,
    projectId?: string,
    roomRole?: GroupChatThreadBinding['role'],
  ) => {
    // Only trusted room metadata selects the hidden leader, never a client-supplied ID.
    if (roomRole === 'bot') return structuredClone(botAgent);
    if (agents)
      return agents.getConfig(
        id,
        undefined,
        userId ? { userId, projectId } : undefined,
      );
    const config = getAgent(id ?? fallbackAgentId);
    if (!config) throw new AgentError('AGENT_NOT_FOUND', 404);
    return config;
  };
  const createAgent = async (
    id: string,
    options: AgentRuntimeOptions,
    userId: string,
    projectId?: string,
  ) =>
    agents
      ? agents.getAgent(id, options, { userId, projectId })
      : buildAgent(await getConfig(id, userId, projectId), options);
  const getModel = async (
    userId: string,
    input: ChatSettings,
    projectId?: string,
    roomRole?: GroupChatThreadBinding['role'],
  ) => {
    const config = await getConfig(input.agentId, userId, projectId, roomRole);
    return models.getLanguageModel(
      userId,
      {
        ...input,
        model: roomRole
          ? (input.model ?? config.model)
          : (config.model ?? input.model),
      },
      projectId,
    );
  };
  const storage = mastra.getStorage();
  if (!storage) throw new Error('Mastra storage is required for chat');
  const browsers = new ThreadBrowsers(
    resolve(workspaceRoot, '.browser-profiles'),
  );
  const projectFilesystem = async (userId: string, projectId: string) => {
    const config = projects
      ? (await projects.get(userId, projectId)).workspace
      : defaultProjectWorkspace;
    const directory = await createProjectWorkspace(workspaceRoot, projectId);
    return createProjectFilesystem(directory, config);
  };
  return {
    browsers,
    resolveSettings: async (settings, userId, projectId, roomRole) => ({
      ...settings,
      agentId: (await getConfig(settings.agentId, userId, projectId, roomRole))
        .id,
    }),
    sessionKey: async (settings, userId, projectId, roomRole) => {
      const config = await getConfig(
        settings.agentId,
        userId,
        projectId,
        roomRole,
      );
      return `${config.id}:${config.source === 'code' ? 'code' : config.versionId}`;
    },
    getGoal: (threadId) => readThreadGoal(storage, threadId),
    getConsumedTokens: usage?.threadConsumedTokens
      ? (threadId) => usage.threadConsumedTokens!(threadId)
      : undefined,
    async clearGoal(threadId) {
      const store = await storage.getStore('threadState');
      await store?.deleteState({ threadId, type: 'goal' });
    },
    projectFilesystem,
    personalSharedDirectory: (userId) =>
      createPersonalSharedDirectory(workspaceRoot, userId),
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
    async validate(userId, input, projectId, roomRole) {
      await getModel(userId, input, projectId, roomRole);
    },
    async assertGroupChatAccess(userId, thread) {
      const binding = groupChatThreadBinding(thread.metadata);
      if (!binding || !groupChats)
        throw new ThreadError('THREAD_NOT_FOUND', 404);
      const member = await groupChats.getAgent(
        userId,
        binding.roomId,
        binding.memberId,
      );
      if (member.threadId !== thread.id || member.role !== binding.role)
        throw new ThreadError('THREAD_NOT_FOUND', 404);
    },
    async assertGroupChatRun(userId, thread, settings) {
      const binding = groupChatThreadBinding(thread.metadata);
      if (!binding || !groupChats) throw new ThreadError('FORBIDDEN', 403);
      const member = await groupChats.getAgent(
        userId,
        binding.roomId,
        binding.memberId,
      );
      if (
        !member.enabled ||
        member.threadId !== thread.id ||
        member.role !== binding.role
      )
        throw new ThreadError('ROOM_AGENT_DISABLED', 409);
      if (
        (member.settings.agentId ?? null) !== (settings.agentId ?? null) ||
        member.settings.model !== settings.model ||
        member.settings.reasoningEffort !== settings.reasoningEffort
      )
        throw new ThreadError('ROOM_AGENT_SETTINGS_CHANGED', 409);
    },
    async createWorkspace(userId, projectId) {
      if (!projectId) return createPersonalWorkspace(workspaceRoot, userId);
      return createProjectWorkspace(workspaceRoot, projectId);
    },
    async pluginWorkspace(pluginId, userId) {
      return plugins?.workspaceDirectory(pluginId, userId);
    },
    async assertPluginAccess(pluginId, userId) {
      if (!plugins) return;
      // Preserve archived/disabled plugin chats, while enforcing current user grants.
      try {
        await plugins.access.assertAllowed(pluginId, userId);
      } catch {
        throw new ThreadError('PLUGIN_FORBIDDEN', 403);
      }
    },
    removePersonalWorkspace: (userId, directory) =>
      removePersonalWorkspace(workspaceRoot, userId, directory),
    async open({ thread, settings, onEvent, actorId }) {
      const scope = threadScope(thread.resourceId);
      const roomBinding = groupChatThreadBinding(thread.metadata);
      const userId =
        scope.userId ??
        (roomBinding ? actorId : undefined) ??
        String(thread.metadata?.createdBy ?? '');
      const projectId = scope.projectId;
      const workspacePlugin =
        typeof thread.metadata?.workspacePlugin === 'string'
          ? thread.metadata.workspacePlugin
          : undefined;
      const target = { threadId: thread.id, resourceId: thread.resourceId! };
      const config = await getConfig(
        settings.agentId,
        actorId ?? userId,
        projectId,
        roomBinding?.role,
      );
      settings = { ...settings, agentId: config.id };
      // Pin the configuration for this native session, including queued inputs and tool resumes.
      const sessionModel = (next: ChatSettings) =>
        models.getLanguageModel(
          userId,
          {
            ...next,
            model: roomBinding
              ? (next.model ?? config.model)
              : (config.model ?? next.model),
          },
          projectId,
        );
      let currentSettings = settings;
      let runAbort = new AbortController();
      const speechPlayback = new SpeechPlayback((event) =>
        onEvent({ type: 'speech', event }),
      );
      let resolved = await sessionModel(settings);
      const memoryConfig = await getMemoryConfig?.();
      const observationConfig = {
        model: resolved.model,
        scope: 'thread',
        observation: {
          messageTokens: 30_000,
          bufferTokens: false,
          failurePolicy: 'abort',
        },
      } satisfies Omit<ObservationalMemoryConfig, 'storage'>;
      const memory = new ThreadMessageMemory(
        {
          ...memoryConfig,
          storage,
          options: {
            semanticRecall: false,
            ...memoryConfig?.options,
            // ThreadService generates and publishes the first title independently.
            generateTitle: false,
            observationalMemory: observationConfig,
          },
        },
        target,
        (message) => {
          onEvent({ type: 'message', message, active: false });
        },
      );
      const budget = await ContextBudget.load(
        await storage.getStore('threadState'),
        thread.id,
        thread.metadata?.usage,
        async () => usage?.latestThreadUsage?.(thread.id, config.id),
      );
      const nativeEngine = await memory.omEngine;
      if (!nativeEngine) throw new Error('Observational memory is not enabled');
      const compaction = new ContextCompactionProcessor(
        {
          ...observationConfig,
          storage: nativeEngine.getStorage(),
          memory,
          mastra,
        },
        memory,
        budget,
        async ({ messageList, requestContext }) => {
          const metadata =
            latestInputMetadata(messageList, requestContext) ??
            (requestContext?.get('chatInputMetadata') as ReturnType<
              typeof latestInputMetadata
            >);
          if (metadata) requestContext?.set('chatInputMetadata', metadata);
          const selected =
            chatSettingsSchema.safeParse(metadata?.chatSettings).data ??
            chatSettingsSchema.safeParse(requestContext?.get('chatSettings'))
              .data ??
            currentSettings;
          return (await sessionModel(selected)).maxContextTokens;
        },
        (error) => onEvent({ type: 'error', error }),
      );
      const filesystem =
        projectId && !workspacePlugin
          ? await projectFilesystem(userId, projectId)
          : undefined;
      let workspace: ReturnType<typeof getWorkspace> | undefined;
      let unsubscribeCommands: (() => void) | undefined;
      try {
        await filesystem?.init?.();
        workspace = getWorkspace(
          workspaceRoot,
          userId,
          projectId && !workspacePlugin
            ? projectDirectory(workspaceRoot, projectId)
            : String(thread.metadata?.workspace),
          projectId,
          // The native resolver runs per execution, so automatic skills follow
          // current installations while the Agent configuration stays pinned.
          (context) =>
            resolveAgentSkillPaths(
              workspaceRoot,
              String(
                context.requestContext?.get('userId') ?? actorId ?? userId,
              ),
              config,
              projectId,
            ),
          filesystem,
          environmentVariables,
          (authorId) => ({
            ...localApi?.environment(authorId),
            APP_THREAD_ID: thread.id,
            APP_PROJECT_ID: projectId ?? '',
          }),
          workspacePlugin,
        );
        const commands = workspace.sandbox;
        if (!(commands instanceof CommandSandbox))
          throw new Error('Command sandbox is unavailable');
        unsubscribeCommands = commands.onCommandSessionsChanged(() =>
          onEvent({ type: 'commands' }),
        );
        const workspaceInstructions = workspacePlugin
          ? ` This conversation uses the persistent workspace of plugin "${workspacePlugin}". Files are shared with the plugin and other conversations using this plugin workspace, including conversations owned by other users. File tools and the command sandbox use the same directory.`
          : projectId
            ? ' This is a shared project conversation. Its workspace is shared by project members and other project conversations. File tools and the command sandbox share the same mounted storage. In composite mode, a file tool path such as /data/file.txt is data/file.txt relative to the command working directory. Do not unmount or replace mount directories.'
            : '';
        const attachmentMedia = new AttachmentMediaReader(
          workspace.filesystem!,
          projectId
            ? undefined
            : await createPersonalSharedDirectory(workspaceRoot, userId),
        );
        const inputModalities = (selection: typeof resolved) =>
          selection.modalitiesInput ??
          (selection.supportsImages ? ['text', 'image'] : ['text']);
        const roomMemory = roomBinding
          ? groupChatMemoryLocation(
              commands.workingDirectory,
              roomBinding,
              workspace.filesystem!,
            )
          : undefined;
        const memoryDirectory = roomMemory
          ? roomMemory.directory
          : resolve(
              projectId
                ? projectDirectory(workspaceRoot, projectId)
                : userDirectory(workspaceRoot, userId),
              '.agents',
              'memory',
            );
        const inputProcessors = [
          compaction,
          new IncompleteToolCallsProcessor(),
          new AgentsMDProcessor(commands.workingDirectory),
          new AttachmentProcessor(attachmentMedia, () =>
            inputModalities(resolved),
          ),
          new MemoryMDProcessor(memoryDirectory),
        ];
        const agentOptions: AgentRuntimeOptions = {
          localSubagents: () =>
            loadLocalAgents(workspaceRoot, userId, projectId),
          versionId:
            config.source === 'database' ? config.versionId : undefined,
          mastra,
          instructions:
            config.instructions +
            workspaceInstructions +
            (typeof thread.metadata?.issueId === 'number'
              ? `\nThis chat belongs to Issue #${thread.metadata.issueId}. Use issue view ${thread.metadata.issueId} to read its current task and comments before working. Continue this issue instead of creating a duplicate. Use issue edit ${thread.metadata.issueId} --state decision when a user decision is needed. Close it with issue close ${thread.metadata.issueId} only after the task is fulfilled and verified. Simple exploration, search, research or direct answers do not need new issues.`
              : ''),
          model: resolved.model,
          // Matching native processor IDs suppress Memory's default OM processors.
          // Keep the same processor for input and output so native turn cleanup,
          // response ID rotation and observation context injection remain intact.
          inputProcessors,
          outputProcessors: [compaction],
          subagentOptions: (child) => {
            // A null model follows the parent's current selection, including queued changes.
            const childModel = () =>
              child.model
                ? models.getLanguageModel(
                    userId,
                    { ...currentSettings, model: child.model },
                    projectId,
                  )
                : Promise.resolve(resolved);
            const compatibility = new ModelCompatibilityProcessor(childModel);
            return {
              // Native delegation already carries the parent's injected context.
              inputProcessors: [
                new IncompleteToolCallsProcessor(),
                new AttachmentProcessor(attachmentMedia, async () =>
                  inputModalities(await childModel()),
                ),
                compatibility,
              ],
              outputProcessors: [compatibility],
              instructions: async () =>
                child.instructions +
                workspaceInstructions +
                '\n\n' +
                agentEnvironment(
                  commands.workingDirectory,
                  (await childModel()).reference,
                ),
              model: async () => (await childModel()).model,
              workspace: async () =>
                (await childModel()).toolCall ? workspace : undefined,
              defaultOptions: async ({ requestContext }) => {
                const selection = await childModel();
                const author = String(requestContext.get('userId') ?? userId);
                let startedAt = performance.now();
                let createdAt = new Date();
                let stepNumber = 0;
                return {
                  providerOptions: selection.providerOptions,
                  modelSettings: {
                    maxOutputTokens: selection.maxOutputTokens,
                    maxRetries: 1,
                    headers: {
                      'X-THREAD-ID': thread.id,
                      'X-RESOURCE-ID': thread.resourceId,
                      'X-USER-ID': author,
                      ...(projectId ? { 'X-PROJECT-ID': projectId } : {}),
                    },
                  },
                  onStepFinish: async (event) => {
                    if (usage) {
                      const slash = selection.reference.indexOf('/');
                      await usage.record({
                        id: randomUUID(),
                        createdAt,
                        finishedAt: new Date(),
                        durationMs: Math.max(
                          0,
                          Math.round(performance.now() - startedAt),
                        ),
                        userId: author,
                        projectId: projectId ?? null,
                        threadId: thread.id,
                        agentId: child.id,
                        runId: event.runId ?? null,
                        stepNumber,
                        providerId:
                          slash > 0
                            ? selection.reference.slice(0, slash)
                            : null,
                        model:
                          event.response.modelId ??
                          event.model?.modelId ??
                          selection.reference.slice(slash + 1),
                        modelReference: selection.reference,
                        finishReason: event.finishReason ?? null,
                        ...runtimeTokenCounts(event.usage),
                      });
                    }
                    stepNumber += 1;
                    startedAt = performance.now();
                    createdAt = new Date();
                  },
                };
              },
            };
          },
          goal: {
            judge: () => resolved.model,
            maxRuns: GOAL_MAX_RUNS,
          },
          browser: browsers.forThread(thread.id, userId),
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
        };
        if (roomBinding && !groupChats)
          throw new ThreadError('THREAD_NOT_FOUND', 404);
        const build = (id: string, options: AgentRuntimeOptions) =>
          createAgent(id, options, actorId ?? userId, projectId);
        const agent = roomBinding
          ? await createGroupChatAgent(
              config.id,
              agentOptions,
              {
                service: groupChats!,
                userId: actorId ?? userId,
                ...roomBinding,
                threadId: thread.id,
                memoryPath: roomMemory!.filePath,
              },
              build,
            )
          : await build(config.id, agentOptions);
        const messages = new Map<string, UIMessage>();
        const refreshMessages = async (streamedMessageIds: string[] = []) => {
          await memory.settled();
          const history = await memory.recall({ ...target, perPage: 80 });
          const persisted = sortThreadMessages(
            threadMessages(history.messages),
          );
          const reconciled = reconcileThreadMessages(
            [...messages.values()],
            persisted,
            streamedMessageIds,
          );
          const retainedIds = new Set(reconciled.map((message) => message.id));
          const removedMessageIds = [
            ...new Set([...messages.keys(), ...streamedMessageIds]),
          ].filter((id) => !retainedIds.has(id));
          messages.clear();
          for (const message of reconciled) {
            messages.set(message.id, structuredClone(message));
          }
          onEvent({
            type: 'reconcile',
            messages: reconciled,
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
          retry = false,
        ): Promise<AgentExecutionOptions> => {
          for (const reference of [
            config.id,
            ...(roomBinding ? [] : Object.values(config.agents)),
          ]) {
            if (reference.startsWith('plugin:'))
              await getConfig(reference, createdBy ?? userId, projectId);
          }
          for (const plugin of new Set([
            thread.metadata?.plugin,
            workspacePlugin,
          ])) {
            if (typeof plugin === 'string')
              await plugins?.access.assertAllowed(plugin, createdBy ?? userId);
          }
          const selection = await sessionModel(next);
          const abortSignal = runAbort.signal;
          const requestContext = new RequestContext();
          if (roomBinding) requestContext.set('nonInteractiveTools', true);
          requestContext.set('chatRetry', retry);
          requestContext.set('speechPlayback', speechPlayback);
          requestContext.set('userId', createdBy ?? userId);
          // Resolve against the current message author, including queued project messages.
          requestContext.set(
            'browser',
            browsers.agentContext(thread.id, () =>
              String(requestContext.get('userId') ?? userId),
            ),
          );
          requestContext.set('projectId', projectId);
          requestContext.set('issueId', thread.metadata?.issueId);
          requestContext.set(
            'issueSourceThreadId',
            roomBinding ? thread.id : undefined,
          );
          requestContext.set('chatSettings', {
            agentId: config.id,
            model: next.model,
            reasoningEffort: next.reasoningEffort,
          });
          let step = {
            id: randomUUID(),
            createdAt: new Date(),
            startedAt: performance.now(),
            userId: createdBy ?? userId,
            model: selection,
            number: 0,
          };
          const headers = {
            'X-THREAD-ID': thread.id,
            'X-RESOURCE-ID': thread.resourceId,
            'X-USER-ID': createdBy ?? userId,
            ...(projectId ? { 'X-PROJECT-ID': projectId } : {}),
          };
          let environmentPrompt = '';
          const compatibility = new ModelCompatibilityProcessor(
            async ({ messageList, stepNumber }) => {
              // Native signals have already entered the message list at this point.
              // Read their settings; do not drain or inject application-owned input.
              // OM may have just compacted the signal that carried these settings.
              const metadata =
                latestInputMetadata(messageList, requestContext) ??
                (requestContext.get('chatInputMetadata') as ReturnType<
                  typeof latestInputMetadata
                >);
              const fromMessage = metadata?.chatSettings;
              // Queued project messages can have different authors in one stream.
              const author =
                latestInputMetadata(messageList)?.createdBy ??
                metadata?.createdBy;
              const authorId =
                typeof author === 'string' ? author : (createdBy ?? userId);
              requestContext.set('userId', authorId);
              currentSettings =
                chatSettingsSchema.safeParse(fromMessage).data ?? next;
              resolved = await sessionModel(currentSettings);
              environmentPrompt = agentEnvironment(
                commands.workingDirectory,
                resolved.reference,
              );
              // Refresh only our environment block; retain workspace, skills and memory prompts.
              messageList
                .clearSystemMessages('agent-environment')
                .addSystem(environmentPrompt, 'agent-environment');
              step = {
                id: randomUUID(),
                createdAt: new Date(),
                startedAt: performance.now(),
                userId: authorId,
                model: resolved,
                number: stepNumber,
              };
              headers['X-USER-ID'] = step.userId;
              return {
                ...resolved,
                // Preserve per-step settings and request headers after selection.
                modelSettings: {
                  maxOutputTokens: resolved.maxOutputTokens,
                  maxRetries: 1,
                  headers,
                },
              };
            },
          );
          return {
            inputProcessors: [...inputProcessors, compatibility],
            outputProcessors: [compaction, compatibility],
            memory: { thread: thread.id, resource: thread.resourceId },
            abortSignal,
            requestContext,
            maxSteps: Infinity,
            providerOptions: selection.providerOptions,
            modelSettings: {
              maxOutputTokens: selection.maxOutputTokens,
              maxRetries: 1,
              headers,
            },
            savePerStep: true,
            delegation: {
              // Each child supplies its own model identity in its environment block.
              messageFilter: ({ messages }) =>
                messages.filter(
                  (message) =>
                    message.role !== 'system' ||
                    !(typeof message.content === 'string'
                      ? message.content === environmentPrompt
                      : message.content.parts.some(
                          (part) =>
                            part.type === 'text' &&
                            part.text === environmentPrompt,
                        )),
                ),
            },
            onStepFinish: async (event) => {
              const chatUsage = getChatUsage(event.usage, step.model);
              await budget.record(chatUsage);
              if (usage) {
                const slash = step.model.reference.indexOf('/');
                await usage.record({
                  id: step.id,
                  createdAt: step.createdAt,
                  finishedAt: new Date(),
                  durationMs: Math.max(
                    0,
                    Math.round(performance.now() - step.startedAt),
                  ),
                  userId: step.userId,
                  projectId: projectId ?? null,
                  threadId: thread.id,
                  agentId: config.id,
                  runId: event.runId ?? null,
                  stepNumber: step.number,
                  providerId:
                    slash > 0 ? step.model.reference.slice(0, slash) : null,
                  model:
                    event.response.modelId ??
                    event.model?.modelId ??
                    step.model.reference.slice(slash + 1),
                  modelReference: step.model.reference,
                  finishReason: event.finishReason ?? null,
                  ...runtimeTokenCounts(event.usage),
                });
              }
              onEvent({
                type: 'usage',
                usage: chatUsage,
              });
            },
            onError: ({ error }) => {
              if (!abortSignal.aborted) onEvent({ type: 'error', error });
            },
          };
        };
        const prepareSubmission = async (input: RunInput) => {
          await sessionModel(input);
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
          speech: speechPlayback,
          commands: {
            list: () => commands.listCommandSessions(),
            cleanup: (sessionId) => commands.cleanupCommandSession(sessionId),
          },
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
              [
                {
                  role: 'user',
                  parts: input.parts.map((part) =>
                    part.type === 'text' ||
                    inputModalities(selection).includes('image')
                      ? part
                      : {
                          type: 'text' as const,
                          text: `Attached file: ${part.filename ?? 'attachment'} (${part.mediaType})`,
                        },
                  ),
                },
              ],
            );
          },
          async compact() {
            if (streams.size) throw new ThreadError('COMPACTION_BUSY', 409);
            const selection = await sessionModel(currentSettings);
            try {
              const result = await compactMemory(
                memory,
                target,
                selection.model,
              );
              if (result.observed) await budget.consume();
              return result;
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
            consume(
              await agent.streamUntilIdle(
                [],
                await optionsFor(next, undefined, true),
              ),
            );
          },
          abort() {
            speechPlayback.stop();
            runAbort.abort();
            agent.abortThreadStream({ ...target, clearPendingSignals: true });
            pending.discard();
            runAbort = new AbortController();
          },
          clearQueue() {
            pending.clear();
          },
          async close() {
            const closingSpeech = speechPlayback.close();
            unsubscribeCommands?.();
            runAbort.abort();
            agent.abortThreadStream({ ...target, clearPendingSignals: true });
            subscription.unsubscribe();
            unsubscribeQueue();
            await observing;
            await Promise.allSettled([...streams]);
            await closingSpeech;
            await compaction.engine.settled();
            await memory.settled();
            await workspace?.destroy();
            await browsers.releaseInactive(thread.id);
          },
        };
      } catch (error) {
        await speechPlayback.close();
        unsubscribeCommands?.();
        await browsers.releaseInactive(thread.id);
        if (workspace) await workspace.destroy();
        else await filesystem?.destroy?.();
        throw error;
      }
    },
  };
}
