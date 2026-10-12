import { z } from 'zod';
import { nanoid } from 'nanoid';
import {
  mcpConfigSchema,
  mcpCreateSchema,
  mcpNameSchema,
  type McpInput,
} from '@aime/shared/mcp';

export type McpForm = {
  key: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  headers: string;
  env: string;
};

export class McpFormError extends Error {
  constructor(
    public readonly code:
      | 'mcp.keyValueInvalid'
      | 'mcp.duplicateKey'
      | 'mcp.jsonInvalid'
      | 'mcp.singleServer'
      | 'mcp.duplicateName',
    public readonly field?: string,
    public readonly line?: number,
  ) {
    super(code);
  }
}

export function parseKeyValues(
  text: string,
  field: string,
): Record<string, string> {
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const equals = line.indexOf('=');
    const key = line.slice(0, equals).trim();
    if (equals < 1 || !key)
      throw new McpFormError('mcp.keyValueInvalid', field, index + 1);
    const identity = field === 'headers' ? key.toLowerCase() : key;
    if (seen.has(identity))
      throw new McpFormError('mcp.duplicateKey', field, index + 1);
    seen.add(identity);
    entries.push([key, line.slice(equals + 1)]);
  });
  return Object.fromEntries(entries);
}

export function formToInput(form: McpForm): McpInput {
  const headers =
    form.transport === 'http' ? parseKeyValues(form.headers, 'headers') : {};
  const env = form.transport === 'stdio' ? parseKeyValues(form.env, 'env') : {};
  return {
    name: form.name.trim(),
    config: {
      ...(form.transport === 'stdio'
        ? {
            command: form.command.trim(),
            args: form.args
              .split(/\r?\n/)
              .filter((arg) => arg.trim().length > 0),
          }
        : { url: form.url.trim() }),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    },
  };
}

export function inputToForm(input?: McpInput): McpForm {
  const config = input?.config;
  const pairs = (values?: Record<string, string>) =>
    Object.entries(values ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  return {
    key: nanoid(),
    name: input?.name ?? '',
    transport: config?.url ? 'http' : 'stdio',
    command: config?.command ?? '',
    args: config?.args?.join('\n') ?? '',
    url: config?.url ?? '',
    headers: pairs(config?.headers),
    env: pairs(config?.env),
  };
}

const jsonSchema = z.strictObject({
  mcpServers: z.record(mcpNameSchema, mcpConfigSchema),
});
export function parseMcpJson(text: string, editing = false): McpInput[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new McpFormError('mcp.jsonInvalid');
  }
  const parsed = jsonSchema.parse(value);
  const servers = Object.entries(parsed.mcpServers).map(([name, config]) => ({
    name,
    config,
  }));
  if (editing && servers.length !== 1)
    throw new McpFormError('mcp.singleServer');
  return mcpCreateSchema.parse({ servers }).servers;
}

export function serializeMcpJson(servers: McpInput[]): string {
  const names = servers.map((server) => server.name);
  if (new Set(names).size !== names.length)
    throw new McpFormError('mcp.duplicateName');
  return JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        servers.map(({ name, config }) => [name, config]),
      ),
    },
    null,
    2,
  );
}
