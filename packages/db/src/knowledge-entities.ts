import 'reflect-metadata';
import type { KnowledgeField, KnowledgeMetadata } from '@aime/shared/knowledge';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  UpdateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';

export type KnowledgeRebuildJob = {
  id: string;
  status: 'pending' | 'processing' | 'failed';
  embeddingModel: string | null;
  rerankModel: string | null;
  name: string;
  description: string;
  enabled: boolean;
  completed: number;
  total: number;
  error: string | null;
  attempt?: string;
  indexName?: string;
};

@Entity('knowledge_bases')
export class KnowledgeBaseRecord {
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  fields!: KnowledgeField[];
  @PrimaryColumn({ type: 'text' }) id!: string;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'text', default: '' }) description!: string;
  @Column({ type: 'text' }) scope!: 'shared' | 'personal' | 'project';
  @Column({ name: 'owner_id', type: 'text' }) ownerId!: string;
  @Column({ name: 'sharing_mode', type: 'text', default: 'private' })
  sharingMode!: 'private' | 'all' | 'members';
  @Column({ name: 'shared_permission', type: 'text', default: 'read' })
  sharedPermission!: 'read' | 'edit';
  @Column({ name: 'project_id', type: 'text', nullable: true }) projectId!:
    string | null;
  @Column({ name: 'embedding_model', type: 'text', nullable: true })
  embeddingModel!: string | null;
  @Column({ name: 'rerank_model', type: 'text', nullable: true })
  rerankModel!: string | null;
  @Column({ name: 'vector_index', type: 'text', nullable: true })
  vectorIndex!: string | null;
  @Column({ type: 'jsonb', nullable: true })
  rebuild!: KnowledgeRebuildJob | null;
  @Column({
    name: 'retired_indexes',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  retiredIndexes!: { name: string; after: number }[];
  @Column({ name: 'vector_dimension', type: 'int', nullable: true })
  vectorDimension!: number | null;
  @Column({ type: 'boolean', default: true }) enabled!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('knowledge_base_members')
export class KnowledgeBaseMember {
  @PrimaryColumn({ name: 'base_id', type: 'text' }) baseId!: string;
  @PrimaryColumn({ name: 'user_id', type: 'text' }) userId!: string;
  @Column({ type: 'text' }) permission!: 'read' | 'edit';
}

@Entity('knowledge_documents')
export class KnowledgeDocumentRecord {
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: KnowledgeMetadata;
  @PrimaryColumn({ type: 'text' }) id!: string;
  @Column({ name: 'base_id', type: 'text' }) baseId!: string;
  @Column({ name: 'created_by', type: 'text' }) createdBy!: string;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'int', default: 1 }) version!: number;
  @Column({ name: 'version_created_at', type: 'timestamptz' })
  versionCreatedAt!: Date;
  @Column({ name: 'version_created_by', type: 'text' })
  versionCreatedBy!: string;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) tags!: Record<
    string,
    string[]
  >;
  @Column({ name: 'source_type', type: 'text' }) sourceType!:
    'text' | 'file' | 'url';
  @Column({ name: 'source_url', type: 'text', nullable: true }) sourceUrl!:
    string | null;
  @Column({ name: 'source_name', type: 'text', nullable: true }) sourceName!:
    string | null;
  @Column({ name: 'source_data', type: 'bytea', select: false })
  sourceData!: Buffer;
  @Column({ type: 'text', default: 'pending' }) status!:
    'pending' | 'processing' | 'ready' | 'failed';
  @Column({ type: 'boolean', default: true }) enabled!: boolean;
  @Column({ name: 'chunk_count', type: 'int', default: 0 }) chunkCount!: number;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'text', default: '', select: false }) content!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('knowledge_document_versions')
export class KnowledgeDocumentVersion {
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: KnowledgeMetadata;
  @PrimaryColumn({ name: 'document_id', type: 'text' }) documentId!: string;
  @PrimaryColumn({ type: 'int' }) version!: number;
  @Column({ type: 'text' }) name!: string;
  @Column({ name: 'source_type', type: 'text' }) sourceType!:
    'text' | 'file' | 'url';
  @Column({ name: 'source_name', type: 'text', nullable: true }) sourceName!:
    string | null;
  @Column({ name: 'source_url', type: 'text', nullable: true }) sourceUrl!:
    string | null;
  @Column({ name: 'source_data', type: 'bytea', select: false })
  sourceData!: Buffer;
  @Column({ type: 'text', select: false }) content!: string;
  @Column({ type: 'jsonb' }) tags!: Record<string, string[]>;
  @Column({ type: 'text' }) status!:
    'pending' | 'processing' | 'ready' | 'failed';
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'created_by', type: 'text' }) createdBy!: string;
}
