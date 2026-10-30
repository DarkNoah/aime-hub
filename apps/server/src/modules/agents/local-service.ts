import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  lstat,
  link,
  unlink,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import {
  localAgentNameSchema,
  localAgentScopeSchema,
  type LocalAgentScope,
  type LocalAgentDocument,
  type LocalAgentFile,
  type LocalAgentList,
  type LocalAgentIssue,
  type LocalAgentCreateResult,
  type AgentScopeContext,
  type LocalRuntimeAgent,
} from '@aime/shared/agents';
import type { ProjectService } from '../projects/service.js';
import { requireProjectManager } from '../projects/permissions.js';
import { projectDirectory, userDirectory } from '../threads/workspace.js';
import { AgentError } from './errors.js';
import {
  loadLocalAgents,
  parseLocalAgent,
  parseLocalAgentDocument,
} from './local.js';

const metadataSchema = z.object({
  name: localAgentNameSchema,
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1),
  enabled: z.boolean(),
});
type Actor = { userId: string; isAdmin: boolean };
const version = (content: string) =>
  createHash('sha256').update(content).digest('hex');

export function validateLocalAgentDocument(input: LocalAgentDocument) {
  let parsed: ReturnType<typeof parseLocalAgentDocument>;
  try {
    parsed = parseLocalAgentDocument(input.content);
  } catch {
    return { ok: false as const, issues: ['syntax'] as LocalAgentIssue[] };
  }
  const metadata = metadataSchema.safeParse(parsed.data);
  const issues: LocalAgentIssue[] = metadata.success
    ? []
    : metadata.error.issues.map((issue) => issue.path[0] as LocalAgentIssue);
  if (typeof parsed.content !== 'string' || !parsed.content.trim())
    issues.push('instructions');
  if (!metadata.success || issues.length) return { ok: false as const, issues };
  return {
    ok: true as const,
    metadata: metadata.data,
    instructions: parsed.content as string,
  };
}

/** File-backed subagents are separate from published database Agents. */
export class LocalAgentService {
  private pending = new Map<string, Promise<unknown>>();

  constructor(
    private root: string,
    private projects?: Pick<ProjectService, 'assertMember'>,
  ) {}

  private async access(actor: Actor, target: LocalAgentScope, write = false) {
    const scope = localAgentScopeSchema.parse(target);
    if (scope.scope === 'global') {
      if (!actor.isAdmin) throw new AgentError('FORBIDDEN', 403);
      return {
        directory: resolve(this.root, '.agents', 'agents'),
        canManage: true,
      };
    }
    if (scope.scope === 'personal')
      return {
        directory: resolve(
          userDirectory(this.root, actor.userId),
          '.agents',
          'agents',
        ),
        canManage: true,
      };
    if (!this.projects) throw new AgentError('NOT_IMPLEMENTED', 503);
    const { role } = await this.projects.assertMember(
      actor.userId,
      scope.projectId,
    );
    if (write) requireProjectManager(role);
    return {
      directory: resolve(
        projectDirectory(this.root, scope.projectId),
        '.agents',
        'agents',
      ),
      canManage: role !== 'member',
    };
  }

