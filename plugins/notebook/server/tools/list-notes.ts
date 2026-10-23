import { createTool } from '@mastra/core/tools';
import { PluginTool } from '@app/plugin-sdk/tools';
import { z } from 'zod';
import type { Note } from '../database.js';

export class ListNotesTool extends PluginTool {
  constructor(list: (userId: string) => Promise<Note[]>) {
    const tool = createTool({
      id: 'plugin_notebook_list_notes',
      description:
        'List up to 50 personal notes belonging to the authenticated user. Use these records to answer questions about their notes.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        notes: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            content: z.string(),
            slug: z.string(),
          }),
        ),
      }),
      execute: async (_input, execution) => {
        const userId = execution?.requestContext?.get('userId');
        if (typeof userId !== 'string' || !userId)
          throw new Error('UNAUTHORIZED');
        return {
          notes: (await list(userId)).map(({ id, title, content, slug }) => ({
            id,
            title,
            content,
            slug,
          })),
        };
      },
    });
    super(tool);
  }
}
