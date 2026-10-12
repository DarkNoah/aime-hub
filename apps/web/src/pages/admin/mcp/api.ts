import { ZodError } from 'zod';
import type { TFunction } from 'i18next';
import { apiErrorCode } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';
import { McpFormError } from './config';

const errorKeys = {
  MCP_NOT_FOUND: 'mcp.notFound',
  MCP_NAME_CONFLICT: 'mcp.duplicateName',
  MCP_TOOL_NAME_CONFLICT: 'mcp.toolNameConflict',
  MCP_CONFLICT: 'mcp.conflict',
  MCP_NOT_PUBLISHED: 'mcp.notPublished',
  MCP_CONFIG_INVALID: 'mcp.configInvalid',
  MCP_IMPORT_INCOMPLETE: 'mcp.importIncomplete',
  MCP_CONNECTION_FAILED: 'mcp.connectionFailed',
  MCP_UNAVAILABLE: 'mcp.unavailable',
  VALIDATION_ERROR: 'mcp.configInvalid',
  UNAUTHORIZED: 'errors.sessionExpired',
  FORBIDDEN: 'errors.forbidden',
} as const satisfies Record<string, TranslationKey>;

export function mcpErrorKey(error: unknown): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  const code = apiErrorCode(error);
  return code && Object.hasOwn(errorKeys, code)
    ? errorKeys[code as keyof typeof errorKeys]
    : 'errors.generic';
}

export function mcpFormError(error: unknown, t: TFunction): string {
  if (error instanceof McpFormError)
    return t(error.code, { field: error.field ?? '', line: error.line ?? 0 });
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const known = {
      'mcp.transportInvalid': 'mcp.transportInvalid',
      'mcp.argsHttpInvalid': 'mcp.argsHttpInvalid',
      'mcp.envHttpInvalid': 'mcp.envHttpInvalid',
      'mcp.headersStdioInvalid': 'mcp.headersStdioInvalid',
      'mcp.duplicateKey': 'mcp.duplicateKey',
      'mcp.duplicateName': 'mcp.duplicateName',
    } as const;
    const field = issue.path.at(-1);
    const message =
      known[issue.message as keyof typeof known] ??
      (field === 'name' ? 'mcp.nameHint' : 'mcp.configInvalid');
    return `${issue.path.join('.')}: ${t(message, { field: String(field ?? ''), line: 0 })}`;
  }
  return t(mcpErrorKey(error));
}
