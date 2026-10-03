import { createTool } from '@mastra/core/tools';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import z from 'zod';

dayjs.extend(utc);

export const currTime = createTool({
  id: 'curr_time',
  description: 'Return the current time in UTC.',
  outputSchema: z.object({
    current_time: z.string(),
    local_time: z.string(),
  }),
  execute: async () => {
    return {
      current_time: dayjs().utc().format('YYYY-MM-DD HH:mm:ss [UTC]'),
      local_time: dayjs().format('YYYY-MM-DD HH:mm:ss Z'),
    };
  },
});
