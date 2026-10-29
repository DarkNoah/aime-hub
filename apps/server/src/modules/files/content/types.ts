import type { OcrModel } from '../../../mastra/providers/ocr-model.js';

/** Safe, user-facing failures. Provider/parser errors must not escape this boundary. */
export class FileContentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type FileContentInput = {
  data: Uint8Array;
  fileName: string;
  mimeType?: string;
};

export type FileContentDependencies = {
  resolveOcr?: () => Promise<{ model: OcrModel; reference?: string }>;
  transcribe?: (data: Buffer, signal: AbortSignal) => Promise<string>;
};

export type FileContentModel = {
  reference?: string;
  modalitiesInput: readonly string[];
};

/** File-specific options; unknown keys are left for future format adapters. */
export type FileContentParameters = Record<string, unknown>;

export type FileContentOptions = {
  signal?: AbortSignal;
  model?: FileContentModel | null;
  parameters?: FileContentParameters;
  /** Let read_file return available content when optional OCR is unavailable or fails. */
  skipOcrErrors?: boolean;
};

type FileContentMetadata = {
  fileName: string;
  mimeType: string;
  kind: 'text' | 'document' | 'pdf' | 'image' | 'audio' | 'video';
  size: number;
  width?: number;
  height?: number;
  model?: string;
  taskId?: string;
  archiveUrl?: string;
  resultUrl?: string;
};

export type FileContentImage = {
  data: string;
  mimeType: string;
  fileName: string;
};
export type FileContentSheet = {
  name: string;
  index: number;
  totalRows: number;
  totalColumns: number;
  selectedRows: number[];
  sampled: boolean;
  range?: string;
};

/** Complete text of the selected source. Tool budgets never belong to the parser. */
export type FileContent = FileContentMetadata & {
  type: 'text';
  format: 'markdown' | 'text';
  text: string;
  /** OCR text and images coexist; only image-capable consumers receive these bytes. */
  images?: FileContentImage[];
  sheets?: FileContentSheet[];
  warnings?: string[];
};
