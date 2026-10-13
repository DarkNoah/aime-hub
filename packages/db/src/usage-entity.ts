import 'reflect-metadata';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

const tokens = {
  type: 'bigint' as const,
  nullable: true,
  transformer: {
    to: (value: number | null) => value,
    from: (value: string | null) => (value === null ? null : Number(value)),
  },
};

@Entity('usage_records')
@Index('usage_records_created_idx', ['createdAt', 'id'])
@Index('usage_records_user_created_idx', ['userId', 'createdAt'])
@Index('usage_records_project_created_idx', ['projectId', 'createdAt'])
@Index('usage_records_model_created_idx', ['providerId', 'model', 'createdAt'])
export class UsageRecord {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'finished_at', type: 'timestamptz' }) finishedAt!: Date;
  @Column({ name: 'user_id', type: 'text' }) userId!: string;
  @Column({ name: 'project_id', type: 'text', nullable: true }) projectId!:
    string | null;
  @Column({ name: 'thread_id', type: 'text' }) threadId!: string;
  @Column({ name: 'run_id', type: 'text', nullable: true }) runId!:
    string | null;
  @Column({ name: 'agent_id', type: 'text', nullable: true }) agentId!:
    string | null;
  @Column({ name: 'step_number', type: 'integer' }) stepNumber!: number;
  @Column({ name: 'provider_id', type: 'text', nullable: true }) providerId!:
    string | null;
  @Column({ type: 'text' }) model!: string;
  @Column({ name: 'model_reference', type: 'text' }) modelReference!: string;
  @Column({ name: 'finish_reason', type: 'text', nullable: true })
  finishReason!: string | null;
  @Column({ name: 'duration_ms', type: 'double precision' })
  durationMs!: number;
  @Column({ ...tokens, name: 'input_tokens' }) inputTokens!: number | null;
  @Column({ ...tokens, name: 'output_tokens' }) outputTokens!: number | null;
  @Column({ ...tokens, name: 'total_tokens' }) totalTokens!: number | null;
  @Column({ ...tokens, name: 'cached_input_tokens' }) cachedInputTokens!:
    number | null;
  @Column({ ...tokens, name: 'cache_creation_input_tokens' })
  cacheCreationInputTokens!: number | null;
  @Column({ ...tokens, name: 'reasoning_tokens' }) reasoningTokens!:
    number | null;
}
