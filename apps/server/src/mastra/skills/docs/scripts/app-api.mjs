#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const methods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
]);
export const help = `Usage:
  node "$APP_API_SCRIPT" list [keyword]
  node "$APP_API_SCRIPT" describe <operationId>
  node "$APP_API_SCRIPT" call <operationId> [JSON | --file <path|->]

Operations and schemas are discovered from the running server's OpenAPI catalog.
Call input: {"params":{...},"query":{...},"body":{...}}; omit unused sections.
APP_API_SCRIPT, APP_API_URL and APP_API_TOKEN are injected by exec_command.
Example: node "$APP_API_SCRIPT" call projects.create '{"body":{"name":"Research"}}'`;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} 必须是 JSON 对象。`);
  return value;
}

// Match oRPC's bracket notation for JSON query values, including nested arrays.
function appendQuery(search, values, prefix = '') {
  for (const [key, value] of Object.entries(values)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === 'object')
      appendQuery(search, value, name);
    else if (['string', 'number', 'boolean'].includes(typeof value))
      search.append(name, String(value));
  }
}

export function createAppApi({
  env = process.env,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!env.APP_API_URL || !env.APP_API_TOKEN)
    throw new Error(
      '缺少应用认证环境。请在当前会话的 exec_command 中运行脚本。',
    );
  const base = new URL(env.APP_API_URL);
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    base.pathname.replace(/\/$/, '') !== '/api' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('APP_API_URL 必须是 http://127.0.0.1:<端口>/api。');

  async function request(method, path, { query, body } = {}) {
    if (!path.startsWith('/') || /[?#\\]/.test(path))
      throw new Error('接口路径不正确。');
    const url = new URL(`${base.origin}/api${path}`);
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/'))
      throw new Error('接口路径必须位于本机 /api 下。');
    if (query) appendQuery(url.searchParams, query);
    const timeout = AbortSignal.timeout(30_000);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${env.APP_API_TOKEN}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) throw new Error('用户中止了操作');
      throw new Error(
        '本机 API 请求失败或超时。写入结果可能未知，请先查询，不要自动重复创建或发送。',
      );
    }
    if (response.ok && (response.status === 204 || method === 'HEAD'))
      return null;
    let result;
    try {
      result = await response.json();
    } catch {
      if (signal?.aborted) throw new Error('用户中止了操作');
      throw new Error(
        `API 返回非 JSON 响应（HTTP ${response.status}）。请先查询写入结果。`,
      );
    }
    if (!response.ok) {
      const code =
        typeof result?.code === 'string' && /^[A-Z_]+$/.test(result.code)
          ? result.code
          : 'REQUEST_FAILED';
      const hint =
        response.status === 401
          ? '请通过新的 exec_command 调用获取新令牌，勿在旧终端中反复重试。'
          : response.status === 403
            ? '当前用户无权限或此令牌不支持该操作。'
            : '请通过 describe 查看最新参数并检查目标状态。';
      throw new Error(`HTTP ${response.status} ${code}。${hint}`);
    }
    return result;
  }

  // Only cache within this invocation; the next CLI run discovers the current contract.
  let discovery;
  async function discover() {
    discovery ??= request('GET', '/local-api/openapi.json').then((spec) => {
      if (!spec?.openapi || !spec.paths)
        throw new Error('服务端未返回有效的 OpenAPI 目录。');
      const operations = [];
      for (const [path, item] of Object.entries(spec.paths))
        for (const [method, definition] of Object.entries(item))
          if (methods.has(method) && definition.operationId)
            operations.push({
              path,
              method: method.toUpperCase(),
              ...definition,
              parameters: [
                ...(item.parameters ?? []),
                ...(definition.parameters ?? []),
              ],
            });
      return { spec, operations };
    });
    return discovery;
  }

  async function describe(operationId) {
    const { spec, operations } = await discover();
    const found = operations.find(
      (operation) => operation.operationId === operationId,
    );
    if (!found)
      throw new Error(
        `接口 ${operationId} 不存在或未开放给技能。请先 list 查询。`,
      );
    return { ...found, components: spec.components };
  }

  // Resolve local OpenAPI parameter/request-body references without network requests.
  function dereference(value, components) {
    const seen = new Set();
    while (value?.$ref) {
      const ref = value.$ref;
      if (!ref.startsWith('#/components/') || seen.has(ref))
        throw new Error('接口定义包含不支持的引用。');
      seen.add(ref);
      value = ref
        .slice('#/components/'.length)
        .split('/')
        .reduce(
          (current, key) =>
            current?.[key.replaceAll('~1', '/').replaceAll('~0', '~')],
          components,
        );
      if (!value) throw new Error('接口定义引用不存在。');
    }
    return value;
  }

  return {
    async list(keyword = '') {
      const { operations } = await discover();
      const filter = keyword.toLowerCase();
      return operations
        .filter((operation) =>
          `${operation.operationId} ${operation.summary ?? ''} ${operation.description ?? ''}`
            .toLowerCase()
            .includes(filter),
        )
        .map(({ operationId, summary, method, path }) => ({
          operationId,
          summary,
          method,
          path,
        }));
    },
    describe,
    async call(operationId, input = {}) {
      object(input, '参数');
      if (
        Object.keys(input).some(
          (key) => !['params', 'query', 'body'].includes(key),
        )
      )
        throw new Error(
          '使用 params、query、body 组织参数；先 describe 查看接口。',
        );
      const operation = await describe(operationId);
      const params = object(input.params ?? {}, 'params');
      const query = object(input.query ?? {}, 'query');
      const parameters = operation.parameters.map((value) =>
        dereference(value, operation.components),
      );
      for (const [group, values, location] of [
        ['params', params, 'path'],
        ['query', query, 'query'],
      ])
        for (const key of Object.keys(values))
          if (
            !parameters.some(
              (parameter) =>
                parameter.in === location && parameter.name === key,
            )
          )
            throw new Error(`未知 ${group}.${key}，请 describe 查看最新参数。`);
      for (const parameter of parameters) {
        if (!parameter.required) continue;
        const value =
          parameter.in === 'path'
            ? params[parameter.name]
            : parameter.in === 'query'
              ? query[parameter.name]
              : undefined;
        if (value === undefined || value === null)
          throw new Error(`缺少必填 ${parameter.in} 参数 ${parameter.name}。`);
      }
      const path = operation.path.replace(/\{([^}]+)\}/g, (_, key) => {
        const value = params[key];
        if (
          !['string', 'number', 'boolean'].includes(typeof value) ||
          value === '' ||
          value === '.' ||
          value === '..'
        )
          throw new Error(`路径参数 ${key} 格式不正确。`);
        return encodeURIComponent(String(value));
      });
      const bodyDefinition = dereference(
        operation.requestBody,
        operation.components,
      );
      if (bodyDefinition?.required && input.body === undefined)
        throw new Error('此接口需要 body，请 describe 查看结构。');
      if (
        input.body !== undefined &&
        (!bodyDefinition?.content?.['application/json'] ||
          ['GET', 'HEAD'].includes(operation.method))
      )
        throw new Error('此接口不接受 JSON body；此脚本仅支持 JSON API。');
      return request(operation.method, path, { query, body: input.body });
    },
  };
}

export async function callAppApi(operationId, input = {}, options = {}) {
  return createAppApi(options).call(operationId, input);
}

async function readInput(args) {
  let source;
  if (args[0] === '--file' && args.length === 2) {
    if (args[1] === '-') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      source = Buffer.concat(chunks).toString('utf8');
    } else source = await readFile(args[1], 'utf8');
  } else if (args.length <= 1) source = args[0] ?? '{}';
  else throw new Error('仅接受一个 JSON 参数，或 --file <path|->。');
  try {
    return JSON.parse(source);
  } catch {
    throw new Error('参数不是有效 JSON。');
  }
}

async function main() {
  const [command, target, ...args] = process.argv.slice(2);
  if (!command || command === '--help') return console.log(help);
  if (
    !['list', 'describe', 'call'].includes(command) ||
    (command !== 'list' && !target) ||
    (command !== 'call' && args.length)
  )
    throw new Error(
      '使用 list [关键词]、describe <operationId> 或 call <operationId> [JSON | --file <path|->]。',
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const client = createAppApi({ signal: controller.signal });
    const result =
      command === 'list'
        ? await client.list(target)
        : command === 'describe'
          ? await client.describe(target)
          : await client.call(target, await readInput(args));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
