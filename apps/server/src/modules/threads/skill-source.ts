import { basename, resolve } from 'node:path';
import { LocalSkillSource } from '@mastra/core/workspace';
import { validateSkillContent } from '@mastra/core/skills';

/** Normalize skill identity on read; never rewrite the user's manifest. */
class DirectorySkillSource extends LocalSkillSource {
  private readonly names: Map<string, string>;

  constructor(paths: string[]) {
    super();
    this.names = new Map(
      paths.map((path) => [resolve(path, 'SKILL.md'), basename(path)]),
    );
  }

  override async readFile(path: string): Promise<string | Buffer> {
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

export function directorySkillConfig(paths: string[]) {
  return {
    skills: paths,
    skillSource: new DirectorySkillSource(paths),
  };
}
