import 'reflect-metadata';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('chat_request_logs')
@Index('chat_request_logs_created_at_id_idx', ['createdAt', 'id'])
@Index('chat_request_logs_thread_id_created_at_id_idx', [
  'threadId',
  'createdAt',
  'id',
])
@Index('chat_request_logs_resource_id_created_at_id_idx', [
  'resourceId',
  'createdAt',
  'id',
])
@Index('chat_request_logs_user_id_created_at_id_idx', [
  'userId',
  'createdAt',
  'id',
])
@Index('chat_request_logs_project_id_created_at_id_idx', [
  'projectId',
  'createdAt',
  'id',
])
export class ChatRequestLog {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'text' })
  method!: string;

  @Column({ type: 'text' })
  url!: string;

  @Column({ name: 'thread_id', type: 'text', nullable: true })
  threadId!: string | null;

  @Column({ name: 'resource_id', type: 'text', nullable: true })
  resourceId!: string | null;

  @Column({ name: 'user_id', type: 'text', nullable: true })
  userId!: string | null;

  @Column({ name: 'project_id', type: 'text', nullable: true })
  projectId!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'boolean', nullable: true })
  stream!: boolean | null;

  @Column({ type: 'text' })
  status!: 'complete' | 'incomplete';

  @Column({ name: 'body_bytes', type: 'integer' })
  bodyBytes!: number;

  @Column({ type: 'text', select: false })
  body!: string;

  @Column({ name: 'duration_ms', type: 'double precision', nullable: true })
  durationMs!: number | null;

  @Column({ name: 'http_status', type: 'integer', nullable: true })
  httpStatus!: number | null;

  @Column({ name: 'response_status', type: 'text', nullable: true })
  responseStatus!: 'pending' | 'complete' | 'incomplete' | null;

  @Column({ name: 'response_content_type', type: 'text', nullable: true })
  responseContentType!: string | null;

  @Column({ name: 'response_content_encoding', type: 'text', nullable: true })
  responseContentEncoding!: string | null;

  @Column({ name: 'response_bytes', type: 'integer', nullable: true })
  responseBytes!: number | null;

  @Column({ name: 'response_body_encoding', type: 'text', nullable: true })
  responseBodyEncoding!: 'utf8' | 'base64' | null;

  @Column({
    name: 'response_body',
    type: 'text',
    nullable: true,
    select: false,
  })
  responseBody!: string | null;
}
