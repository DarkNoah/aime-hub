// OCR is an application capability; the installed AI SDK has no OCR model contract.
export type OcrInput =
  | { url: string; data?: never; fileName?: never }
  | { data: Uint8Array; fileName: string; url?: never };

export type OcrOptions = {
  input: OcrInput;
  abortSignal?: AbortSignal;
  language?: string;
  forceOcr?: boolean;
  enableFormula?: boolean;
  enableTable?: boolean;
  pageRanges?: string;
  // Provider-specific recognition options (PaddleOCR: official optionalPayload).
  providerOptions?: Record<string, unknown>;
};

export type OcrResult = {
  markdown: string;
  archiveUrl?: string;
  // Some providers return structured results instead of a ZIP archive.
  resultUrl?: string;
  taskId: string;
};

export interface OcrModel {
  readonly provider: string;
  readonly modelId: string;
  readonly supportsPageRanges?: boolean;
  doOCR(options: OcrOptions): Promise<OcrResult>;
}
