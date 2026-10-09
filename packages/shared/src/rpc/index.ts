import { threadsContract } from './threads.js';
import { projectsContract } from './projects.js';
import { providersContract } from './providers.js';
import { skillsContract } from './skills.js';
import { filesContract } from './files.js';
import { environmentVariablesContract } from './environment-variables.js';
import { requestLogsContract } from './request-logs.js';
import { toolsContract } from './tools.js';

export const apiContract = {
  threads: threadsContract,
  projects: projectsContract,
  providers: providersContract,
  skills: skillsContract,
  files: filesContract,
  environmentVariables: environmentVariablesContract,
  requestLogs: requestLogsContract,
  tools: toolsContract,
};
