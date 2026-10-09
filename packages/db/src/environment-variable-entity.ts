import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('environment_variables')
@Unique('environment_variables_name_key', ['name'])
export class EnvironmentVariable {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'environment_variables_pkey',
  })
  id!: string;

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
