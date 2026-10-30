import type { PluginService } from '../plugins/service.js';
import { randomUUID } from 'node:crypto';
import type {
  AgentsStorage,
  StorageAgentSnapshotType,
  StorageAgentType,
} from '@mastra/core/storage';
import type { AgentVersion } from '@mastra/core/storage/domains/agents';
import {
  agentInputSchema,
  agentUpdateSchema,
  agentStatusSchema,
  agentDefaultsSchema,
  type AgentDefaults,
  type AdminAgent,
  type AvailableAgents,
  type AgentCatalog,
  type AgentInput,
  type AgentUpdate,
  type AgentStatusInput,
  type ManagedAgent,
  type RuntimeAgent,
  type AgentScopeContext,
} from '@aime/shared/agents';
import type { SkillService } from '../skills/service.js';
import type { ToolService } from '../tools/service.js';
import type { ProviderService } from '../providers/service.js';
import { AgentError } from './errors.js';
import {
  agentRegistry,
  fallbackAgentId,
  getAgent,
  getCodeAgent,
} from '../../mastra/agents/index.js';
import type { AgentSettingsStore } from './settings.js';
import type { LocalAgentService } from './local-service.js';
import {
  buildAgent,
  type AgentRuntimeOptions,
} from '../../mastra/agents/factory.js';

const metadata = { managedBy: 'admin-agents', configVersion: 1 };
// Installed skills live in the application's filesystem, not mastra_skills.
// Preserve their relative identities in a native, versioned workspace provider ref.
// The chat runtime resolves these references through installed skill discovery.
const skillProvider = 'installed-skills';

export class AgentService {
  private mutations = Promise.resolve();
  constructor(
    private readonly store: AgentsStorage,
    private readonly skills: Pick<SkillService, 'list'>,
    private readonly tools: Pick<ToolService, 'list'>,
    private readonly providers: Pick<ProviderService, 'listAvailableModels'>,
    private readonly settings?: AgentSettingsStore,
    private readonly plugins?: PluginService,
    private readonly local?: LocalAgentService,
  ) {}

  async catalog(): Promise<AgentCatalog> {
    const [skills, tools, agents] = await Promise.all([
      this.skills.list(),
      this.tools.list(),
      this.list('published'),
    ]);
    return {
      agents: agents.map(({ id, name, description, model, source }) => ({
        id,
        name,
        description,
        model,
        source,
      })),
      tools: tools.map(({ id, config }) => ({
        id,
        enabled: config.enabled,
      })),
      skills: skills.skills.filter((skill) => skill.valid),
    };
  }

  private async record(id: string) {
    if (getCodeAgent(id)?.hidden) throw new AgentError('AGENT_NOT_FOUND', 404);
    if (getAgent(id) || id.startsWith('plugin:'))
      throw new AgentError('AGENT_READ_ONLY', 403);
    const row = await this.store.getById(id);
    if (
      !row ||
      row.metadata?.managedBy !== metadata.managedBy ||
      row.metadata?.configVersion !== metadata.configVersion
    )
      throw new AgentError('AGENT_NOT_FOUND', 404);
    return row;
  }

  private view(row: StorageAgentType, version: AgentVersion): ManagedAgent {
    const workspace = version.workspace;
    const settings =
      workspace &&
      !Array.isArray(workspace) &&
      workspace.type === 'provider' &&
      workspace.provider === skillProvider
        ? workspace.config
        : {};
    const model = version.model;
    const config = agentInputSchema.safeParse({
      name: version.name,
      description: version.description ?? '',
      instructions: version.instructions,
      model: Array.isArray(model)
        ? model.length === 0
          ? null
          : ''
        : `${model.providerId}/${model.name}`,
      tools: Object.keys(version.tools ?? {}),
      disabledTools: settings.disabledTools ?? [],
      // Preserve explicit selections in versions saved before modes existed.
      skillsMode:
        settings.skillsMode ??
        (Array.isArray(settings.skillPaths) && settings.skillPaths.length
          ? 'custom'
          : 'auto'),
      skillPaths: settings.skillPaths ?? [],
      agents: settings.agents ?? {},
    });
    if (!config.success) throw new AgentError('AGENT_CONFIG_UNSUPPORTED', 409);
    return {
      ...config.data,
      source: 'database',
      id: row.id,
      status: row.status,
      versionId: version.id,
      versionNumber: version.versionNumber,
      createdAt: row.createdAt.toISOString(),
      updatedAt: version.createdAt.toISOString(),
    };
  }

  async get(id: string): Promise<AdminAgent> {
    if (id.startsWith('plugin:')) {
      const config = await this.getConfig(id);
      if (config.source === 'local')
        throw new AgentError('AGENT_NOT_FOUND', 404);
      return config;
    }
    return getAgent(id) ?? this.getStored(id);
  }

  private async getStored(
    id: string,
    versionId?: string,
    publishedOnly = false,
  ): Promise<ManagedAgent> {
    const row = await this.record(id);
    if (publishedOnly && row.status !== 'published')
      throw new AgentError('AGENT_NOT_PUBLISHED', 409);
    const version = versionId
      ? await this.store.getVersion(versionId)
      : await this.store.getLatestVersion(id);
    if (!version || version.agentId !== id)
      throw new AgentError('AGENT_CONFIG_UNSUPPORTED', 409);
    return this.view(row, version);
  }

