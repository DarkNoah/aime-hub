import { existsSync } from 'node:fs';
import { release, type, userInfo } from 'node:os';
import { join } from 'node:path';

export function agentEnvironment(workspace: string, modelReference: string) {
  const modelId = modelReference.slice(modelReference.indexOf('/') + 1);
  const shell =
    process.platform === 'win32'
      ? 'cmd.exe'
      : (process.env.SHELL ?? userInfo().shell ?? '/bin/sh');

  return `# Environment
You have been invoked in the following environment:
 - Primary working directory: ${workspace || 'No working directory specified'}
${workspace ? ` - Is a git repository: ${existsSync(join(workspace, '.git'))}\n` : ''} - Platform: ${process.platform}
 - Shell: ${shell}
 - OS Version: ${type()} ${release()}
${modelId ? ` - You are powered by the model named ${modelId}.` : ''}`;
}
