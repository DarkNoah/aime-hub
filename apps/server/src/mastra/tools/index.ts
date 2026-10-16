// Export tool instances here. Their own IDs register them in settings and every Agent.
export { sleep } from './sleep.js';
export { exec } from './exec.js';
export { execCommand } from './exec_command.js';
export { writeStdin } from './write_stdin.js';
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

export { knowledgeSearch } from './knowledge_search.js';
import { createKnowledgeTools } from './knowledge.js';
export const {
  knowledge_list,
  knowledge_create,
  knowledge_get_document,
  knowledge_save_document,
  knowledge_archive_document,
} = createKnowledgeTools();
