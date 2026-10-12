import { z } from 'zod';
import { imageMimeType } from '../../providers/image-data.js';

export const execOutputSchema = z.object({
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({
        type: z.literal('image'),
        data: z.string(),
        mimeType: z.string(),
      }),
    ]),
  ),
  isError: z.boolean().optional(),
  truncated: z.boolean().optional(),
});

/** Explicit output is bounded independently of transient values inside the VM. */
export class ExecOutput {
  readonly result: z.infer<typeof execOutputSchema> = { content: [] };
  private remaining: number;
  private imageBytes = 0;
  constructor(maxTokens: number) {
    this.remaining = maxTokens * 4;
  }

  text(value: unknown) {
    const text =
      typeof value === 'string'
        ? value
        : (JSON.stringify(value) ?? String(value));
    const bytes = Buffer.from(text);
    if (bytes.length > this.remaining) this.result.truncated = true;
    if (this.remaining <= 0 || this.result.content.length >= 1000) {
      this.result.truncated = true;
      return;
    }
    let end = Math.min(bytes.length, this.remaining);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    this.result.content.push({
      type: 'text',
      text: bytes.subarray(0, end).toString(),
    });
    this.remaining -= end;
  }

  image(value: unknown) {
    let data: unknown;
    let mimeType: unknown;
    if (typeof value === 'string') data = value;
    else if (value && typeof value === 'object') {
      const part = value as Record<string, unknown>;
      data = part.image_url ?? part.data;
      mimeType = part.mimeType ?? part.mediaType;
    }
    if (typeof data !== 'string')
      throw new Error('image() expects a base64 data URL or image block');
    const url = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(data);
    if (url) [, mimeType, data] = url;
    const base64 = (data as string).replace(/\s/g, '');
    if (
      !base64 ||
      !/^[a-zA-Z0-9+/]+={0,2}$/.test(base64) ||
      base64.length % 4 === 1
    )
      throw new Error('image() received invalid base64 data');
    const bytes = Buffer.byteLength(base64, 'base64');
    if (
      this.imageBytes + bytes > 10 * 1024 * 1024 ||
      this.result.content.length >= 1000
    )
      throw new Error('exec image output limit exceeded');
    const header = Buffer.from(base64.slice(0, 32), 'base64');
    const actualType = /^GIF8[79]a/.test(header.toString('ascii'))
      ? 'image/gif'
      : imageMimeType(header);
    if (
      mimeType !== undefined &&
      mimeType !== 'image/*' &&
      mimeType !== actualType
    )
      throw new Error('image() MIME type does not match the image data');
    this.imageBytes += bytes;
    this.result.content.push({
      type: 'image',
      data: base64,
      mimeType: actualType,
    });
  }

  error(error: unknown) {
    this.result.isError = true;
    // Diagnostics must remain visible even after the user output budget is exhausted.
    this.result.content.push({
      type: 'text',
      text: `exec: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        2000,
      ),
    });
  }
}
