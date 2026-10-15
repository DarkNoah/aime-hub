import type { EntityManager } from 'typeorm';
import {
  KnowledgeDocumentRecord as Document,
  KnowledgeDocumentVersion as Version,
} from '@aime/db';
import type { KnowledgeVersion } from '@aime/shared/knowledge';

export function versionSummary(d: Document | Version): KnowledgeVersion {
  const current = d instanceof Document;
  return {
    version: d.version,
    name: d.name,
    sourceType: d.sourceType,
    sourceUrl: d.sourceUrl,
    status: d.status,
    tags: d.tags,
    metadata: d.metadata,
    createdAt: (current ? d.versionCreatedAt : d.createdAt).toISOString(),
    createdBy: current ? d.versionCreatedBy : d.createdBy,
    isCurrent: current,
  };
}

export async function archiveVersion(m: EntityManager, d: Document) {
  const source = await m
    .getRepository(Document)
    .createQueryBuilder('d')
    .addSelect(['d.sourceData', 'd.content'])
    .where('d.id = :id', { id: d.id })
    .getOneOrFail();
  await m.query(
    `INSERT INTO knowledge_document_versions (document_id, version, name, source_type, source_name, source_url, source_data, content, tags, metadata, status, created_at, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
    [
      d.id,
      d.version,
      d.name,
      d.sourceType,
      d.sourceName,
      d.sourceUrl,
      source.sourceData,
      source.content ||
        (d.sourceType === 'text' ? source.sourceData.toString('utf8') : ''),
      JSON.stringify(d.tags),
      JSON.stringify(d.metadata),
      d.status,
      d.versionCreatedAt,
      d.versionCreatedBy,
    ],
  );
}
