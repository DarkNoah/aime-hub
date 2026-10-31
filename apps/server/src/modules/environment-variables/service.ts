import { randomUUID } from 'node:crypto';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { EnvironmentVariable } from '@aime/db';
import type {
  EnvironmentVariable as EnvironmentVariableDto,
  EnvironmentVariableInput,
  EnvironmentVariableUpdate,
} from '@aime/shared/environment-variables';
import { EnvironmentVariableError } from './errors.js';

function toDto(row: EnvironmentVariable): EnvironmentVariableDto {
  return {
    id: row.id,
    name: row.name,
    value: row.value,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function writeError(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505'
  )
    throw new EnvironmentVariableError('ENVIRONMENT_VARIABLE_CONFLICT', 409);
  throw error;
}

export type EnvironmentVariableScope = string | { projectId: string };

function scopeWhere(scope?: EnvironmentVariableScope) {
  return {
    userId: typeof scope === 'string' ? scope : IsNull(),
    projectId: typeof scope === 'object' ? scope.projectId : IsNull(),
  };
}

export class EnvironmentVariableService {
  constructor(private readonly database: DataSource | EntityManager) {}

  private get repository() {
    return this.database.getRepository(EnvironmentVariable);
  }

  // Every CRUD query is scoped, including administrator reads (global only).
  private query(scope?: EnvironmentVariableScope) {
    return this.repository
      .createQueryBuilder('variable')
      .addSelect('variable.value')
      .where(scopeWhere(scope));
  }

  async list(
    scope?: EnvironmentVariableScope,
  ): Promise<EnvironmentVariableDto[]> {
    return (
      await this.query(scope).orderBy('variable.name', 'ASC').getMany()
    ).map(toDto);
  }

  async getEnv(
    userId?: string,
    projectId?: string,
  ): Promise<Record<string, string>> {
    const query = this.query().select([
      'variable.name',
      'variable.value',
      'variable.userId',
      'variable.projectId',
    ]);
    if (userId !== undefined) query.orWhere(scopeWhere(userId));
    if (projectId !== undefined)
      query.orWhere(
        `variable.projectId = :projectId AND EXISTS (
        SELECT 1 FROM projects project WHERE project.id = :projectId AND project.deleted_at IS NULL
      )`,
        { projectId },
      );
    // Global < personal < project. Explicit empty strings also override.
    const rows = await query
      .orderBy('variable.projectId', 'ASC', 'NULLS FIRST')
      .addOrderBy('variable.userId', 'ASC', 'NULLS FIRST')
      .getMany();
    return Object.fromEntries(rows.map(({ name, value }) => [name, value]));
  }

  async get(
    id: string,
    scope?: EnvironmentVariableScope,
  ): Promise<EnvironmentVariableDto> {
    const row = await this.query(scope)
      .andWhere('variable.id = :id', { id })
      .getOne();
    if (!row)
      throw new EnvironmentVariableError('ENVIRONMENT_VARIABLE_NOT_FOUND', 404);
    return toDto(row);
  }

  async create(
    input: EnvironmentVariableInput,
    scope?: EnvironmentVariableScope,
  ): Promise<EnvironmentVariableDto> {
    try {
      const row = await this.repository.save(
        this.repository.create({
          ...input,
          userId: typeof scope === 'string' ? scope : null,
          projectId: typeof scope === 'object' ? scope.projectId : null,
          id: randomUUID(),
          description: input.description ?? '',
        }),
      );
      return toDto(row);
    } catch (error) {
      writeError(error);
    }
  }

  async update(
    id: string,
    input: EnvironmentVariableUpdate,
    scope?: EnvironmentVariableScope,
  ): Promise<EnvironmentVariableDto> {
    try {
      const result = await this.repository.update(
        { id, ...scopeWhere(scope) },
        input,
      );
      if (!result.affected)
        throw new EnvironmentVariableError(
          'ENVIRONMENT_VARIABLE_NOT_FOUND',
          404,
        );
      return await this.get(id, scope);
    } catch (error) {
      writeError(error);
    }
  }

  async remove(id: string, scope?: EnvironmentVariableScope): Promise<void> {
    const result = await this.repository.delete({
      id,
      ...scopeWhere(scope),
    });
    if (!result.affected)
      throw new EnvironmentVariableError('ENVIRONMENT_VARIABLE_NOT_FOUND', 404);
  }
}
