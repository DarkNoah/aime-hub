import { automationToolResultSchema } from '@aime/shared/automations';

export function parseAutomationToolResult(output: unknown) {
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      return null;
    }
  }
  const parsed = automationToolResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}
