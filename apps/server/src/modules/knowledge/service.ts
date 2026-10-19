import { KnowledgeVectorStore, vectorTableName } from './vector-store.js';
import { validateMetadata } from './fields.js';
import { archiveVersion, versionSummary } from './versions.js';
import { tagFilter } from './tags.js';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { In, type DataSource, type EntityManager } from 'typeorm';
import {
  KnowledgeBaseRecord as Base,
  KnowledgeDocumentRecord as Document,
  KnowledgeBaseMember as Member,
  KnowledgeDocumentVersion as Version,
} from '@aime/db';
import {
  KnowledgeAccess,
  type KnowledgeCapabilities,
  type KnowledgeAction,
} from './access.js';
import {
  knowledgeBaseInputSchema,
  knowledgeBaseUpdateSchema,
  knowledgeSourceSchema,
  knowledgeSearchSchema,
  knowledgeLocked,
  knowledgeSharingSchema,
  knowledgeDocumentUpdateSchema,
  knowledgeVersionInputSchema,
  knowledgeTagsSchema,
  knowledgeMetadataSchema,
  knowledgeImageFileAccept,
  type KnowledgeDocumentDetail,
  type KnowledgeMetadata,
  type KnowledgeTags,
  type KnowledgeVersionDetail,
  type KnowledgeSharingDetail,
  type KnowledgeUser,
  knowledgeMemberInputSchema,
  knowledgeMemberPageSchema,
  type KnowledgeMember,
  type KnowledgeMemberPage,
  type KnowledgeUserPage,
  type KnowledgeBase,
  type KnowledgeScope,
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeCursor,
} from '@aime/shared/knowledge';
import type { z } from 'zod';
import { embed } from 'ai';
import type { PgVector } from '@mastra/pg';
import type { ProviderService } from '../providers/service.js';
import type { ProjectThreadAccess } from '../projects/service.js';
import { ThreadError } from '../threads/errors.js';
import { validateKnowledgeFile } from './parse.js';
import {
  fuseRanks,
  mergeVectorRanks,
  KNOWLEDGE_RERANK_TIMEOUT_MS,
  rerankFailureReason,
  rerankKnowledge,
  searchBM25,
  withSearchTimeout,
  type FusedChunk,
  type RankedChunk,
} from './retrieval.js';

export function activeKnowledgeIndex(base: Base) {
  if (!base.vectorIndex) throw new Error('Knowledge vector table unavailable');
  return base.vectorIndex;
}
export function documentSummary(d: Document): KnowledgeDocument {
  return {
    id: d.id,
    baseId: d.baseId,
    version: d.version,
    tags: d.tags,
    metadata: d.metadata,
    createdBy: d.createdBy,
    updatedAt: d.updatedAt.toISOString(),
    deletedAt: d.deletedAt?.toISOString() ?? null,
    name: d.name,
    sourceType: d.sourceType,
    sourceUrl: d.sourceUrl,
    status: d.status,
    enabled: d.enabled,
    chunkCount: d.chunkCount,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
  };
}
export class KnowledgeService {
  private acl: KnowledgeAccess;
  readonly store: KnowledgeVectorStore;
  constructor(
    readonly database: DataSource,
    readonly vectors: PgVector,
    readonly providers: Pick<
      ProviderService,
      | 'getEmbeddingModel'
      | 'getRerankModel'
      | 'getImageEmbeddingModel'
      | 'getDefaults'
    >,
    projects: ProjectThreadAccess,
  ) {
    this.acl = new KnowledgeAccess(database, projects);
    this.store = new KnowledgeVectorStore(database, vectors);
  }

