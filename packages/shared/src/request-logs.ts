import { z } from 'zod';

export const requestLogQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  status: z.enum(['all', 'complete', 'incomplete']).default('all'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type RequestLogQuery = z.infer<typeof requestLogQuerySchema>;

export type CapturedChatRequest = {
  id: string;
  createdAt: string;
  method: string;
  url: string;
  body: string;
  complete: boolean;
};

export type RequestLogSummary = {
  id: string;
  createdAt: string;
  method: string;
  url: string;
  model: string | null;
  stream: boolean | null;
  status: 'complete' | 'incomplete';
  bodyBytes: number;
};
export type RequestLogDetail = RequestLogSummary & { body: string };
export type RequestLogPage = {
  items: RequestLogSummary[];
  nextCursor: string | null;
  total: number;
};
