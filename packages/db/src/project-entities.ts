import 'reflect-metadata';
import {
  Column,
  Check,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

abstract class ProjectTimestamps {
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

@Entity('projects')
export class Project extends ProjectTimestamps {
  @PrimaryColumn({ type: 'text' })
  id!: string;
  @Column({ type: 'text' })
  name!: string;
  @Column({ name: 'created_by', type: 'text' })
  createdBy!: string;
  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;
}

@Entity('project_members')
@Check('project_members_role_check', "role IN ('owner', 'admin', 'member')")
@Index('project_members_owner', ['projectId'], {
  unique: true,
  where: "role = 'owner' AND deleted_at IS NULL",
})
@Index('project_members_user', ['userId', 'projectId'], {
  where: 'deleted_at IS NULL',
})
export class ProjectMember extends ProjectTimestamps {
  @PrimaryColumn({ name: 'project_id', type: 'text' })
  projectId!: string;
  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId!: string;
  @Column({ type: 'text' })
  role!: 'owner' | 'admin' | 'member';

  @ManyToOne(() => Project, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'project_id',
    foreignKeyConstraintName: 'project_members_project_id_fkey',
  })
  project!: Project;
}
