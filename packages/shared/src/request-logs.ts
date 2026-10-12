import { z } from 'zod';

export const requestLogContextFields = [
  'threadId',
  'resourceId',
  'userId',
  'projectId',
] as const;
export type RequestLogContext = Record<
  (typeof requestLogContextFields)[number],
  string | null
>;

export const requestLogQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  threadId: z.string().trim().max(200).optional(),
  resourceId: z.string().trim().max(200).optional(),
  userId: z.string().trim().max(200).optional(),
  projectId: z.string().trim().max(200).optional(),
  status: z.enum(['all', 'complete', 'incomplete']).default('all'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type RequestLogQuery = z.infer<typeof requestLogQuerySchema>;

export type CapturedChatRequest = RequestLogContext & {
  id: string;
  createdAt: string;
  method: string;
  url: string;
  body: string;
  complete: boolean;
};

export type CapturedChatResponse = {
  id: string;
  durationMs: number;
  httpStatus: number | null;
  responseStatus: 'complete' | 'incomplete';
  responseContentType: string | null;
  responseContentEncoding: string | null;
  responseBytes: number;
  responseBody: string | null;
  responseBodyEncoding: 'utf8' | 'base64' | null;
};

export type RequestLogSummary = RequestLogContext & {
  id: string;
  createdAt: string;
  method: string;
  url: string;
  model: string | null;
  stream: boolean | null;
  status: 'complete' | 'incomplete';
  bodyBytes: number;
  durationMs: number | null;
  httpStatus: number | null;
  responseStatus: 'pending' | 'complete' | 'incomplete' | null;
  responseContentType: string | null;
  responseContentEncoding: string | null;
  responseBytes: number | null;
  responseBodyEncoding: 'utf8' | 'base64' | null;
};
export type RequestLogDetail = RequestLogSummary & {
  body: string;
  responseBody: string | null;
};
export type RequestLogPage = {
  items: RequestLogSummary[];
  nextCursor: string | null;
  total: number;
};
