import { BuiltinTool } from '../../modules/tools/base.js';

/** Adapt Mastra-owned tools while retaining their schemas, suspension and hooks. */
export class NativeTool extends BuiltinTool {
  protected override create() {
    return this.tool;
  }
}
