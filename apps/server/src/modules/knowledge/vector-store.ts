import { customAlphabet } from 'nanoid';
import type { DataSource, EntityManager } from 'typeorm';
import type { PgVector } from '@mastra/pg';
import type { KnowledgeBaseRecord as Base } from '@aime/db';
import type {
  KnowledgeField,
  KnowledgeMetadata,
  KnowledgeTags,
} from '@aime/shared/knowledge';
import { compileKnowledgeFilter } from './filter.js';
import { tagFilter } from './tags.js';
import { fieldParameter, fieldTypes, validateMetadata } from './fields.js';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);
export const vectorTableName = (dimension: number) =>
  `knowledge_${nanoid()}_${dimension}`;
export function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}
export type StoredChunk = {
  id: string;
  documentId: string;
  position: number;
  text: string;
  version: number;
  attributes: KnowledgeMetadata;
  name: string;
  sourceUrl: string | null;
};

type ChunkOptions = {
  after?: string;
  limit?: number;
  ids?: string[];
  documentId?: string;
  readyOnly?: boolean;
  includeArchived?: boolean;
  tags?: KnowledgeTags;
  metadata?: KnowledgeMetadata;
  where?: string;
};

export class KnowledgeVectorStore {
  constructor(
    readonly database: DataSource,
    readonly vectors: PgVector,
  ) {}
  table(name: string) {
    if (!/^(knowledge_[a-z0-9]{16}_\d+|kb_[a-f0-9]+|kbv_[a-f0-9]+)$/.test(name))
      throw new Error('Invalid knowledge table');
    const schema =
      'schema' in this.database.options
        ? this.database.options.schema
        : undefined;
    return `${quoteIdentifier(typeof schema === 'string' ? schema : 'public')}.${quoteIdentifier(name)}`;
  }
  async create(name: string, dimension: number, fields: KnowledgeField[]) {
    const table = this.table(name);
    if (dimension)
      await this.vectors.createIndex({
        indexName: name,
        dimension,
        metric: 'cosine',
        vectorType:
          dimension > 2000 && dimension <= 4000 ? 'halfvec' : 'vector',
        buildIndex: dimension <= 4000,
        metadataIndexes: ['documentId'],
      });
    else {
      // Mastra requires a positive dimension. BM25-only stores have nullable, unbounded vectors.
      await this.database
        .query(`CREATE TABLE ${table} (id bigserial PRIMARY KEY, vector_id text NOT NULL,
        embedding vector, metadata jsonb DEFAULT '{}'::jsonb, namespace varchar(255) NOT NULL DEFAULT 'default', UNIQUE(namespace, vector_id))`);
    }
    const additions = [
      'document_id text REFERENCES knowledge_documents(id) ON DELETE CASCADE',
      'position integer',
      'chunk text',
      'document_version integer',
      ...fields.map(
        (field) => `${quoteIdentifier(field.name)} ${fieldTypes[field.type]}`,
      ),
    ];
    await this.database.query(
      `ALTER TABLE ${table} ${additions.map((column) => `ADD COLUMN ${column}`).join(', ')}`,
    );
    await this.database.query(
      `CREATE INDEX ${quoteIdentifier(name + '_document_idx')} ON ${table}(document_id)`,
    );
    for (const [i, field] of fields.entries())
      if (!['blob', 'json'].includes(field.type))
        await this.database.query(
          `CREATE INDEX ${quoteIdentifier(name + '_f' + i + '_idx')} ON ${table}(${quoteIdentifier(field.name)})`,
        );
    await this.database.query(
      `CREATE TRIGGER knowledge_vector_lock BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION knowledge_guard_vector()`,
    );
  }
  async stage(
    index: string,
    chunks: StoredChunk[],
    embeddings: number[][] | null,
  ) {
    if (embeddings)
      await this.vectors.upsert({
        indexName: index,
        ids: chunks.map((c) => c.id),
        vectors: embeddings,
        metadata: chunks.map((c) => ({ documentId: c.documentId })),
      });
    else
      await this.database.query(
        `INSERT INTO ${this.table(index)}(vector_id, metadata)
      SELECT x.id, jsonb_build_object('documentId', x."documentId") FROM jsonb_to_recordset($1::jsonb) AS x(id text, "documentId" text)`,
        [JSON.stringify(chunks)],
      );
  }
  async materialize(
    index: string,
    fields: KnowledgeField[],
    chunks: StoredChunk[],
    m = this.database.manager,
  ) {
    // One typed row per source chunk. Keep the original metadata on the document for edits/history.
    for (const chunk of chunks) {
      const values: unknown[] = [
        chunk.id,
        chunk.documentId,
        chunk.position,
        chunk.text,
        chunk.version,
        JSON.stringify({
          documentId: chunk.documentId,
          attributes: chunk.attributes,
        }),
      ];
      const extra = fields.map((field) => {
        values.push(fieldParameter(field, chunk.attributes[field.name]));
        return `${quoteIdentifier(field.name)} = $${values.length}`;
      });
      await m.query(
        `UPDATE ${this.table(index)} SET document_id=$2, position=$3, chunk=$4, document_version=$5, metadata=$6::jsonb${extra.length ? ', ' + extra.join(', ') : ''} WHERE vector_id=$1 AND namespace='default'`,
        values,
      );
    }
  }
  async updateMetadata(
    base: Base,
    documentId: string,
    attributes: KnowledgeMetadata,
    m: EntityManager,
  ) {
    if (!base.vectorIndex) return;
    const values: unknown[] = [
      documentId,
      JSON.stringify({ documentId, attributes }),
    ];
    const extra = base.fields.map((field) => {
      values.push(fieldParameter(field, attributes[field.name]));
      return `${quoteIdentifier(field.name)}=$${values.length}`;
    });
    await m.query(
      `UPDATE ${this.table(base.vectorIndex)} SET metadata=$2::jsonb${extra.length ? ', ' + extra.join(', ') : ''} WHERE document_id=$1`,
      values,
    );
  }
  private selection(base: Base, options: ChunkOptions) {
    const values: unknown[] = [base.id];
    const where = [
      'd.base_id=$1',
      "c.namespace='default'",
      'c.document_version=d.version',
    ];
    if (!options.includeArchived) where.push('d.deleted_at IS NULL');
    if (options.readyOnly) where.push("d.enabled AND d.status='ready'");
    if (options.after) {
      values.push(options.after);
      where.push(`c.vector_id > $${values.length}`);
    }
    if (options.ids) {
      values.push(options.ids);
      where.push(`c.vector_id = ANY($${values.length}::text[])`);
    }
    if (options.documentId) {
      values.push(options.documentId);
      where.push(`d.id=$${values.length}`);
    }
    if (options.tags) {
      values.push(JSON.stringify(options.tags));
      where.push(tagFilter(`$${values.length}`));
    }
    for (const [key, value] of Object.entries(options.metadata ?? {})) {
      const field = base.fields.find((f) => f.name === key);
      if (!field) {
        where.push('FALSE');
        continue;
      }
      const parsed = validateMetadata([field], { [key]: value })[key];
      values.push(fieldParameter(field, parsed));
      where.push(
        `c.${quoteIdentifier(key)} IS NOT DISTINCT FROM $${values.length}::${fieldTypes[field.type]}`,
      );
    }
    if (options.where)
      where.push(compileKnowledgeFilter(options.where, base.fields, values));
    return { values, where };
  }
  async documentIds(base: Base, options: ChunkOptions): Promise<string[]> {
    if (!base.vectorIndex) return [];
    const { values, where } = this.selection(base, options);
    const rows: { id: string }[] = await this.database.query(
      `SELECT DISTINCT c.document_id AS id FROM ${this.table(base.vectorIndex)} c
       JOIN knowledge_documents d ON d.id=c.document_id WHERE ${where.join(' AND ')}`,
      values,
    );
    return rows.map((r) => r.id);
  }
  async chunks(base: Base, options: ChunkOptions = {}): Promise<StoredChunk[]> {
    if (!base.vectorIndex) return [];
    const { values, where } = this.selection(base, options);
    values.push(options.limit ?? 500);
    return this.database.query(
      `SELECT c.vector_id AS id, c.document_id AS "documentId", c.position, c.chunk AS text, c.document_version AS version,
      d.metadata AS attributes, d.name, d.source_url AS "sourceUrl"
      FROM ${this.table(base.vectorIndex)} c JOIN knowledge_documents d ON d.id=c.document_id
      WHERE ${where.join(' AND ')} ORDER BY c.vector_id LIMIT $${values.length}`,
      values,
    );
  }
  async count(base: Base, m = this.database.manager): Promise<number> {
    if (!base.vectorIndex) return 0;
    const [row] = await m.query(
      `SELECT count(*)::int AS count FROM ${this.table(base.vectorIndex)} c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.base_id=$1 AND d.deleted_at IS NULL AND c.document_version=d.version`,
      [base.id],
    );
    return row.count;
  }
  async drop(name: string) {
    await this.vectors.deleteIndex({ indexName: name });
  }
}
