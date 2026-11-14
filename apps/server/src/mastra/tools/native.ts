import { BuiltinTool } from '../../modules/tools/base.js';
import type { RegisteredTool } from '../../modules/tools/types.js';

/** Adapt Mastra-owned tools while retaining their schemas, suspension and hooks. */
export class NativeTool extends BuiltinTool {
  override readonly forceRender: boolean;

  constructor(tool: RegisteredTool, options: { forceRender?: boolean } = {}) {
    super(tool);
    this.forceRender = options.forceRender ?? false;
  }

  protected override create() {
    return this.tool;
  }
}