  private async directory(
    path: string,
    create: boolean,
  ): Promise<string | null> {
    if (create) await mkdir(this.root, { recursive: true });
    let current: string;
    try {
      current = await realpath(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    for (const part of relative(resolve(this.root), path).split('/')) {
      current = join(current, part);
      if (create) {
        try {
          await mkdir(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      try {
        if (
          (await realpath(current)) !== current ||
          !(await lstat(current)).isDirectory()
        )
          throw new AgentError('LOCAL_AGENT_PATH_UNAVAILABLE', 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }
    return current;
  }

  private file(filename: string, content: string): LocalAgentFile {
    const { data } = parseLocalAgentDocument(content);
    const metadata = metadataSchema
      .extend({
        name: z.string().trim().min(1),
        displayName: z.string().trim().min(1).optional(),
        description: z.string().default(''),
        enabled: z.boolean().default(true),
      })
      .parse(data);
    return {
      ...metadata,
      displayName: metadata.displayName ?? metadata.name,
      name: localAgentNameSchema.safeParse(metadata.name).success
        ? metadata.name
        : filename.slice(0, -3),
      id: filename.slice(0, -3),
      filename,
      format: 'md',
      content,
      version: version(content),
    };
  }

  private async read(directory: string, filename: string) {
    if (!/^[a-zA-Z0-9_:-]{1,58}\.md$/.test(filename))
      throw new AgentError('VALIDATION_ERROR');
    const file = await open(
      join(directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!(await file.stat()).isFile())
        throw new AgentError('LOCAL_AGENT_PATH_UNAVAILABLE', 409);
      return this.file(filename, await file.readFile('utf8'));
    } finally {
      await file.close();
    }
  }

  private async exclusive<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.pending.set(key, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(key) === next) this.pending.delete(key);
    }
  }

  async list(actor: Actor, target: LocalAgentScope): Promise<LocalAgentList> {
    const access = await this.access(actor, target);
    const directory = await this.directory(access.directory, false);
    const agents: LocalAgentFile[] = [];
    if (directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!entry.isFile() || !/^[a-zA-Z0-9_:-]{1,58}\.md$/.test(entry.name))
          continue;
        try {
          agents.push(await this.read(directory, entry.name));
        } catch {
          console.warn(
            `Unable to read local Agent configuration: ${entry.name}`,
          );
        }
      }
    }
    return { agents, canManage: access.canManage };
  }

  async create(
    actor: Actor,
    target: LocalAgentScope,
    input: LocalAgentDocument,
  ): Promise<LocalAgentCreateResult> {
    const access = await this.access(actor, target, true);
    const parsed = validateLocalAgentDocument(input);
    if (!parsed.ok) return parsed;
    const id = parsed.metadata.name;
    return this.exclusive(access.directory, async () => {
      const directory = (await this.directory(access.directory, true))!;
      const filename = `${id}.md`;
      const content = matter.stringify(parsed.instructions, parsed.metadata);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(content, 'utf8');
        } finally {
          await file.close();
        }
        // Publish a complete file without overwriting a concurrent writer.
        await link(temporary, join(directory, filename));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new AgentError('LOCAL_AGENT_EXISTS', 409);
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
      return { ok: true, agent: this.file(filename, content) };
    });
  }

  async setEnabled(
    actor: Actor,
    target: LocalAgentScope,
    input: { filename: string; version: string; enabled: boolean },
  ) {
    const access = await this.access(actor, target, true);
    return this.exclusive(access.directory, async () => {
      const directory = await this.directory(access.directory, false);
      if (!directory) throw new AgentError('AGENT_NOT_FOUND', 404);
      const current = await this.readVersion(directory, input);
      const parsed = parseLocalAgentDocument(current.content);
      const data = { ...parsed.data, enabled: input.enabled };
      const content = matter.stringify(parsed.content, data);
      try {
        parseLocalAgent(current.id, content);
      } catch {
        throw new AgentError('VALIDATION_ERROR');
      }
      await this.replace(directory, input.filename, content);
      return this.file(input.filename, content);
    });
  }

  async update(
    actor: Actor,
    target: LocalAgentScope,
    input: LocalAgentDocument & { filename: string; version: string },
  ): Promise<LocalAgentCreateResult> {
    const access = await this.access(actor, target, true);
    const parsed = validateLocalAgentDocument(input);
    if (!parsed.ok) return parsed;
    return this.exclusive(access.directory, async () => {
      const directory = await this.directory(access.directory, false);
      if (!directory) throw new AgentError('AGENT_NOT_FOUND', 404);
      // The filename remains the stable delegation ID when the display name changes.
      await this.readVersion(directory, input);
      await this.replace(directory, input.filename, input.content);
      return { ok: true, agent: this.file(input.filename, input.content) };
    });
  }

  async remove(
    actor: Actor,
    target: LocalAgentScope,
    input: { filename: string; version: string },
  ): Promise<void> {
    const access = await this.access(actor, target, true);
    return this.exclusive(access.directory, async () => {
      const directory = await this.directory(access.directory, false);
      if (!directory) throw new AgentError('AGENT_NOT_FOUND', 404);
      await this.readVersion(directory, input);
      await unlink(join(directory, input.filename));
    });
  }

  private async readVersion(
    directory: string,
    input: { filename: string; version: string },
  ) {
    const current = await this.read(directory, input.filename).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          throw new AgentError('AGENT_NOT_FOUND', 404);
        throw error;
      },
    );
    if (current.version !== input.version)
      throw new AgentError('AGENT_CONFLICT', 409);
    return current;
  }

  private async replace(directory: string, filename: string, content: string) {
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(content, 'utf8');
      } finally {
        await file.close();
      }
      await rename(temporary, join(directory, filename));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async available(context: AgentScopeContext): Promise<LocalRuntimeAgent[]> {
    await this.access(
      { userId: context.userId, isAdmin: false },
      context.projectId
        ? { scope: 'project', projectId: context.projectId }
        : { scope: 'personal' },
    );
    return Object.values(
      await loadLocalAgents(this.root, context.userId, context.projectId),
    );
  }

  async resolve(id: string, context: AgentScopeContext) {
    const agent = (await this.available(context)).find(
      (agent) => agent.id === id,
    );
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', 404);
    return agent;
  }
}
