import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

abstract class ProviderTimestamps {
  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}

@Entity('providers')
export class Provider extends ProviderTimestamps {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'providers_pkey' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  type!: string;

  @Column({ name: 'base_url', type: 'text' })
  baseUrl!: string;

  @Column({ name: 'api_key', type: 'text', nullable: true, select: false })
  apiKey!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;
}

@Entity('provider_models')
export class ProviderModel extends ProviderTimestamps {
  @PrimaryColumn({
    name: 'provider_id',
    type: 'text',
    primaryKeyConstraintName: 'provider_models_pkey',
  })
  providerId!: string;

  @PrimaryColumn({
    type: 'text',
    primaryKeyConstraintName: 'provider_models_pkey',
  })
  id!: string;

  @ManyToOne(() => Provider, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'provider_id',
    foreignKeyConstraintName: 'provider_models_provider_id_fkey',
  })
  provider!: Provider;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'boolean', nullable: true, default: null })
  deprecated!: boolean | null;

  @Column({ name: 'pass_test', type: 'boolean', nullable: true, default: null })
  passTest!: boolean | null;

  @Column({
    name: 'modalities_input',
    type: 'text',
    array: true,
    default: ['text'],
  })
  modalitiesInput!: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>;

  @Column({
    name: 'modalities_output',
    type: 'text',
    array: true,
    default: ['text'],
  })
  modalitiesOutput!: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>;

  @Column({ type: 'boolean', default: false })
  reasoning!: boolean;

  @Column({ name: 'tool_call', type: 'boolean', default: false })
  toolCall!: boolean;

  @Column({ name: 'limit_context', type: 'integer', nullable: true })
  limitContext!: number | null;

  @Column({ name: 'limit_output', type: 'integer', nullable: true })
  limitOutput!: number | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;
}

@Entity('settings')
export class Setting extends ProviderTimestamps {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'settings_pkey' })
  id!: string;

  @Column({ type: 'jsonb' })
  value!: unknown;
}