  private summary(b: Base, capabilities: KnowledgeCapabilities): KnowledgeBase {
    return {
      id: b.id,
      fields: b.fields,
      vectorIndex: b.vectorIndex,
      vectorDimension: b.vectorDimension,
      name: b.name,
      description: b.description,
      scope: b.scope,
      projectId: b.projectId,
      embeddingModel: b.embeddingModel,
      rerankModel: b.rerankModel,
      rebuild: b.rebuild
        ? {
            id: b.rebuild.id,
            status: b.rebuild.status,
            embeddingModel: b.rebuild.embeddingModel,
            rerankModel: b.rebuild.rerankModel,
            completed: b.rebuild.completed,
            total: b.rebuild.total,
            error: b.rebuild.error,
          }
        : null,
      enabled: b.enabled,
      ...capabilities,
      ownerId: b.ownerId,
      sharingMode: b.sharingMode,
      createdAt: b.createdAt.toISOString(),
    };
  }
  async access(
    userId: string,
    id: string,
    write = false,
    manager = this.database.manager,
  ) {
    return this.acl.access(
      userId,
      id,
      write ? 'documents' : undefined,
      manager,
    );
  }
  async list(userId: string, scope: KnowledgeScope) {
    const { bases, canManage } = await this.acl.list(userId, scope);
    const result: KnowledgeBase[] = [];
    for (const base of bases) {
      try {
        result.push(
          this.summary(
            base,
            await this.acl.permissions(userId, base, this.database.manager),
          ),
        );
      } catch (error) {
        if (!(
          error instanceof ThreadError && error.code === 'KNOWLEDGE_NOT_FOUND'
        ))
          throw error;
      }
    }
    return { bases: result, canManage };
  }
  async create(
    userId: string,
    scope: KnowledgeScope,
    data: z.input<typeof knowledgeBaseInputSchema>,
  ) {
    if (!(await this.acl.canCreate(userId, scope)))
      throw new ThreadError('FORBIDDEN', 403);
    const input = knowledgeBaseInputSchema.parse(data);
    const defaults = await this.modelDefaults();
    const embeddingModel =
      input.embeddingModel === undefined
        ? defaults.embeddingModel
        : input.embeddingModel;
    const rerankModel =
      input.rerankModel === undefined
        ? defaults.rerankModel
        : input.rerankModel;
    await this.validateModels(embeddingModel, rerankModel);
    let dimension = 0;
    if (embeddingModel) {
      try {
        const result = await withSearchTimeout(
          async (signal) =>
            embed({
              model: await this.providers.getEmbeddingModel(embeddingModel),
              value: 'dimension probe',
              maxRetries: 0,
              abortSignal: signal,
            }),
          30_000,
        );
        dimension = result.embedding.length;
        if (!dimension || result.embedding.some((n) => !Number.isFinite(n)))
          throw new Error('Invalid dimension probe');
      } catch {
        throw new ThreadError('KNOWLEDGE_EMBED_FAILED');
      }
    }
    const index = vectorTableName(dimension);
    try {
      await this.store.create(index, dimension, input.fields);
      const base = await this.database.manager.save(
        Base,
        this.database.manager.create(Base, {
          ...input,
          embeddingModel,
          rerankModel,
          rebuild: null,
          vectorIndex: index,
          retiredIndexes: [],
          id: randomUUID(),
          scope: scope.scope,
          ownerId: userId,
          sharingMode: scope.scope === 'shared' ? 'all' : 'private',
          sharedPermission: 'read',
          projectId: scope.scope === 'project' ? scope.projectId : null,
          enabled: true,
          vectorDimension: dimension || null,
        }),
      );
      return this.summary(
        base,
        await this.acl.permissions(userId, base, this.database.manager),
      );
    } catch (error) {
      await this.store.drop(index).catch(() => {});
      throw error;
    }
  }
  async modelDefaults() {
    const { embeddingModel, rerankModel } = await this.providers.getDefaults();
    return { embeddingModel, rerankModel };
  }
  async get(userId: string, id: string) {
    const { base, ...capabilities } = await this.access(userId, id);
    return this.summary(base, capabilities);
  }
  async sharing(userId: string, id: string): Promise<KnowledgeSharingDetail> {
    const { base } = await this.acl.access(userId, id, 'share');
    return {
      mode: base.sharingMode,
      permission: base.sharedPermission,
      memberCount: await this.database.manager.countBy(Member, { baseId: id }),
    };
  }
  async members(
    userId: string,
    id: string,
    input: z.input<typeof knowledgeMemberPageSchema> = {},
  ): Promise<KnowledgeMemberPage> {
    await this.acl.access(userId, id, 'share');
    const { query, cursor } = knowledgeMemberPageSchema.parse(input);
    // Page by the immutable membership key so renames do not skip users.
    const filter = `m.base_id = $1 AND (strpos(lower(COALESCE(u.name, m.user_id)), lower($2)) > 0
      OR strpos(lower(COALESCE(u.username, '')), lower($2)) > 0)`;
    const [rows, counts]: [KnowledgeMember[], { total: string }[]] =
      await Promise.all([
        this.database.query(
          `SELECT m.user_id AS id, COALESCE(u.name, m.user_id) AS name, u.username, m.permission
        FROM knowledge_base_members m LEFT JOIN users u ON u.id = m.user_id
        WHERE ${filter} AND ($3::text IS NULL OR m.user_id > $3)
        ORDER BY m.user_id LIMIT 51`,
          [id, query, cursor ?? null],
        ),
        this.database.query(
          `SELECT count(*) AS total FROM knowledge_base_members m LEFT JOIN users u ON u.id = m.user_id WHERE ${filter}`,
          [id, query],
        ),
      ]);
    return {
      members: rows.slice(0, 50),
      total: Number(counts[0].total),
      nextCursor: rows.length > 50 ? rows[49].id : undefined,
    };
  }
  async searchUsers(
    userId: string,
    id: string,
    query: string,
    cursor?: string,
  ): Promise<KnowledgeUserPage> {
    await this.acl.access(userId, id, 'share');
    if (query.trim().length < 2) return { users: [] };
    const users: KnowledgeUser[] = await this.database.query(
      `SELECT u.id, u.name, u.username FROM users u
      WHERE u.id <> $1 AND COALESCE(u.banned, false) = false AND
      (strpos(lower(u.name), lower($2)) > 0 OR strpos(lower(COALESCE(u.username, '')), lower($2)) > 0)
      AND NOT EXISTS (SELECT 1 FROM knowledge_base_members m WHERE m.base_id = $3 AND m.user_id = u.id)
      AND ($4::text IS NULL OR u.id > $4)
      ORDER BY u.id LIMIT 21`,
      [userId, query.trim(), id, cursor ?? null],
    );
    return {
      users: users.slice(0, 20),
      nextCursor: users.length > 20 ? users[19].id : undefined,
    };
  }
  setSharing(
    userId: string,
    id: string,
    input: z.input<typeof knowledgeSharingSchema>,
  ) {
    const sharing = knowledgeSharingSchema.parse(input);
    return this.mutate(
      userId,
      id,
      async (m, base) => {
        if (sharing.mode !== 'members') await m.delete(Member, { baseId: id });
        base.sharingMode = sharing.mode;
        base.sharedPermission =
          sharing.mode === 'all' ? sharing.permission : 'read';
        return this.summary(
          await m.save(Base, base),
          await this.acl.permissions(userId, base, m),
        );
      },
      'share',
    );
  }
  setMember(
    userId: string,
    id: string,
    input: z.input<typeof knowledgeMemberInputSchema>,
  ): Promise<KnowledgeMember> {
    const member = knowledgeMemberInputSchema.parse(input);
    return this.mutate(
      userId,
      id,
      async (m, base) => {
        if (base.sharingMode !== 'members')
          throw new ThreadError('KNOWLEDGE_SHARING_CHANGED', 409);
        const [user]: KnowledgeUser[] = await m.query(
          'SELECT id, name, username FROM users WHERE id = $1 AND COALESCE(banned, false) = false',
          [member.userId],
        );
        if (!user || member.userId === base.ownerId)
          throw new ThreadError('KNOWLEDGE_INVALID_MEMBERS', 400);
        await m.upsert(Member, { baseId: id, ...member }, ['baseId', 'userId']);
        return { ...user, permission: member.permission };
      },
      'share',
    );
  }
  removeMember(userId: string, id: string, memberId: string) {
    return this.mutate(
      userId,
      id,
      async (m, base) => {
        if (base.sharingMode !== 'members')
          throw new ThreadError('KNOWLEDGE_SHARING_CHANGED', 409);
        await m.delete(Member, { baseId: id, userId: memberId });
      },
      'share',
    );
  }
  private async validateModels(
    embedding: string | null,
    rerank: string | null,
  ) {
    await Promise.all([
      embedding ? this.providers.getEmbeddingModel(embedding) : undefined,
      rerank ? this.providers.getRerankModel(rerank) : undefined,
    ]);
  }
  private mutate<T>(
    userId: string,
    id: string,
    action: (m: EntityManager, b: Base) => Promise<T>,
    capability: KnowledgeAction = 'documents',
    conversation?: { projectId?: string },
  ) {
    return this.database.transaction(async (manager) => {
      // All document mutations and worker claims serialize with base removal.
      await manager.findOne(Base, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      const { base } = await this.acl.access(userId, id, capability, manager);
      if (conversation && !this.inConversation(base, conversation.projectId))
        throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
      if (knowledgeLocked(base)) throw new ThreadError('KNOWLEDGE_LOCKED', 409);
      return action(manager, base);
    });
  }
  update(
    userId: string,
    id: string,
    data: z.input<typeof knowledgeBaseUpdateSchema>,
  ) {
    return this.mutate(
      userId,
      id,
      async (m, b) => {
        const input = knowledgeBaseUpdateSchema.parse(data);
        const embeddingModel =
          input.embeddingModel === undefined
            ? b.embeddingModel
            : input.embeddingModel;
        const rerankModel =
          input.rerankModel === undefined ? b.rerankModel : input.rerankModel;
        if (
          embeddingModel !== b.embeddingModel ||
          rerankModel !== b.rerankModel
        ) {
          if (
            await m.countBy(Document, {
              baseId: id,
              status: In(['pending', 'processing']),
            })
          )
            throw new ThreadError('KNOWLEDGE_BUSY', 409);
          await this.validateModels(embeddingModel, rerankModel);
          const total = await this.store.count(b, m);
          b.rebuild = {
            id: randomUUID(),
            status: 'pending',
            embeddingModel,
            rerankModel,
            name: input.name ?? b.name,
            description: input.description ?? b.description,
            enabled: input.enabled ?? b.enabled,
            completed: 0,
            total,
            error: null,
          };
        } else {
          Object.assign(b, input);
        }
        return this.summary(
          await m.save(Base, b),
          await this.acl.permissions(userId, b, m),
        );
      },
      'manage',
    );
  }
  remove(userId: string, id: string) {
    return this.mutate(
      userId,
      id,
      async (m, b) => {
        if (await m.countBy(Document, { baseId: id, status: 'processing' }))
          throw new ThreadError('KNOWLEDGE_BUSY', 409);
        const indexes = new Set(
          (b.retiredIndexes ?? []).map((entry) => entry.name),
        );
        if (b.vectorIndex) indexes.add(b.vectorIndex);
        if (b.rebuild?.indexName) indexes.add(b.rebuild.indexName);
        // DROP must share this transaction: the vector table has a document FK,
        // and a second connection would wait on our own document relation lock.
        for (const indexName of indexes)
          await m.query(`DROP TABLE IF EXISTS ${this.store.table(indexName)}`);
        await m.delete(Base, id);
      },
      'delete',
    );
  }
  async documents(
    userId: string,
    id: string,
    cursor?: KnowledgeCursor,
    tags: KnowledgeTags = {},
    archived = false,
    metadata: KnowledgeMetadata = {},
  ) {
    const { base } = await this.access(userId, id);
    const attributes = validateMetadata(base.fields, metadata);
    const q = this.database
      .getRepository(Document)
      .createQueryBuilder('d')
      .addSelect(
        `to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        'cursor_timestamp',
      )
      .where('d.base_id = :id', { id })
      .orderBy('d.created_at', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .take(21);
    q.andWhere(tagFilter(':tags'), {
      tags: JSON.stringify(knowledgeTagsSchema.parse(tags)),
    });
    q.andWhere('d.metadata @> :metadata::jsonb', {
      metadata: JSON.stringify(attributes),
    });
    if (archived) q.withDeleted().andWhere('d.deleted_at IS NOT NULL');
    if (cursor)
      q.andWhere(
        '(d.created_at, d.id) < (:createdAt::timestamptz, :cursorId)',
        { createdAt: cursor.createdAt, cursorId: cursor.id },
      );
    const { entities: rows, raw } = await q.getRawAndEntities();
    const last = rows.slice(0, 20).at(-1);
    return {
      documents: rows.slice(0, 20).map(documentSummary),
      hasMore: rows.length > 20,
      ...(last
        ? {
            nextCursor: {
              createdAt: String(
                raw[Math.min(rows.length, 20) - 1].cursor_timestamp,
              ),
              id: last.id,
            },
          }
        : {}),
    };
  }
  async statuses(userId: string, id: string, ids: string[]) {
    await this.access(userId, id);
    return (
      await this.database.manager.findBy(Document, { baseId: id, id: In(ids) })
    ).map(documentSummary);
  }
  import(
    userId: string,
    id: string,
    source: z.input<typeof knowledgeSourceSchema>,
    conversation?: { projectId?: string },
    displayName?: string,
    tags: KnowledgeTags = {},
    metadata: KnowledgeMetadata = {},
  ) {
    const input = knowledgeSourceSchema.parse(source);
    const parsedTags = knowledgeTagsSchema.parse(tags);
    const bytes =
      input.type === 'file'
        ? Buffer.from(input.data, 'base64')
        : Buffer.from(input.type === 'text' ? input.content : input.url);
    if (input.type === 'file') validateKnowledgeFile(input.name, bytes);
    return this.mutate(
      userId,
      id,
      async (m, base) => {
        const attributes = validateMetadata(
          base.fields,
          knowledgeMetadataSchema.parse(metadata),
        );
        const count = await m.countBy(Document, { baseId: id });
        if (count >= 1000) throw new ThreadError('KNOWLEDGE_LIMIT', 400);
        return documentSummary(
          await m.save(
            Document,
            m.create(Document, {
              id: randomUUID(),
              baseId: id,
              createdBy: userId,
              version: 1,
              versionCreatedBy: userId,
              versionCreatedAt: new Date(),
              tags: parsedTags,
              metadata: attributes,
              name:
                displayName ||
                input.name ||
                (input.type === 'url' ? new URL(input.url).hostname : ''),
              sourceType: input.type,
              sourceName: input.type === 'file' ? input.name : null,
              sourceUrl: input.type === 'url' ? input.url : null,
              sourceData: bytes,
              content: input.type === 'text' ? input.content : '',
              status: 'pending',
              enabled: true,
              chunkCount: 0,
              error: null,
            }),
          ),
        );
      },
      'documents',
      conversation,
    );
  }
  private async findDocument(
    id: string,
    manager = this.database.manager,
    withDeleted = false,
  ) {
    const doc = await manager.findOne(Document, { where: { id }, withDeleted });
    if (!doc) throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
    return doc;
  }
  async document(
    userId: string,
    id: string,
    includeImage = false,
  ): Promise<KnowledgeDocumentDetail> {
    const d = await this.findDocument(id, this.database.manager, true);
    const { base } = await this.access(userId, d.baseId);
    const readImage =
      includeImage &&
      d.sourceType === 'file' &&
      knowledgeImageFileAccept
        .split(',')
        .includes(extname(d.sourceName ?? d.name).toLowerCase());
    const detail = await this.database
      .getRepository(Document)
      .createQueryBuilder('d')
      .withDeleted()
      .addSelect(readImage ? ['d.content', 'd.sourceData'] : ['d.content'])
      .addSelect(
        "CASE WHEN d.source_type = 'text' AND d.content = '' THEN convert_from(d.source_data, 'UTF8') ELSE d.content END",
        'd_content',
      )
      .where('d.id = :id', { id })
      .getOneOrFail();
    const chunks =
      detail.status === 'ready'
        ? await this.store.chunks(base, {
            documentId: id,
            limit: 2000,
            includeArchived: true,
          })
        : [];
    let image: KnowledgeDocumentDetail['image'];
    if (readImage && detail.sourceType === 'file' && detail.sourceData) {
      const info = validateKnowledgeFile(
        detail.sourceName ?? detail.name,
        detail.sourceData,
      );
      if (info)
        image = {
          data: detail.sourceData.toString('base64'),
          mimeType: info.mimeType,
        };
    }
    return {
      ...documentSummary(detail),
      content: detail.content,
      chunks: chunks.map(({ id, text, position }) => ({ id, text, position })),
      ...(image ? { image } : {}),
    };
  }

  private async mutateDocument<T>(
    userId: string,
    id: string,
    action: (m: EntityManager, b: Base, d: Document) => Promise<T>,
    conversation?: { projectId?: string },
  ) {
    const d = await this.findDocument(id);
    return this.mutate(
      userId,
      d.baseId,
      async (m, b) => {
        const current = await this.findDocument(id, m);
        if (current.status === 'processing')
          throw new ThreadError('KNOWLEDGE_BUSY', 409);
        return action(m, b, current);
      },
      'documents',
      conversation,
    );
  }
  retry(userId: string, id: string, conversation?: { projectId?: string }) {
    return this.mutateDocument(
      userId,
      id,
      async (m, _b, d) => {
        d.status = 'pending';
        d.error = null;
        return documentSummary(await m.save(d));
      },
      conversation,
    );
  }
  updateDocument(
    userId: string,
    id: string,
    data: z.input<typeof knowledgeDocumentUpdateSchema>,
    conversation?: { projectId?: string },
  ) {
    const input = knowledgeDocumentUpdateSchema.parse(data);
    return this.mutateDocument(
      userId,
      id,
      async (m, base, doc) => {
        if (
          input.expectedVersion !== undefined &&
          doc.version !== input.expectedVersion
        )
          throw new ThreadError('KNOWLEDGE_VERSION_CONFLICT', 409);
        this.replaceDocument(doc, input);
        if (input.metadata !== undefined) {
          doc.metadata = {
            ...doc.metadata,
            ...validateMetadata(base.fields, input.metadata),
          };
          await this.store.updateMetadata(base, doc.id, doc.metadata, m);
        }
        return documentSummary(await m.save(Document, doc));
      },
      conversation,
    );
  }
  private replaceDocument(
    doc: Document,
    input: z.output<typeof knowledgeDocumentUpdateSchema>,
  ) {
    if (input.source) {
      const source = input.source;
      const bytes = Buffer.from(
        source.type === 'file'
          ? source.data
          : source.type === 'text'
            ? source.content
            : source.url,
        source.type === 'file' ? 'base64' : 'utf8',
      );
      if (source.type === 'file') validateKnowledgeFile(source.name, bytes);
      Object.assign(doc, {
        name:
          source.name ||
          (source.type === 'url' ? new URL(source.url).hostname : doc.name),
        sourceType: source.type,
        sourceName: source.type === 'file' ? source.name : null,
        sourceUrl: source.type === 'url' ? source.url : null,
        sourceData: bytes,
        content: source.type === 'text' ? source.content : '',
        chunkCount: 0,
        status: 'pending',
        error: null,
      });
    }
    if (input.name !== undefined) doc.name = input.name;
    if (input.tags !== undefined) doc.tags = input.tags;
  }
  createVersion(
    userId: string,
    id: string,
    data: z.input<typeof knowledgeVersionInputSchema>,
    conversation?: { projectId?: string },
  ) {
    const input = knowledgeVersionInputSchema.parse(data);
    return this.mutateDocument(
      userId,
      id,
      async (m, base, doc) => {
        if (doc.version !== input.expectedVersion)
          throw new ThreadError('KNOWLEDGE_VERSION_CONFLICT', 409);
        if (doc.status === 'pending')
          throw new ThreadError('KNOWLEDGE_BUSY', 409);
        const attributes =
          input.metadata !== undefined
            ? {
                ...doc.metadata,
                ...validateMetadata(base.fields, input.metadata),
              }
            : doc.metadata;
        await archiveVersion(m, doc);
        doc.metadata = attributes;
        this.replaceDocument(doc, input);
        doc.version += 1;
        doc.versionCreatedAt = new Date();
        doc.versionCreatedBy = userId;
        return documentSummary(await m.save(Document, doc));
      },
      conversation,
    );
  }
  async versions(userId: string, id: string, before?: number) {
    const doc = await this.findDocument(id, this.database.manager, true);
    await this.access(userId, doc.baseId);
    const q = this.database
      .getRepository(Version)
      .createQueryBuilder('v')
      .where('v.document_id = :id', { id })
      .orderBy('v.version', 'DESC')
      .take(21);
    if (before) q.andWhere('v.version < :before', { before });
    const rows = await q.getMany();
    const versions = [
      ...(!before ? [versionSummary(doc)] : []),
      ...rows.map(versionSummary),
    ];
    return {
      versions: versions.slice(0, 20),
      nextBefore: versions.length > 20 ? versions[19].version : undefined,
    };
  }
  private async readVersion(
    userId: string,
    id: string,
    version: number,
    file = false,
  ) {
    const doc = await this.findDocument(id, this.database.manager, true);
    await this.access(userId, doc.baseId);
    if (version === doc.version) {
      const current = await this.database
        .getRepository(Document)
        .createQueryBuilder('d')
        .withDeleted()
        .addSelect(file ? ['d.sourceData', 'd.content'] : ['d.content'])
        .where('d.id = :id AND d.version = :version', { id, version })
        .getOne();
      if (current) return current;
    }
    const archived = await this.database
      .getRepository(Version)
      .createQueryBuilder('v')
      .addSelect(file ? ['v.sourceData', 'v.content'] : ['v.content'])
      .where('v.document_id = :id AND v.version = :version', { id, version })
      .getOne();
    if (!archived) throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
    return archived;
  }
  async version(
    userId: string,
    id: string,
    version: number,
  ): Promise<KnowledgeVersionDetail> {
    const row = await this.readVersion(userId, id, version);
    return { ...versionSummary(row), content: row.content };
  }
  async versionFile(userId: string, id: string, version: number) {
    const row = await this.readVersion(userId, id, version, true);
    return {
      name:
        row.sourceName ??
        `${row.name}.${row.sourceType === 'url' ? 'url' : 'txt'}`,
      data: row.sourceData.toString('base64'),
    };
  }
  async tags(userId: string, id: string): Promise<KnowledgeTags> {
    await this.access(userId, id);
    const rows: { dimension: string; value: string }[] =
      await this.database.query(
        `SELECT DISTINCT t.key AS dimension, v.value FROM knowledge_documents d,
       LATERAL jsonb_each(d.tags) t, LATERAL jsonb_array_elements_text(t.value) v(value)
       WHERE d.base_id = $1 AND d.deleted_at IS NULL ORDER BY dimension, value`,
        [id],
      );
    const tags: KnowledgeTags = Object.create(null);
    for (const row of rows) (tags[row.dimension] ??= []).push(row.value);
    return tags;
  }
  restoreDocument(
    userId: string,
    id: string,
    conversation?: { projectId?: string },
  ) {
    return this.findDocument(id, this.database.manager, true).then((doc) =>
      this.mutate(
        userId,
        doc.baseId,
        async (m) => {
          const current = await this.findDocument(id, m, true);
          if (!current.deletedAt) return documentSummary(current);
          current.deletedAt = null;
          current.status = 'pending';
          current.error = null;
          return documentSummary(await m.save(Document, current));
        },
        'documents',
        conversation,
      ),
    );
  }
  setDocumentEnabled(userId: string, id: string, enabled: boolean) {
    return this.mutateDocument(userId, id, async (m, _b, d) => {
      d.enabled = enabled;
      return documentSummary(await m.save(d));
    });
  }
  removeDocument(
    userId: string,
    id: string,
    conversation?: { projectId?: string },
  ) {
    return this.mutateDocument(
      userId,
      id,
      async (m) => {
        await m.softDelete(Document, id);
      },
      conversation,
    );
  }
  async search(
    userId: string,
    id: string,
    query: string,
    topK = 6,
    tags: KnowledgeTags = {},
    metadata: KnowledgeMetadata = {},
    where?: string,
  ): Promise<KnowledgeHit[]> {
    const input = knowledgeSearchSchema.parse({
      query,
      topK,
      tags,
      metadata,
      where,
    });
    const { base } = await this.access(userId, id);
    if (!base.enabled) return [];
    validateMetadata(base.fields, input.metadata ?? {});
    return this.retrieve(
      userId,
      [base],
      input.query,
      input.topK,
      undefined,
      input.tags,
      input.metadata,
      input.where,
    );
  }

  private async *searchableChunks(
    bases: Base[],
    tags: KnowledgeTags,
    metadata: KnowledgeMetadata,
    where?: string,
  ) {
    for (const base of bases) {
      let after = '';
      while (true) {
        const chunks = await this.store.chunks(base, {
          after,
          readyOnly: true,
          tags,
          metadata,
          where,
        });
        if (!chunks.length) break;
        yield* chunks;
        after = chunks[chunks.length - 1]!.id;
      }
    }
  }
  private async vectorCandidates(
    base: Base,
    query: string,
    topK: number,
    deadline: number,
    tags: KnowledgeTags,
    metadata: KnowledgeMetadata,
    where?: string,
  ) {
    if (!base.embeddingModel || !base.vectorDimension)
      return { hits: [] as RankedChunk[], failed: false };
    const documents = await this.store.documentIds(base, {
      readyOnly: true,
      tags,
      metadata,
      where,
    });
    if (!documents.length) return { hits: [] as RankedChunk[], failed: false };
    if (Date.now() >= deadline)
      return { hits: [] as RankedChunk[], failed: true };
    try {
      const hits = await withSearchTimeout(
        async (signal) => {
          const { embedding } = await embed({
            model: await this.providers.getEmbeddingModel(base.embeddingModel!),
            value: query,
            abortSignal: signal,
            maxRetries: 0,
          });
          signal.throwIfAborted();
          return this.vectors.query({
            indexName: activeKnowledgeIndex(base),
            queryVector: embedding,
            topK,
            filter: { documentId: { $in: documents } },
          });
        },
        Math.max(1, deadline - Date.now()),
      );
      return {
        hits: hits.filter((hit) => Number.isFinite(hit.score)),
        failed: false,
      };
    } catch {
      // Only the vector stage degrades; database/authorization errors outside it propagate.
      return { hits: [] as RankedChunk[], failed: true };
    }
  }

  private async hydrateHits(
    userId: string,
    baseIds: string[],
    candidates: FusedChunk[] | KnowledgeHit[],
    projectId?: string,
    tags: KnowledgeTags = {},
    metadata: KnowledgeMetadata = {},
    where?: string,
  ): Promise<KnowledgeHit[]> {
    // Recheck membership and flags after remote calls, including after reranking.
    const enabled: Base[] = [];
    for (const id of baseIds) {
      try {
        const { base } = await this.access(userId, id);
        if (
          base.enabled &&
          (!projectId || this.inConversation(base, projectId))
        )
          enabled.push(base);
      } catch (error) {
        if (!(
          error instanceof ThreadError && error.code === 'KNOWLEDGE_NOT_FOUND'
        ))
          throw error;
      }
    }
    if (!enabled.length || !candidates.length) return [];
    const rows = (
      await Promise.all(
        enabled.map(async (base) =>
          (
            await this.store.chunks(base, {
              ids: candidates.map((c) => c.id),
              readyOnly: true,
              tags,
              metadata,
              where,
              limit: candidates.length,
            })
          ).map((c) => ({
            id: c.id,
            text: c.text,
            documentId: c.documentId,
            name: c.name,
            sourceUrl: c.sourceUrl,
            baseId: base.id,
            baseName: base.name,
            metadata: c.attributes,
            inputType: c.inputType,
          })),
        ),
      )
    ).flat();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return candidates.flatMap((candidate) => {
      const row = byId.get(candidate.id);
      return row ? [{ ...candidate, ...row }] : [];
    });
  }

  private async retrieve(
    userId: string,
    bases: Base[],
    query: string,
    topK: number,
    projectId?: string,
    tags: KnowledgeTags = {},
    metadata: KnowledgeMetadata = {},
    where?: string,
  ): Promise<KnowledgeHit[]> {
    if (!bases.length) return [];
    const baseIds = bases.map((base) => base.id);
    const candidateLimit = Math.min(400, Math.max(20, topK * 4));
    const vectorDeadline = Date.now() + 10_000;
    const [bm25, vectors] = await Promise.all([
      searchBM25(
        this.searchableChunks(bases, tags, metadata, where),
        query,
        candidateLimit,
      ),
      (async () => {
        const results: {
          baseId: string;
          embeddingModel: string | null;
          vectorDimension: number | null;
          hits: RankedChunk[];
          failed: boolean;
        }[] = [];
        for (let i = 0; i < bases.length; i += 3) {
          results.push(
            ...(await Promise.all(
              bases.slice(i, i + 3).map(async (base) => ({
                baseId: base.id,
                embeddingModel: base.embeddingModel,
                vectorDimension: base.vectorDimension,
                ...(await this.vectorCandidates(
                  base,
                  query,
                  candidateLimit,
                  vectorDeadline,
                  tags,
                  metadata,
                  where,
                )),
              })),
            )),
          );
        }
        return results;
      })(),
    ]);
    // One lexical corpus and one vector ranking per embedding space.
    // The same chunk receives one contribution from each matching recall route.
    const fused = fuseRanks([
      { mode: 'bm25', hits: bm25 },
      ...mergeVectorRanks(vectors, candidateLimit),
    ]);
    const failedBases = new Set(
      vectors.filter((v) => v.failed).map((v) => v.baseId),
    );
    const hits: KnowledgeHit[] = (
      await this.hydrateHits(
        userId,
        baseIds,
        fused,
        projectId,
        tags,
        metadata,
        where,
      )
    )
      .slice(0, candidateLimit)
      .map((hit) => ({
        ...hit,
        fallbacks: failedBases.has(hit.baseId) ? ['vector' as const] : [],
      }));
    if (!hits.length) return [];
    let ranked: KnowledgeHit[];
    try {
      ranked = await withSearchTimeout(async (signal) => {
        // A single base keeps its explicit model (including disabled reranking).
        // Cross-base searches need one model to score the entire candidate set.
        let model =
          bases.length === 1
            ? bases[0]!.rerankModel
            : (await this.providers.getDefaults()).rerankModel;
        if (bases.length > 1 && !model) {
          const models = new Set(
            bases.flatMap((base) =>
              base.rerankModel ? [base.rerankModel] : [],
            ),
          );
          if (models.size > 1)
            throw new Error('KNOWLEDGE_RERANK_MODEL_CONFLICT');
          model = models.values().next().value ?? null;
        }
        if (!model) return hits;
        if (hits.some((hit) => hit.inputType === 'image'))
          throw new Error('KNOWLEDGE_RERANK_IMAGE_UNSUPPORTED');
        return rerankKnowledge(
          hits,
          query,
          await this.providers.getRerankModel(model),
          signal,
        );
      }, KNOWLEDGE_RERANK_TIMEOUT_MS);
    } catch (error) {
      // Keep the complete recall order on any failure; never mix rerank scores
      // with recall RRF scores or partially boost successful knowledge bases.
      ranked = hits.map((hit) => ({
        ...hit,
        fallbacks: [...(hit.fallbacks ?? []), 'rerank' as const],
        fallbackReasons: { rerank: rerankFailureReason(error) },
      }));
    }
    return (
      await this.hydrateHits(
        userId,
        baseIds,
        ranked,
        projectId,
        tags,
        metadata,
        where,
      )
    ).slice(0, topK);
  }
  private inConversation(
    base: Pick<Base, 'scope' | 'projectId' | 'sharingMode'>,
    projectId?: string,
  ) {
    return projectId
      ? base.scope === 'project'
        ? base.projectId === projectId
        : base.sharingMode === 'all'
      : base.scope !== 'project';
  }
  async assertConversationAccess(
    userId: string,
    id: string,
    projectId?: string,
  ) {
    const access = await this.access(userId, id);
    if (!this.inConversation(access.base, projectId))
      throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
    return access;
  }
  async listContext(userId: string, projectId?: string) {
    const scopes: KnowledgeScope[] = [
      { scope: 'shared' },
      projectId ? { scope: 'project', projectId } : { scope: 'personal' },
    ];
    const lists = await Promise.all(
      scopes.map((scope) => this.list(userId, scope)),
    );
    return [
      ...new Map(
        lists
          .flatMap((list) => list.bases)
          .filter((base) => this.inConversation(base, projectId))
          .map((base) => [base.id, base]),
      ).values(),
    ];
  }
  async searchContext(
    userId: string,
    projectId: string | undefined,
    query: string,
    topK: number,
    tags: KnowledgeTags = {},
    metadata: KnowledgeMetadata = {},
    where?: string,
    sources?: string[],
  ) {
    const input = knowledgeSearchSchema.parse({
      query,
      topK,
      tags,
      metadata,
      where,
    });
    const records: Base[] = [];
    const available = await this.listContext(userId, projectId);
    const selected = sources?.length
      ? sources.map((source) => {
          const matches = available.filter(
            (b) => b.id === source || b.name === source,
          );
          const exact = matches.find((b) => b.id === source);
          if (exact) return exact;
          if (matches.length !== 1)
            throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
          return matches[0]!;
        })
      : available;
    for (const base of new Map(selected.map((b) => [b.id, b])).values()) {
      try {
        const current = (
          await this.assertConversationAccess(userId, base.id, projectId)
        ).base;
        if (current.enabled) records.push(current);
      } catch (error) {
        if (!(
          error instanceof ThreadError && error.code === 'KNOWLEDGE_NOT_FOUND'
        ))
          throw error;
      }
    }
    return this.retrieve(
      userId,
      records,
      input.query,
      input.topK,
      projectId,
      input.tags,
      input.metadata,
      input.where,
    );
  }
}
