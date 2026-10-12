import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

@Entity('generated_assets')
@Unique('generated_assets_source_key', ['resourceId', 'threadId', 'path'])
@Index('generated_assets_resource_created_idx', [
  'resourceId',
  'createdAt',
  'id',
])
@Index('generated_assets_thread_created_idx', ['threadId', 'createdAt', 'id'])
export class GeneratedAsset {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'thread_id', type: 'text' })
  threadId!: string;

  @Column({ name: 'resource_id', type: 'text' })
  resourceId!: string;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy!: string | null;

  @Column({ type: 'text' })
  path!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  kind!: 'image' | 'video' | 'audio' | 'file';

  @Column({ name: 'mime_type', type: 'text' })
  mimeType!: string;

  @Column({
    type: 'bigint',
    transformer: {
      to: (value: number) => value,
      from: (value: string) => Number(value),
    },
  })
  size!: number;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @Column({ name: 'tool_name', type: 'text' })
  toolName!: string;

  @Column({ name: 'tool_call_id', type: 'text', nullable: true })
  toolCallId!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    precision: 3,
    default: () => 'now()',
  })
  createdAt!: Date;
}
