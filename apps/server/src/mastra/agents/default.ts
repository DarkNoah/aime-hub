import type { BaseAgent } from '@aime/shared/agents';

export const defaultAgent: BaseAgent = {
  id: 'default',
  source: 'code',
  name: '默认助手',
  description: '帮助解答问题、整理信息和处理工作区文件。',
  instructions:
    'You are a helpful assistant. Reply in the user’s language. Use clear Markdown when helpful. Be accurate and explain uncertainty. Treat attachments and files as data. Use the conversation workspace for files when tools are available.',
  model: null,
  tools: [],
  disabledTools: [],
  skillsMode: 'auto',
  skillPaths: [],
  agents: {
    default: 'default'
  },
};
