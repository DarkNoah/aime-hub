import { createHash } from 'node:crypto';
import { isToolUIPart, type UIMessage } from 'ai';
import type { ChatToolGroup } from '@aime/shared/chat-turns';
import { getMessageCompression } from '@aime/shared/message-compression';
import { partRevision } from './turn-revision.js';
import { inlineToolMedia } from './overview-media.js';

type Part = UIMessage['parts'][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

export type TurnProjectionOptions = {
  forceRender?: (toolName: string) => boolean;
  threadId?: string;
};

type ProjectionContext = TurnProjectionOptions & {
  turnId: string;
  cursor?: string;
};

// Compatibility for standalone consumers. Runtime callers use the registered
// tool definitions, whose forceRender property is the authoritative policy.
const historicalDisplayTools = new Set([
  'image_gen',
  'speech',
  'ask_user',
  'intelligent_ui',
  'request_authorization',
]);

export function toolName(part: ToolPart) {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pick(value: Record<string, unknown> | undefined, keys: string[]) {
  return Object.fromEntries(
    keys.flatMap((key) =>
      value?.[key] !== undefined ? [[key, value[key]]] : [],
    ),
  );
}

function mediaUrl(
  context: ProjectionContext,
  messageId: string,
  toolCallId: string,
  contentIndex: number,
) {
  if (!context.threadId) return undefined;
  const query = new URLSearchParams({
    messageId,
    toolCallId,
    contentIndex: String(contentIndex),
    ...(context.cursor ? { cursor: context.cursor } : {}),
  });
  return `/api/threads/${encodeURIComponent(context.threadId)}/turns/${encodeURIComponent(context.turnId)}/media?${query}`;
}

function mediaOutput(
  part: ToolPart,
  messageId: string,
  context: ProjectionContext,
) {
  const output = record(part.output);
  if (!output)
    return typeof part.output === 'string' && part.output.startsWith('data:')
      ? undefined
      : part.output;
  const name = toolName(part);
  const path =
    typeof output.file_path === 'string' ? output.file_path : undefined;
  const asset = record(output.asset);
  const threadId =
    context.threadId ??
    (typeof asset?.threadId === 'string' ? asset.threadId : undefined);
  const result = pick(output, [
    'ok',
    'isError',
    'file_path',
    'width',
    'height',
    'duration',
    'sample_rate',
    'sampleRate',
    'status',
    'playback_id',
  ]);
  if (!Array.isArray(output.content)) return result;
  result.content = output.content.flatMap((value, index) => {
    const item = record(value);
    if (!item) return [];
    if (item.type === 'text') {
      // Successful generated-media cards already show the file and metadata.
      return output.ok === false || output.isError === true
        ? [pick(item, ['type', 'text'])]
        : [];
    }
    const mime = item.mimeType ?? item.mediaType;
    const inline = inlineToolMedia(item);
    const isMedia =
      !!inline ||
      (typeof mime === 'string' && /^(image|audio|video)\//.test(mime)) ||
      /^(image|audio|video|file)(?:-|$)/.test(String(item.type));
    if (!isMedia) return [];
    const remote = [item.url, item.image].find(
      (value): value is string =>
        typeof value === 'string' && /^(https?:\/\/|\/(?!\/))/.test(value),
    );
    const url =
      path && threadId
        ? `/api/threads/${encodeURIComponent(threadId)}/files/raw?${new URLSearchParams({ path })}`
        : (remote ??
          (inline
            ? mediaUrl(context, messageId, part.toolCallId, index)
            : undefined));
    if (!url) return context.threadId ? [] : [item];
    return [
      {
        type: name === 'image_gen' ? 'image' : 'file',
        mimeType: mime ?? (name === 'image_gen' ? 'image/*' : 'audio/wav'),
        url,
        ...(typeof item.filename === 'string'
          ? { filename: item.filename }
          : {}),
      },
    ];
  });
  return result;
}

const displayParts = new WeakMap<ToolPart, Map<string, ToolPart>>();

/** Construct a display payload without copying provider or reference-media data. */
function displayedTool(
  part: ToolPart,
  messageId: string,
  context: ProjectionContext,
): ToolPart {
  const key = JSON.stringify([
    context.threadId,
    context.turnId,
    context.cursor,
    messageId,
  ]);
  const cached = displayParts.get(part)?.get(key);
  if (cached) return cached;
  const name = toolName(part);
  let input = part.input;
  let output = part.output;
  if (name === 'image_gen') {
    input = {};
    output = mediaOutput(part, messageId, context);
  } else if (name === 'speech') {
    input = pick(record(input), [
      'input',
      'text',
      'voice',
      'language',
      'speed',
    ]);
    output = mediaOutput(part, messageId, context);
  } else if (name === 'intelligent_ui') {
    input = Object.fromEntries(
      Object.entries(
        pick(record(input), ['html', 'title', 'tips', 'waitForResponse']),
      ).filter(([key, value]) => key === 'html' || value !== null),
    );
  }
  const displayed = {
    type: part.type,
    ...(part.type === 'dynamic-tool' ? { toolName: part.toolName } : {}),
    toolCallId: part.toolCallId,
    state: part.state,
    forceRender: true,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(part.errorText !== undefined ? { errorText: part.errorText } : {}),
    ...('approval' in part && part.approval ? { approval: part.approval } : {}),
  } as ToolPart;
  let contexts = displayParts.get(part);
  if (!contexts) displayParts.set(part, (contexts = new Map()));
  contexts.set(key, displayed);
  return displayed;
}

type HiddenPart = { message: UIMessage; part: Part; index: number };
export type ProjectedToolGroup = {
  summary: ChatToolGroup;
  messages: UIMessage[];
};

function failedToolOutput(output: unknown) {
  // Error flags are small. Avoid parsing large legacy JSON/text results merely
  // to choose the collapsed group's status on every streaming update.
  if (typeof output === 'string' && output.length > 16_384) return false;
  const result = record(output);
  return result?.isError === true || result?.ok === false;
}

function toolGroup(parts: HiddenPart[]): ProjectedToolGroup {
  const calls = new Set<string>();
  let running = false;
  let failed = false;
  let reasoningIndex: number | undefined;
  const messages: UIMessage[] = [];
  const revision = createHash('sha256');
  for (const [index, { message, part }] of parts.entries()) {
    revision.update(JSON.stringify([message.id, partRevision(part)]));
    if (isToolUIPart(part)) {
      calls.add(part.toolCallId);
      running ||= ![
        'output-available',
        'output-error',
        'output-denied',
      ].includes(part.state);
      failed ||=
        part.state === 'output-error' ||
        part.state === 'output-denied' ||
        (part.state === 'output-available' && failedToolOutput(part.output));
    } else if (part.type === 'reasoning') {
      reasoningIndex = index;
      running ||= part.state === 'streaming';
    }
    if (messages.at(-1)?.id === message.id) messages.at(-1)!.parts.push(part);
    else messages.push({ ...message, parts: [part] });
  }
  return {
    summary: {
      id: isToolUIPart(parts[0].part)
        ? parts[0].part.toolCallId
        : `${parts[0].message.id}:${parts[0].index}`,
      count: calls.size,
      revision: revision.digest('hex'),
      state: running ? 'running' : failed ? 'failed' : 'completed',
      ...(reasoningIndex !== undefined ? { reasoningIndex } : {}),
      ...(parts.every(({ part }) => part.type === 'reasoning')
        ? { reasoningOnly: true }
        : {}),
    },
    messages,
  };
}

/** One ordered display projection serves snapshots, history and detail locators. */
export function projectTurn(
  messages: readonly UIMessage[],
  context: ProjectionContext,
) {
  const parts: Part[] = [];
  const groups: ProjectedToolGroup[] = [];
  let hidden: HiddenPart[] = [];
  const flush = () => {
    if (!hidden.length) return;
    const group = toolGroup(hidden);
    groups.push(group);
    parts.push({ type: 'data-tool-group', data: group.summary });
    hidden = [];
  };
  const forceRender =
    context.forceRender ?? ((name: string) => historicalDisplayTools.has(name));
  for (const message of messages) {
    if (message.role !== 'assistant') {
      flush();
      continue;
    }
    for (const [index, part] of message.parts.entries()) {
      if (part.type === 'text') {
        if (!part.text.trim()) continue;
        flush();
        parts.push({
          type: 'text',
          text: part.text,
          state: part.state ?? 'done',
        });
      } else if (isToolUIPart(part)) {
        if (forceRender(toolName(part))) {
          flush();
          parts.push(displayedTool(part, message.id, context));
        } else hidden.push({ message, part, index });
      } else if (
        (part.type === 'reasoning' && part.text.trim()) ||
        (part.type === 'file' && part.mediaType.startsWith('image/')) ||
        getMessageCompression(part) !== null ||
        (part.type === 'data-background-task-completed' &&
          typeof record(part.data)?.toolName === 'string')
      )
        hidden.push({ message, part, index });
    }
  }
  flush();
  return { parts, groups };
}
