import 'reflect-metadata';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('chat_request_logs')
@Index('chat_request_logs_created_at_id_idx', ['createdAt', 'id'])
export class ChatRequestLog {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'text' })
  method!: string;

  @Column({ type: 'text' })
  url!: string;

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
}
