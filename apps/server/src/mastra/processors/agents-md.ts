import type {
  Processor,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
} from '@mastra/core/processors';
import { FileNotFoundError, LocalFilesystem } from '@mastra/core/workspace';

export class AgentsMDProcessor implements Processor {
  readonly id = 'agents-md';
  private readonly filesystem: LocalFilesystem;

  constructor(directory: string) {
    // Use the command workspace root, including the root of composite mounts.
    // A separate contained reader avoids following AGENTS.md outside this workspace.
    this.filesystem = new LocalFilesystem({
      basePath: directory,
      contained: true,
      readOnly: true,
    });
  }

  async processLLMRequest({
    prompt,
  }: ProcessLLMRequestArgs): Promise<ProcessLLMRequestResult> {
    const agentsMd = await this.filesystem
      .readFile('AGENTS.md', { encoding: 'utf-8' })
      .then((content) => content.toString())
      .catch((error: unknown) => {
        if (error instanceof FileNotFoundError) return '';
        throw error;
      });
    if (!agentsMd.trim()) return;

    const context = `<system-reminder>
As you answer the user's questions, you can use the following context:
${agentsMd}

# currentDate
Today's date is ${new Date().toISOString().split('T')[0]}.

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>`;

    // Only change the outbound prompt; keep reminders out of saved messages.
    return { prompt: [{ role: 'system', content: context }, ...prompt] };
  }
}
