// Export tool instances here. Their own IDs register them in settings and every Agent.
export { sleep } from './sleep.js';
export { exec } from './exec.js';
export { currTime } from './clock.js';
export { webSearch } from './web_search.js';
export { webFetch } from './web_fetch.js';
export { imageGen } from './image_gen.js';
export { speech } from './speech.js';
export {
  askUserTool,
  taskWriteTool,
  taskUpdateTool,
  taskCompleteTool,
  taskCheckTool,
  submitPlanTool,
} from '@mastra/core/tools';
