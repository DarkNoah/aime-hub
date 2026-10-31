import 'reflect-metadata';
import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Index,
  UpdateDateColumn,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { Project } from './project-entities.js';

@Entity('environment_variables')
@Index('environment_variables_global_name_key', ['name'], {
  unique: true,
  where: 'user_id IS NULL AND project_id IS NULL',
})
@Index('environment_variables_user_name_key', ['userId', 'name'], {
  unique: true,
  where: 'user_id IS NOT NULL AND project_id IS NULL',
})
@Index('environment_variables_project_name_key', ['projectId', 'name'], {
  unique: true,
  where: 'project_id IS NOT NULL',
})
@Check(
  'environment_variables_scope_check',
  'user_id IS NULL OR project_id IS NULL',
)
export class EnvironmentVariable {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'environment_variables_pkey',
  })
  id!: string;

  @Column({ name: 'user_id', type: 'text', nullable: true })
  userId!: string | null;

  @Column({ name: 'project_id', type: 'text', nullable: true })
  projectId!: string | null;

  @ManyToOne(() => Project, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'project_id',
    foreignKeyConstraintName: 'environment_variables_project_id_fkey',
  })
  project!: Project | null;

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
