import { readdir, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import {
  localAgentFileIdSchema,
  type LocalRuntimeAgent,
} from '@aime/shared/agents';
import { projectDirectory, userDirectory } from '../threads/workspace.js';

const metadataSchema = z.object({
  name: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
  description: z.string().trim().default(''),
  enabled: z.boolean().default(true),
});

export function parseLocalAgentDocument(document: string) {
  const source = document.replace(/^\uFEFF/, '');
  // Accept YAML only: gray-matter also supports executable JS frontmatter.
  if (!/^---[\t ]*\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/.test(source))
    throw new Error('Agent Markdown must start with YAML frontmatter');
  return matter(source);
}

/** The Markdown filename is the delegation ID. */
export function parseLocalAgent(
  id: string,
  document: string,
): LocalRuntimeAgent | null {
  localAgentFileIdSchema.parse(id);
  const { data, content } = parseLocalAgentDocument(document);
  const metadata = metadataSchema.parse(data);
  if (!metadata.enabled) return null;
  const instructions = z.string().parse(content);
  if (!instructions.trim()) throw new Error('Agent instructions are empty');
  return {
    id,
    name: metadata.displayName ?? metadata.name,
    source: 'local',
    versionId: createHash('sha256').update(document).digest('hex'),
    description: metadata.description,
    instructions,
    model: null,
    tools: [],
    disabledTools: [],
    skillsMode: 'auto',
    skillPaths: [],
    agents: {},
  };
}

async function existingPath(path: string) {
  return realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

/** Match skill scopes: global + personal, or global + project (never another user's files). */
export async function loadLocalAgents(
  root: string,
  userId: string,
  projectId?: string,
): Promise<Record<string, LocalRuntimeAgent>> {
  // Validate the caller's scope before filesystem access, even when root is absent.
  const directories = [
    resolve(root, '.agents', 'agents'),
    resolve(
      projectId
        ? projectDirectory(root, projectId)
        : userDirectory(root, userId),
      '.agents',
      'agents',
    ),
  ];
  const canonicalRoot = await existingPath(root);
  if (!canonicalRoot) return {};
  const agents = new Map<string, LocalRuntimeAgent>();
  for (const source of directories) {
    const directory = resolve(canonicalRoot, relative(resolve(root), source));
    // Do not follow a scope directory or ancestor redirected through a symlink.
    if ((await existingPath(directory)) !== directory) continue;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      if (!localAgentFileIdSchema.safeParse(id).success) continue;
      const path = resolve(directory, entry.name);
      try {
        if ((await existingPath(path)) !== path) continue;
        const agent = parseLocalAgent(id, await readFile(path, 'utf8'));
        // A disabled scoped definition also masks an enabled global definition.
        if (agent)
          agents.set(id, {
            ...agent,
            id:
              source === directories[0]
                ? `local:global:${id}`
                : projectId
                  ? `local:project:${projectId}:${id}`
                  : `local:personal:${id}`,
          });
        else agents.delete(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // A malformed optional definition must not prevent the chat from running.
        console.warn(`Unable to load local Agent configuration: ${path}`);
      }
    }
  }
  return Object.fromEntries(agents);
}