  async list(
    status?: StorageAgentType['status'],
    userId?: string,
  ): Promise<AdminAgent[]> {
    const pages = await Promise.all(
      (status ? [status] : (['draft', 'published', 'archived'] as const)).map(
        (status) => this.store.list({ perPage: false, metadata, status }),
      ),
    );
    const agents = pages
      .flatMap((page) => page.agents)
      .filter(
        (agent) => !getCodeAgent(agent.id) && !agent.id.startsWith('plugin:'),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    return [
      ...structuredClone(
        Object.values(agentRegistry).filter((agent) => !agent.hidden),
      ),
      ...((await this.plugins?.agents(userId)) ?? []).filter(
        (agent) => !agent.hidden,
      ),
      ...(await Promise.all(agents.map((agent) => this.getStored(agent.id)))),
    ];
  }

  async getDefaults(): Promise<AgentDefaults> {
    const saved = await this.settings?.read();
    if (saved) {
      try {
        await this.getConfig(saved.defaultAgentId);
        return saved;
      } catch (error) {
        if (
          !(error instanceof AgentError) ||
          !['AGENT_NOT_FOUND', 'AGENT_NOT_PUBLISHED'].includes(error.code)
        )
          throw error;
      }
    }
    return { defaultAgentId: fallbackAgentId };
  }

  setDefaults(input: AgentDefaults) {
    return this.exclusive(async () => {
      const value = agentDefaultsSchema.parse(input);
      await this.getConfig(value.defaultAgentId);
      if (!this.settings)
        throw new AgentError('AGENT_SETTINGS_UNAVAILABLE', 503);
      await this.settings.write(value);
      return value;
    });
  }

  /** Code IDs take precedence; consult storage only when the code registry has no match. */
  async getConfig(
    id?: string | null,
    versionId?: string,
    context?: AgentScopeContext,
  ): Promise<RuntimeAgent> {
    const selectedId = id ?? (await this.getDefaults()).defaultAgentId;
    if (selectedId.startsWith('local:')) {
      if (!context || !this.local) throw new AgentError('AGENT_NOT_FOUND', 404);
      return this.local.resolve(selectedId, context);
    }
    if (selectedId.startsWith('plugin:')) {
      const plugin = ((await this.plugins?.agents(context?.userId)) ?? []).find(
        (agent) => agent.id === selectedId && !agent.hidden,
      );
      if (!plugin) {
        if (!id) return this.getConfig(fallbackAgentId, undefined, context);
        throw new AgentError('AGENT_NOT_FOUND', 404);
      }
      return plugin;
    }
    return getAgent(selectedId) ?? this.getStored(selectedId, versionId, true);
  }

  /** Construct an executable Mastra Agent with caller-owned runtime dependencies. */
  async getAgent(
    id: string | null | undefined,
    options: AgentRuntimeOptions,
    context?: AgentScopeContext,
  ) {
    const config = await this.getConfig(id, options.versionId, context);
    const children = new Map(
      await Promise.all(
        [
          ...new Set(
            options.allowSubagents === false
              ? []
              : Object.values(config.agents),
          ),
        ].map(
          async (reference) =>
            [
              reference,
              reference === config.id
                ? config
                : await this.getSubagent(reference, context),
            ] as const,
        ),
      ),
    );
    return buildAgent(config, {
      ...options,
      resolveSubagent: (reference) => children.get(reference),
    });
  }

  private async getSubagent(reference: string, context?: AgentScopeContext) {
    try {
      return await this.getConfig(reference, undefined, context);
    } catch (error) {
      if (
        error instanceof AgentError &&
        ['AGENT_NOT_FOUND', 'AGENT_NOT_PUBLISHED'].includes(error.code)
      )
        throw new AgentError('AGENT_SUBAGENT_UNAVAILABLE', 409);
      throw error;
    }
  }

  private async validateSubagents(
    agents: Record<string, string>,
    ownId?: string,
  ) {
    await Promise.all(
      [...new Set(Object.values(agents))]
        .filter((reference) => reference !== ownId)
        .map((reference) => this.getSubagent(reference)),
    );
  }

  async available(
    context?: AgentScopeContext,
    includeLocal = true,
  ): Promise<AvailableAgents> {
    const [agents, defaults, local] = await Promise.all([
      this.list('published', context?.userId),
      this.getDefaults(),
      context && includeLocal ? (this.local?.available(context) ?? []) : [],
    ]);
    return {
      ...defaults,
      defaultAgentId: agents.some(
        (agent) => agent.id === defaults.defaultAgentId,
      )
        ? defaults.defaultAgentId
        : fallbackAgentId,
      agents: [
        ...agents
          .filter(
            (agent) => agent.source === 'code' || agent.status === 'published',
          )
          .map(({ id, name, description, model, source }) => ({
            id,
            name,
            description,
            model,
            source,
          })),
        ...local.map(({ id, name, description, model, source }) => ({
          id,
          name,
          description,
          model,
          source,
        })),
      ],
    };
  }

  private async snapshot(
    input: AgentInput,
    ownId?: string,
  ): Promise<StorageAgentSnapshotType> {
    const data = agentInputSchema.parse(input);
    const [catalog, model] = await Promise.all([
      this.catalog(),
      this.modelConfig(data.model),
    ]);
    if (
      data.skillsMode === 'custom' &&
      data.skillPaths.some(
        (path) => !catalog.skills.some((skill) => skill.path === path),
      )
    )
      throw new AgentError('AGENT_SKILL_UNAVAILABLE');
    await this.validateSubagents(data.agents, ownId);
    return {
      name: data.name,
      description: data.description,
      instructions: data.instructions,
      model,
      tools: Object.fromEntries(data.tools.map((id) => [id, {}])),
      workspace: {
        type: 'provider',
        provider: skillProvider,
        // Keep application runtime settings in the same native version snapshot.
        config: {
          skillsMode: data.skillsMode,
          skillPaths: data.skillsMode === 'custom' ? data.skillPaths : [],
          disabledTools: data.disabledTools,
          // Keep delegation aliases and target IDs together in the versioned config.
          agents: Object.fromEntries(
            Object.entries(data.agents).map(([name, reference]) => [
              name,
              getAgent(reference)?.id ?? reference,
            ]),
          ),
        },
      },
    };
  }

  private async modelConfig(
    reference: string | null,
  ): Promise<StorageAgentSnapshotType['model']> {
    // Native storage accepts conditional model arrays. No variants means this
    // draft has no fixed model; chat integration must resolve one before running.
    if (reference === null) return [];
    const available = await this.providers.listAvailableModels();
    const slash = reference.indexOf('/');
    const providerId = reference.slice(0, slash);
    const name = reference.slice(slash + 1);
    const provider = available.providers.find(
      (item) => item.id === providerId && item.enabled,
    );
    if (
      !provider?.models.some(
        (model) =>
          model.id === name &&
          model.enabled &&
          model.modalitiesOutput.includes('text'),
      )
    )
      throw new AgentError('AGENT_MODEL_UNAVAILABLE');
    // Reference only: provider credentials remain in provider administration.
    return { provider: provider.type, name, providerId };
  }

  create(authorId: string, input: AgentInput) {
    return this.exclusive(async () => {
      const snapshot = await this.snapshot(input);
      // Code IDs are reserved even if a future built-in uses a UUID.
      // The strict input schema also rejects client-supplied IDs.
      let id = randomUUID();
      while (getCodeAgent(id)) id = randomUUID();
      const row = await this.store.create({
        agent: { id, authorId, metadata, ...snapshot },
      });
      return this.getStored(row.id);
    });
  }

  update(id: string, input: AgentUpdate) {
    return this.exclusive(async () => {
      const data = agentUpdateSchema.parse(input);
      const current = await this.getStored(id);
      if (current.versionId !== data.versionId)
        throw new AgentError('AGENT_CONFLICT', 409);
      const configuration = {
        name: data.name,
        description: data.description,
        instructions: data.instructions,
        model: data.model,
        tools: data.tools,
        disabledTools: data.disabledTools,
        skillsMode: data.skillsMode,
        skillPaths: data.skillPaths,
        agents: data.agents,
      };
      const snapshot = await this.snapshot(configuration, id);
      const version = await this.store.createVersion({
        ...snapshot,
        id: randomUUID(),
        agentId: id,
        versionNumber: current.versionNumber + 1,
        changedFields: Object.keys(snapshot),
        changeMessage: 'Updated in administration',
      });
      // Editing a published agent keeps it published and activates the saved configuration.
      if (current.status === 'published')
        await this.store.update({ id, activeVersionId: version.id });
      return this.getStored(id);
    });
  }

  setStatus(id: string, input: AgentStatusInput) {
    return this.exclusive(async () => {
      const data = agentStatusSchema.parse(input);
      const current = await this.getStored(id);
      if (current.versionId !== data.versionId)
        throw new AgentError('AGENT_CONFLICT', 409);
      if (
        data.status === 'draft' &&
        (await this.getDefaults()).defaultAgentId === id
      )
        throw new AgentError('AGENT_IS_DEFAULT', 409);
      if (data.status === 'published')
        await this.validateSubagents(current.agents, id);
      await this.store.update({
        id,
        status: data.status,
        ...(data.status === 'published'
          ? { activeVersionId: current.versionId }
          : {}),
      });
      return this.getStored(id);
    });
  }

  remove(id: string, versionId: string) {
    return this.exclusive(async () => {
      const current = await this.getStored(id);
      if (current.versionId !== versionId)
        throw new AgentError('AGENT_CONFLICT', 409);
      if ((await this.getDefaults()).defaultAgentId === id)
        throw new AgentError('AGENT_IS_DEFAULT', 409);
      await this.store.delete(id);
    });
  }

  /** The application runs one server; serialize version checks and mutations. */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action);
    this.mutations = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
