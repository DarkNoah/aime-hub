import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import { In, type DataSource } from 'typeorm';
import { GeneratedAsset } from '@aime/db';
import {
  assetMetadataSchema,
  assetSorts,
  type AssetQuery,
  type AssetList,
  type GeneratedAssetInput,
} from '@aime/shared/assets';
import type { ThreadService } from '../threads/service.js';
import { ThreadError } from '../threads/errors.js';
import { prepareAssetAttachments } from './attachments.js';
import { validatePath } from '../files/paths.js';

const cursorSchema = z.object({
  id: z.uuid(),
  sort: z.enum(assetSorts),
  value: z.union([z.string().max(2048), z.number().int().nonnegative()]),
});
const order = {
  newest: { field: 'createdAt', direction: 'DESC' },
  oldest: { field: 'createdAt', direction: 'ASC' },
  name: { field: 'name', direction: 'ASC' },
  largest: { field: 'size', direction: 'DESC' },
} as const;

export class AssetService {
  constructor(private database: DataSource) {}

  /** Idempotent onOutput sink shared by image, video and audio generation tools. */
  async record(input: GeneratedAssetInput): Promise<void> {
    validatePath(input.path);
    if (
      !input.threadId ||
      !input.resourceId ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0
    )
      throw new Error('Invalid generated asset metadata');
    const media = input.mimeType.split('/')[0];
    const kind =
      media === 'image' || media === 'video' || media === 'audio'
        ? media
        : 'file';
    await this.database
      .getRepository(GeneratedAsset)
      .createQueryBuilder()
      .insert()
      .values({
        ...input,
        id: randomUUID(),
        name: basename(input.path),
        kind,
        metadata: () => 'CAST(:assetMetadata AS jsonb)',
        toolCallId: input.toolCallId ?? null,
        model: input.model ?? null,
      })
      .setParameter(
        'assetMetadata',
        JSON.stringify(assetMetadataSchema.parse(input.metadata ?? {})),
      )
      .orIgnore()
      .execute();
  }

  async list(
    threads: Pick<ThreadService, 'assetScope'>,
    userId: string,
    threadId: string,
    input: AssetQuery,
  ): Promise<AssetList> {
    const scope = await threads.assetScope(userId, threadId);
    if (!scope.threadIds.length) return { items: [], nextCursor: null };
    const query = this.database
      .getRepository(GeneratedAsset)
      .createQueryBuilder('asset')
      .where('asset.resourceId = :resourceId', { resourceId: scope.resourceId })
      .andWhere('asset.threadId IN (:...threadIds)', {
        threadIds: scope.threadIds,
      });
    if (input.kind !== 'all')
      query.andWhere('asset.kind = :kind', { kind: input.kind });
    if (input.search)
      query.andWhere('(asset.name ILIKE :search OR asset.path ILIKE :search)', {
        search: `%${input.search.replace(/[\\%_]/g, '\\$&')}%`,
      });
    const { field, direction } = order[input.sort];
    if (input.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString()),
        );
        if (
          cursor.sort !== input.sort ||
          (field === 'size'
            ? typeof cursor.value !== 'number'
            : typeof cursor.value !== 'string') ||
          (field === 'createdAt' &&
            !z.iso.datetime().safeParse(cursor.value).success)
        )
          throw new Error('Invalid cursor');
      } catch {
        throw new ThreadError('VALIDATION_ERROR');
      }
      const comparison = direction === 'ASC' ? '>' : '<';
      query.andWhere(
        `(asset.${field} ${comparison} :value OR (asset.${field} = :value AND asset.id ${comparison} :id))`,
        {
          value: cursor.value,
          id: cursor.id,
        },
      );
    }
    const rows = await query
      .orderBy(`asset.${field}`, direction)
      .addOrderBy('asset.id', direction)
      .take(input.limit + 1)
      .getMany();
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        ...row,
        metadata: assetMetadataSchema.parse(row.metadata),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                id: last.id,
                sort: input.sort,
                value:
                  field === 'createdAt'
                    ? last.createdAt.toISOString()
                    : last[field],
              }),
            ).toString('base64url')
          : null,
    };
  }

  async attach(
    threads: Pick<ThreadService, 'assetScope' | 'withWorkspaceFiles'>,
    userId: string,
    threadId: string,
    ids: string[],
    signal?: AbortSignal,
  ) {
    const scope = await threads.assetScope(userId, threadId);
    const unique = [...new Set(ids)];
    const rows = await this.database.getRepository(GeneratedAsset).findBy({
      id: In(unique),
      resourceId: scope.resourceId,
      threadId: In(scope.threadIds),
    });
    if (rows.length !== unique.length)
      throw new ThreadError('FILE_NOT_FOUND', 404);
    // Preserve the user's selection order, irrespective of database row order.
    const selected = unique.map((id) => rows.find((row) => row.id === id)!);
    return prepareAssetAttachments(threads, userId, threadId, selected, signal);
  }
}
