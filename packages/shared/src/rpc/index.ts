import { groupChatsContract, usersContract } from './group-chats.js';
import { knowledgeContract } from './knowledge.js';
import { usageContract } from './usage.js';
import { threadsContract } from './threads.js';
import { projectsContract } from './projects.js';
import { providersContract } from './providers.js';
import { skillsContract, personalSkillsContract } from './skills.js';
import { filesContract } from './files.js';
import { environmentVariablesContract } from './environment-variables.js';
import { requestLogsContract } from './request-logs.js';
import { toolsContract } from './tools.js';
import { agentsContract } from './agents.js';
import { mcpContract } from './mcp.js';
import { automationsContract } from './automations.js';
import { notificationsContract } from './notifications.js';
import { assetsContract } from './assets.js';
import { systemSettingsContract } from './system-settings.js';

export const apiContract = {
  groupChats: groupChatsContract,
  users: usersContract,
  knowledge: knowledgeContract,
  usage: usageContract,
  threads: threadsContract,
  projects: projectsContract,
  providers: providersContract,
  skills: skillsContract,
  personalSkills: personalSkillsContract,
  files: filesContract,
  environmentVariables: environmentVariablesContract,
  requestLogs: requestLogsContract,
  tools: toolsContract,
  agents: agentsContract,
  mcp: mcpContract,
  automations: automationsContract,
  notifications: notificationsContract,
  assets: assetsContract,
  systemSettings: systemSettingsContract,
};
