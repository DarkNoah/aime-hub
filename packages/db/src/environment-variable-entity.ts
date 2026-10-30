import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

@Entity('environment_variables')
@Index('environment_variables_global_name_key', ['name'], {
  unique: true,
  where: 'user_id IS NULL',
})
@Index('environment_variables_user_name_key', ['userId', 'name'], {
  unique: true,
  where: 'user_id IS NOT NULL',
})
export class EnvironmentVariable {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'environment_variables_pkey',
  })
  id!: string;

  @Column({ name: 'user_id', type: 'text', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'text', select: false })
  value!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

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
}
