import { ChatRequestLog } from '@aime/db';
import { truncateJsonBody } from '@aime/shared/log-json';
import {
  requestLogContextFields,
  type CapturedChatRequest,
  type CapturedChatResponse,
  type RequestLogDetail,
  type RequestLogPage,
  type RequestLogQuery,
  type RequestLogSummary,
} from '@aime/shared/request-logs';
import { ORPCError } from '@orpc/server';
import type { DataSource } from 'typeorm';

function summary(row: ChatRequestLog): RequestLogSummary {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    method: row.method,
    url: row.url,
    threadId: row.threadId,
    resourceId: row.resourceId,
    userId: row.userId,
    projectId: row.projectId,
    model: row.model,
    stream: row.stream,
    status: row.status,
    bodyBytes: row.bodyBytes,
    durationMs: row.durationMs,
    httpStatus: row.httpStatus,
    responseStatus: row.responseStatus,
    responseContentType: row.responseContentType,
    responseContentEncoding: row.responseContentEncoding,
    responseBytes: row.responseBytes,
    responseBodyEncoding: row.responseBodyEncoding,
  };
}

export class RequestLogService {
  private pending = Promise.resolve();

  constructor(private readonly database: DataSource) {}

  private get repository() {
    return this.database.getRepository(ChatRequestLog);
  }

  /** Queue persistence outside Undici's synchronous diagnostics callback. */
  record(request: CapturedChatRequest): void {
    this.pending = this.pending
      .then(async () => {
        let model: string | null = null;
        let stream: boolean | null = null;
        try {
          const parsed: unknown = JSON.parse(request.body);
          if (parsed && typeof parsed === 'object') {
            if ('model' in parsed && typeof parsed.model === 'string')
              model = parsed.model;
            if ('stream' in parsed && typeof parsed.stream === 'boolean')
              stream = parsed.stream;
          }
        } catch {
          // Interrupted uploads can contain only a prefix of the JSON body.
        }
        await this.repository.insert({
          id: request.id,
          createdAt: new Date(request.createdAt),
          method: request.method,
          url: request.url,
          threadId: request.threadId,
          resourceId: request.resourceId,
          userId: request.userId,
          projectId: request.projectId,
          model,
          stream,
          status: request.complete ? 'complete' : 'incomplete',
          bodyBytes: Buffer.byteLength(request.body, 'utf8'),
          body: truncateJsonBody(request.body),
          responseStatus: 'pending',
        });
      })
      .catch(() => {
        console.error('Failed to persist chat request log', request.id);
      });
  }

  settled(): Promise<void> {
    return this.pending;
  }

  /** Use the same queue so a fast response cannot overtake its request insert. */
  recordResponse(response: CapturedChatResponse): void {
    const { id, ...fields } = response;
    this.pending = this.pending
      .then(async () => {
        await this.repository.update(id, fields);
      })
      .catch(() => {
        console.error('Failed to persist chat response log', id);
      });
  }

  async list(input: RequestLogQuery): Promise<RequestLogPage> {
    const query = this.repository.createQueryBuilder('log');
    if (input.status !== 'all')
      query.andWhere('log.status = :status', { status: input.status });
    for (const field of requestLogContextFields) {
      if (input[field])
        query.andWhere(`log.${field} = :${field}`, { [field]: input[field] });
    }
    if (input.search) {
      const search = `%${input.search.replace(/[\\%_]/g, '\\$&')}%`;
      query.andWhere(
        '(log.model ILIKE :search OR log.url ILIKE :search OR CAST(log.id AS text) ILIKE :search OR log.threadId ILIKE :search OR log.resourceId ILIKE :search OR log.userId ILIKE :search OR log.projectId ILIKE :search)',
        { search },
      );
    }
    const countQuery = query.clone();
    if (input.cursor) {
      const cursor = await this.repository.findOneBy({ id: input.cursor });
      if (!cursor) throw new ORPCError('NOT_FOUND');
      query.andWhere('(log.createdAt, log.id) < (:createdAt, :id)', {
        createdAt: cursor.createdAt,
        id: cursor.id,
      });
    }
    const [rows, total] = await Promise.all([
      query
        .orderBy('log.createdAt', 'DESC')
        .addOrderBy('log.id', 'DESC')
        .take(input.limit + 1)
        .getMany(),
      countQuery.getCount(),
    ]);
    const items = rows.slice(0, input.limit).map(summary);
    return {
      items,
      total,
      nextCursor: rows.length > input.limit ? items.at(-1)!.id : null,
    };
  }

  async get(id: string): Promise<RequestLogDetail> {
    const row = await this.repository
      .createQueryBuilder('log')
      .addSelect('log.body')
      .addSelect('log.responseBody')
      .where('log.id = :id', { id })
      .getOne();
    if (!row) throw new ORPCError('NOT_FOUND');
    return { ...summary(row), body: row.body, responseBody: row.responseBody };
  }
}
