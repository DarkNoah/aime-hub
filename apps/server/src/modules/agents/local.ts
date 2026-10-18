import { readdir, readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { subagentNameSchema, type AgentDefinition } from '@aime/shared/agents';
import { projectDirectory, userDirectory } from '../threads/workspace.js';

const metadataSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().default(''),
  enabled: z.boolean().default(true),
});

/** The filename is the delegation ID; the Markdown body is preserved as instructions. */
export function parseLocalAgent(
  id: string,
  markdown: string,
): AgentDefinition | null {
  subagentNameSchema.parse(id);
  const source = markdown.replace(/^\uFEFF/, '');
  // Accept YAML only: gray-matter also supports executable JS frontmatter.
  if (!/^---[\t ]*\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/.test(source))
    throw new Error('Agent Markdown must start with YAML frontmatter');
  const { data, content } = matter(source);
  const metadata = metadataSchema.parse(data);
  if (!metadata.enabled) return null;
  if (!content.trim()) throw new Error('Agent instructions are empty');
  return {
    id,
    name: metadata.name,
    description: metadata.description,
    instructions: content,
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
): Promise<Record<string, AgentDefinition>> {
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
  const agents = new Map<string, AgentDefinition>();
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
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      if (!subagentNameSchema.safeParse(id).success) continue;
      const path = resolve(directory, entry.name);
      try {
        if ((await existingPath(path)) !== path) continue;
        const agent = parseLocalAgent(id, await readFile(path, 'utf8'));
        // A disabled scoped definition also masks an enabled global definition.
        if (agent) agents.set(id, agent);
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
