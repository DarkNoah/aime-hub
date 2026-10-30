import { assertPluginSkillReadable } from '../plugins/skill-access.js';
import { basename, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  LocalSkillSource,
  Workspace,
  type SkillsResolver,
  type SkillsContext,
  type WorkspaceSkills,
  type WorkspaceFilesystem,
  type WorkspaceSandbox,
  type WorkspaceConfig,
} from '@mastra/core/workspace';
import { validateSkillContent } from '@mastra/core/skills';

const skillReader = new AsyncLocalStorage<{ userId?: string }>();
const namedSkillReads = new Set<PropertyKey>([
  'get',
  'has',
  'getReference',
  'getScript',
  'getAsset',
  'listReferences',
  'listScripts',
  'listAssets',
]);

/** Keep the native skill cache while binding I/O checks to each request's author. */
function scopedSkills(
  skills: WorkspaceSkills,
  userId?: string,
): WorkspaceSkills {
  return new Proxy(skills, {
    get(target, property) {
      if (property === 'getScoped')
        return async (context?: SkillsContext) => {
          const author = context?.requestContext?.get('userId');
          const reader = typeof author === 'string' ? author : userId;
          return skillReader.run({ userId: reader }, async () =>
            scopedSkills((await target.getScoped?.(context)) ?? target, reader),
          );
        };
      const value = Reflect.get(target, property, target);
      if (namedSkillReads.has(property))
        return (...args: unknown[]) =>
          skillReader.run({ userId }, async () => {
            const skill = await target.get(String(args[0]));
            // Cached skill contents must also respect grants revoked after discovery.
            if (skill) await assertPluginSkillReadable(skill.path, userId);
            return Reflect.apply(value, target, args);
          });
      if (property === 'list' || property === 'search')
        return (...args: unknown[]) =>
          skillReader.run({ userId }, async () => {
            const entries = (await Reflect.apply(
              value,
              target,
              args,
            )) as Array<{ path?: string; skillPath?: string }>;
            const visible = await Promise.all(
              entries.map(async (entry) => {
                try {
                  await assertPluginSkillReadable(
                    (entry.path ?? entry.skillPath)!,
                    userId,
                  );
                  return true;
                } catch (error) {
                  if (
                    error instanceof Error &&
                    error.message === 'PLUGIN_DISABLED'
                  )
                    return false;
                  throw error;
                }
              }),
            );
            return entries.filter((_, index) => visible[index]);
          });
      return typeof value === 'function'
        ? (...args: unknown[]) =>
            skillReader.run({ userId }, () =>
              Reflect.apply(value, target, args),
            )
        : value;
    },
  });
}

export class ScopedSkillsWorkspace<
  F extends WorkspaceFilesystem | undefined = undefined,
  S extends WorkspaceSandbox | undefined = undefined,
> extends Workspace<F, S> {
  private readerSkills?: WorkspaceSkills;
  constructor(
    config: WorkspaceConfig<F, S>,
    private readonly skillUserId?: string,
  ) {
    super(config);
  }
  override get skills() {
    const skills = super.skills;
    return skills
      ? (this.readerSkills ??= scopedSkills(skills, this.skillUserId))
      : undefined;
  }
}

/** Normalize skill identity on read; never rewrite the user's manifest. */
class DirectorySkillSource extends LocalSkillSource {
  private readonly names = new Map<string, string>();

  constructor(
    paths: string[],
    private readonly userId?: string,
  ) {
    super();
    this.registerPaths(paths);
  }

  registerPaths(paths: string[]) {
    for (const path of paths)
      this.names.set(resolve(path, 'SKILL.md'), basename(path));
  }

  override async readFile(path: string): Promise<string | Buffer> {
    await assertPluginSkillReadable(
      path,
      skillReader.getStore()?.userId ?? this.userId,
    );
    const content = await super.readFile(path);
    const name = this.names.get(resolve(path));
    // Reference files (even references/SKILL.md) are returned unchanged.
    if (!name) return content;
    const parsed = validateSkillContent({ content: content.toString() });
    if (!parsed.metadata || parsed.metadata.name === name) return content;
    // JSON is valid YAML. The runtime still validates all remaining metadata.
    return `---\n${JSON.stringify({ ...parsed.metadata, name })}\n---\n${parsed.instructions ?? ''}`;
  }
}

export function directorySkillConfig(paths: SkillsResolver, userId?: string) {
  const source = new DirectorySkillSource(
    Array.isArray(paths) ? paths : [],
    userId,
  );
  return {
    skills:
      typeof paths === 'function'
        ? async (context: Parameters<Exclude<SkillsResolver, string[]>>[0]) => {
            const resolved = await paths(context);
            source.registerPaths(resolved);
            return resolved;
          }
        : paths,
    skillSource: source,
  };
}
