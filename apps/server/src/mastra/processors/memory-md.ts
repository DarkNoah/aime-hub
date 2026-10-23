import { FileNotFoundError, LocalFilesystem } from '@mastra/core/workspace';
import { MessageInjectionProcessor } from './message-injection.js';

/** Personal or project memory supplied as user context before the conversation. */
export class MemoryMDProcessor extends MessageInjectionProcessor {
  constructor(directory: string) {
    const filesystem = new LocalFilesystem({
      basePath: directory,
      contained: true,
      readOnly: true,
    });
    super('memory-md', async () => {
      const memory = await filesystem
        .readFile('MEMORY.md', { encoding: 'utf-8' })
        .then((content) => content.toString())
        .catch((error: unknown) => {
          if (error instanceof FileNotFoundError) return '';
          throw error;
        });
      if (!memory.trim()) return [];
      return [
        {
          role: 'user',
          content: [{ type: 'text', text: `<memory>\n${memory}\n</memory>` }],
        },
      ];
    });
  }
}
