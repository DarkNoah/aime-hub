import { assertPluginSkillReadable } from '../plugins/skill-access.js';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
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
  type Skill,
} from '@mastra/core/workspace';
import { validateSkillContent } from '@mastra/core/skills';
import { readSkillProject } from '../skills/project.js';

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
  source?: DirectorySkillSource,
): WorkspaceSkills {
  return new Proxy(skills, {
    get(target, property) {
      if (property === 'getScoped')
        return async (context?: SkillsContext) => {
          const author = context?.requestContext?.get('userId');
          const reader = typeof author === 'string' ? author : userId;
          return skillReader.run({ userId: reader }, async () =>
            scopedSkills(
              (await target.getScoped?.(context)) ?? target,
              reader,
              source,
            ),
          );
        };
      const value = Reflect.get(target, property, target);
      if (namedSkillReads.has(property))
        return (...args: unknown[]) =>
          skillReader.run({ userId }, async () => {
            const requested = String(args[0]);
            const lookup = source?.runtimePath(requested) ?? requested;
            let skill = await target.get(lookup);
            // The first read may initialize aliases through the async resolver.
            args[0] = source?.runtimePath(requested) ?? requested;
            if (args[0] !== lookup) skill = await target.get(String(args[0]));
            // Cached skill contents must also respect grants revoked after discovery.
            if (skill)
              await assertPluginSkillReadable(
                source?.actualPath(skill.path) ?? skill.path,
                userId,
              );
            const result =
              property === 'get'
                ? skill
                : await Reflect.apply(value, target, args);
            return property === 'get' && result && source
              ? { ...result, path: source.actualPath((result as Skill).path) }
              : result;
          });
      if (property === 'list' || property === 'search')
        return (...args: unknown[]) =>
          skillReader.run({ userId }, async () => {
            const entries = (await Reflect.apply(
              value,
              target,
              args,
            )) as Array<{ path?: string; skillPath?: string }>;
            if (source)
              for (let index = 0; index < entries.length; index++) {
                const entry = entries[index];
                entries[index] = {
                  ...entry,
                  ...(entry.path
                    ? { path: source.actualPath(entry.path) }
                    : {}),
                  ...(entry.skillPath
                    ? { skillPath: source.actualPath(entry.skillPath) }
                    : {}),
                };
              }
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
              Reflect.apply(
                value,
                target,
                property === 'registerLocationAlias' && source
                  ? [args[0], source.runtimePath(String(args[1]))]
                  : args,
              ),
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
    this.directorySource =
      config.skillSource instanceof DirectorySkillSource
        ? config.skillSource
        : undefined;
  }
  private readonly directorySource?: DirectorySkillSource;
  override get skills() {
    const skills = super.skills;
    return skills
      ? (this.readerSkills ??= scopedSkills(
          skills,
          this.skillUserId,
          this.directorySource,
        ))
      : undefined;
  }
}

/** Normalize skill identity on read; never rewrite the user's manifest. */
class DirectorySkillSource extends LocalSkillSource {
  private readonly names = new Map<string, string>();
  private readonly projects = new Map<
    string,
    { alias: string; root: string }
  >();

  constructor(
    paths: string[],
    private readonly userId?: string,
  ) {
    super();
    this.registerPaths(paths);
  }

  registerPaths(paths: string[]) {
    for (const path of paths)
      if (!this.projects.has(resolve(path)))
        this.names.set(resolve(path, 'SKILL.md'), basename(path));
  }

  async resolvePaths(paths: string[]) {
    this.registerPaths(paths);
    const projects = new Map<string, ReturnType<typeof readSkillProject>>();
    return Promise.all(
      paths.map(async (path) => {
        const directory = resolve(path);
        const marker = `${sep}.agents${sep}skills${sep}`;
        const offset = directory.indexOf(marker);
        if (offset < 0) return path;
        const parts = directory.slice(offset + marker.length).split(sep);
        // Archives live directly under the skill root; GitHub projects retain
        // owner/repo grouping. Never interpret metadata deeper in source files.
        for (const depth of [1, 2]) {
          if (parts.length < depth) break;
          const group = resolve(
            directory.slice(0, offset + marker.length),
            ...parts.slice(0, depth),
          );
          let pending = projects.get(group);
          if (!pending) {
            pending = readSkillProject(group, { legacy: depth === 2 });
            projects.set(group, pending);
          }
          const project = await pending;
          if (!project) continue;
          const root = resolve(group, project.root);
          const entry = project.entries.find(
            (entry) => dirname(resolve(root, entry.path)) === directory,
          );
          if (!entry) throw new Error('SKILL_PROJECT_ENTRY_UNAVAILABLE');
          // Mastra validates name against its discovery directory. An in-memory
          // alias keeps that identity stable without moving or rewriting the project.
          const alias = resolve(directory, '.skill-entry', entry.name);
          this.projects.set(directory, { alias, root });
          this.names.set(resolve(directory, 'SKILL.md'), entry.name);
          return alias;
        }
        return path;
      }),
    );
  }

  actualPath(path: string) {
    return this.mapPath(path, true);
  }

  runtimePath(path: string) {
    return this.mapPath(path, false);
  }

  private mapPath(path: string, actual: boolean) {
    if (!isAbsolute(path)) return path;
    for (const [directory, project] of this.projects) {
      const from = actual ? project.alias : directory;
      const suffix = relative(from, path);
      if (
        !suffix ||
        (!suffix.startsWith(`..${sep}`) &&
          suffix !== '..' &&
          !isAbsolute(suffix))
      )
        return resolve(actual ? directory : project.alias, suffix);
    }
    return path;
  }

  override exists(path: string) {
    return super.exists(this.actualPath(path));
  }
  override stat(path: string) {
    return super.stat(this.actualPath(path));
  }
  override readdir(path: string) {
    return super.readdir(this.actualPath(path));
  }
  override realpath(path: string) {
    return super.realpath(this.actualPath(path));
  }

  override async readFile(path: string): Promise<string | Buffer> {
    path = this.actualPath(path);
    await assertPluginSkillReadable(
      path,
      skillReader.getStore()?.userId ?? this.userId,
    );
    const content = await super.readFile(path);
    const name = this.names.get(resolve(path));
    // Reference files (even references/SKILL.md) are returned unchanged.
    if (!name) return content;
    const parsed = validateSkillContent({ content: content.toString() });
    const project = this.projects.get(dirname(resolve(path)));
    if (!parsed.metadata || (parsed.metadata.name === name && !project))
      return content;
    const context = project
      ? `## Installed project\n\nProject root: ${JSON.stringify(project.root)}\nSkill entry: ${JSON.stringify(resolve(path))}\nThe complete project source is already available here. Run any project setup commands from the project root when required by these instructions.\n\n`
      : '';
    // JSON is valid YAML. The runtime still validates all remaining metadata.
    return `---\n${JSON.stringify({ ...parsed.metadata, name })}\n---\n${context}${parsed.instructions ?? ''}`;
  }
}

export function directorySkillConfig(paths: SkillsResolver, userId?: string) {
  const source = new DirectorySkillSource(
    Array.isArray(paths) ? paths : [],
    userId,
  );
  return {
    skills: async (context: Parameters<Exclude<SkillsResolver, string[]>>[0]) =>
      source.resolvePaths(
        typeof paths === 'function' ? await paths(context) : paths,
      ),
    skillSource: source,
  };
}
