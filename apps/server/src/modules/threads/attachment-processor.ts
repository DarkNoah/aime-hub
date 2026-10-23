import type {
  Processor,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
} from '@mastra/core/processors';
import {
  attachmentAttributes,
  splitAttachmentText,
  type AttachmentMetadata,
  type MessageAttachment,
} from '@aime/shared/chat-attachments';
import { MAX_IMAGE_BYTES } from '@aime/shared/threads';
import {
  AttachmentMediaReader,
  inspectAttachmentMedia,
} from './attachment-media.js';

type Prompt = ProcessLLMRequestArgs['prompt'];
type UserMessage = Extract<Prompt[number], { role: 'user' }>;
type Part = UserMessage['content'][number];
type FilePart = Extract<Part, { type: 'file' }>;

function inlineData(file: FilePart) {
  if (file.data instanceof Uint8Array) return file.data;
  if (file.data instanceof URL) {
    if (file.data.protocol !== 'data:') return;
    return Buffer.from(
      file.data.href.slice(file.data.href.indexOf(',') + 1),
      'base64',
    );
  }
  const data = file.data.startsWith('data:')
    ? file.data.slice(file.data.indexOf(',') + 1)
    : file.data;
  return Buffer.from(data, 'base64');
}

/** Rewrites only the outbound user prompt, so history retains media for future model switches. */
export class AttachmentProcessor implements Processor {
  readonly id = 'chat-attachments';

  constructor(
    private readonly reader: AttachmentMediaReader,
    private readonly modalities: () =>
      readonly string[] | Promise<readonly string[]>,
  ) {}

  async processLLMRequest({
    prompt,
    abortSignal,
  }: ProcessLLMRequestArgs): Promise<ProcessLLMRequestResult> {
    const supportsImages = (await this.modalities()).includes('image');
    const result: Prompt = [];
    for (const message of prompt) {
      if (message.role !== 'user') {
        result.push(message);
        continue;
      }
      const body: Part[] = [];
      const references: MessageAttachment[] = [];
      const files: FilePart[] = [];
      for (const part of message.content) {
        if (part.type === 'file') files.push(part);
        else {
          const parsed = splitAttachmentText(part.text);
          references.push(...parsed.attachments);
          if (parsed.text) body.push({ ...part, text: parsed.text });
        }
      }
      if (!references.length && !files.length) {
        result.push(message);
        continue;
      }
      const attachments: { attributes: AttachmentMetadata; file?: FilePart }[] =
        [];
      const used = new Set<FilePart>();
      for (const reference of references) {
        const file = files.find(
          (item) =>
            !used.has(item) &&
            item.mediaType === reference.mediaType &&
            item.filename === reference.filename &&
            // Existing uploads only supplied inline bytes for small images.
            (!reference.mediaType.startsWith('image/') ||
              reference.size === undefined ||
              reference.size <= MAX_IMAGE_BYTES),
        );
        if (file) used.add(file);
        attachments.push({
          attributes: {
            path: reference.workspacePath,
            size: reference.size,
            mimeType: reference.mediaType,
          },
          file,
        });
      }
      for (const file of files) {
        if (!used.has(file))
          attachments.push({ attributes: { mimeType: file.mediaType }, file });
      }
      for (const attachment of attachments) {
        abortSignal?.throwIfAborted();
        let { attributes, file } = attachment;
        // Only supported images are sent natively; everything else is a path reference.
        if (!supportsImages || !attributes.mimeType.startsWith('image/')) {
          const path = attachmentAttributes({ path: attributes.path });
          body.push({
            type: 'text',
            text: `<attachment${path ? ` ${path}` : ''}></attachment>`,
          });
          continue;
        }
        const bytes = file && inlineData(file);
        if (bytes) {
          attributes = {
            ...attributes,
            size: bytes.byteLength,
            ...(await inspectAttachmentMedia(
              bytes,
              attributes.mimeType,
              abortSignal,
            )),
          };
        } else if (attributes.path) {
          try {
            const loaded = await this.reader.read(
              attributes,
              true,
              abortSignal,
            );
            attributes = loaded.attributes;
            if (loaded.data)
              file = {
                type: 'file',
                mediaType: attributes.mimeType,
                data: loaded.data,
              };
          } catch (error) {
            abortSignal?.throwIfAborted();
            // Deleted/inaccessible historical attachments remain usable as path references.
            if (!(error instanceof Error)) throw error;
          }
        }
        body.push({
          type: 'text',
          text: `<attachment ${attachmentAttributes(attributes)}>`,
        });
        if (file) body.push(file);
        body.push({ type: 'text', text: '</attachment>' });
      }
      result.push({ ...message, content: body });
    }
    return { prompt: result };
  }
}
