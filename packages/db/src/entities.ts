import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

abstract class AuthTimestamps {
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

  // Reserved schema field; Better Auth uses hard deletes, not TypeORM soft deletes.
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}

@Entity('users')
@Unique('users_email_unique', ['email'])
@Unique('users_username_unique', ['username'])
export class AuthUser extends AuthTimestamps {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'users_pkey' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ name: 'email_verified', type: 'boolean', default: false })
  emailVerified!: boolean;

  @Column({ type: 'text', nullable: true })
  image!: string | null;

  @Column({ type: 'text', nullable: true })
  username!: string | null;

  @Column({ name: 'display_username', type: 'text', nullable: true })
  displayUsername!: string | null;

  @Column({ type: 'text', default: 'user' })
  role!: string;

  @Column({ type: 'boolean', default: false })
  banned!: boolean;

  @Column({ name: 'ban_reason', type: 'text', nullable: true })
  banReason!: string | null;

  @Column({ name: 'ban_expires', type: 'timestamptz', nullable: true })
  banExpires!: Date | null;
}

@Entity('sessions')
@Unique('sessions_token_unique', ['token'])
@Index('sessions_user_id_idx', ['userId'])
export class AuthSession extends AuthTimestamps {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'sessions_pkey' })
  id!: string;

  @Column({ type: 'text' })
  token!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'ip_address', type: 'text', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'user_id', type: 'text' })
  userId!: string;

  @ManyToOne(() => AuthUser, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'sessions_user_id_fkey',
  })
  user!: AuthUser;

  @Column({ name: 'impersonated_by', type: 'text', nullable: true })
  impersonatedBy!: string | null;
}

@Entity('accounts')
@Unique('accounts_provider_id_account_id_unique', ['providerId', 'accountId'])
@Index('accounts_user_id_idx', ['userId'])
export class AuthAccount extends AuthTimestamps {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'accounts_pkey' })
  id!: string;

  @Column({ name: 'account_id', type: 'text' })
  accountId!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @Column({ name: 'user_id', type: 'text' })
  userId!: string;

  @ManyToOne(() => AuthUser, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'accounts_user_id_fkey',
  })
  user!: AuthUser;

  @Column({ name: 'access_token', type: 'text', nullable: true })
  accessToken!: string | null;

  @Column({ name: 'refresh_token', type: 'text', nullable: true })
  refreshToken!: string | null;

  @Column({ name: 'id_token', type: 'text', nullable: true })
  idToken!: string | null;

  @Column({
    name: 'access_token_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  accessTokenExpiresAt!: Date | null;

  @Column({
    name: 'refresh_token_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  refreshTokenExpiresAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  scope!: string | null;

  @Column({ type: 'text', nullable: true })
  password!: string | null;
}

@Entity('verifications')
@Index('verifications_identifier_idx', ['identifier'])
export class AuthVerification extends AuthTimestamps {
  @PrimaryColumn({
    type: 'text',
    primaryKeyConstraintName: 'verifications_pkey',
  })
  id!: string;

  @Column({ type: 'text' })
  identifier!: string;

  @Column({ type: 'text' })
  value!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
