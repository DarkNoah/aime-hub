import { z } from 'zod';

const filter = z.string().trim().max(200).optional();
export const usageQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    timezone: z
      .string()
      .max(80)
      .default('Asia/Shanghai')
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    userId: filter,
    projectId: filter,
    providerId: filter,
    model: filter,
  })
  .refine(
    ({ from, to }) => {
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      return days >= 0 && days < 366;
    },
    { message: 'Select between 1 and 366 days', path: ['to'] },
  );
export const usageRecordsQuerySchema = usageQuerySchema.safeExtend({
  cursor: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;
export type UsageRecordsQuery = z.infer<typeof usageRecordsQuerySchema>;
export const tokenFields = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'reasoningTokens',
] as const;
export type TokenCounts = Record<(typeof tokenFields)[number], number | null>;
export type UsageTotals = Record<(typeof tokenFields)[number], number> & {
  requests: number;
  reportedRequests: number;
  averageDurationMs: number | null;
};
export type UsageBucket = UsageTotals & { date: string };
export type UsageHeatCell = {
  weekday: number;
  hour: number;
  totalTokens: number;
  requests: number;
};
export type UsageGroup = UsageTotals & {
  id: string | null;
  name: string | null;
  providerId?: string | null;
  providerName?: string | null;
};
export type UsageSummary = {
  totals: UsageTotals;
  daily: UsageBucket[];
  heatmap: UsageHeatCell[];
  users: UsageGroup[];
  projects: UsageGroup[];
  models: UsageGroup[];
};
export type UsageRecord = TokenCounts & {
  id: string;
  createdAt: string;
  userId: string | null;
  userName: string | null;
  projectId: string | null;
  projectName: string | null;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  threadId: string | null;
  durationMs: number | null;
  runId: string | null;
  agentId: string | null;
  modelReference: string;
  finishReason: string | null;
  stepNumber: number;
};
export type UsageRecordPage = {
  items: UsageRecord[];
  nextCursor: UsageRecordsQuery['cursor'] | null;
};
