import { createSkillTools, createWorkspaceTools } from '@mastra/core/workspace';
import { BaseTool, toolArray } from './base.js';
import type {
  ToolDefaultConfigs,
  ToolDependencies,
  ToolRegistryOptions,
} from './types.js';

export class PluginTools extends BaseTool<ToolDependencies> {
  protected async createTools(
    config: ToolDefaultConfigs,
    dependencies: ToolDependencies,
    options: ToolRegistryOptions,
  ) {
    return toolArray(
      (await dependencies.pluginTools?.(config, dependencies, options)) ?? {},
    );
  }
}

export class McpTools extends BaseTool<ToolDependencies> {
  override readonly deferred = true;

  protected async createTools(
    _config: ToolDefaultConfigs,
    dependencies: ToolDependencies,
  ) {
    return toolArray((await dependencies.mcpTools?.()) ?? {});
  }
}

export class WorkspaceTools extends BaseTool<ToolDependencies> {
  override readonly deferred = true;

  protected async createTools(
    _config: ToolDefaultConfigs,
    dependencies: ToolDependencies,
  ) {
    const { workspace, requestContext } = dependencies.context ?? {};
    return workspace
      ? toolArray(
          await createWorkspaceTools(workspace, { workspace, requestContext }),
        )
      : [];
  }
}

export class BrowserTools extends BaseTool<ToolDependencies> {
  override readonly deferred = true;

  protected createTools(
    _config: ToolDefaultConfigs,
    dependencies: ToolDependencies,
  ) {
    return toolArray(dependencies.context?.browser?.getTools() ?? {});
  }
}

export class SkillTools extends BaseTool<ToolDependencies> {
  override readonly deferred = true;

  protected createTools(
    _config: ToolDefaultConfigs,
    dependencies: ToolDependencies,
  ) {
    const skills = dependencies.context?.workspace?.skills;
    return skills ? toolArray(createSkillTools(skills)) : [];
  }
}

export const toolSources: readonly BaseTool<ToolDependencies>[] = [
  new PluginTools(),
  new McpTools(),
  new WorkspaceTools(),
  new BrowserTools(),
  new SkillTools(),
];
