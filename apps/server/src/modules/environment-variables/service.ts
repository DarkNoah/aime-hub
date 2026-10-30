import { randomUUID } from 'node:crypto';
import { IsNull, type DataSource } from 'typeorm';
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

export class EnvironmentVariableService {
  constructor(private readonly database: DataSource) {}

  private get repository() {
    return this.database.getRepository(EnvironmentVariable);
  }

  // Every CRUD query is scoped, including administrator reads (global only).
  private query(userId?: string) {
    return this.repository
      .createQueryBuilder('variable')
      .addSelect('variable.value')
      .where(
        userId === undefined
          ? 'variable.userId IS NULL'
          : 'variable.userId = :userId',
        { userId },
      );
  }

  async list(userId?: string): Promise<EnvironmentVariableDto[]> {
    return (
      await this.query(userId).orderBy('variable.name', 'ASC').getMany()
    ).map(toDto);
  }

  async getEnv(userId?: string): Promise<Record<string, string>> {
    const query = this.query().select([
      'variable.name',
      'variable.value',
      'variable.userId',
    ]);
    if (userId !== undefined)
      query.orWhere('variable.userId = :userId', { userId });
    // Apply the user's values last, including an explicit empty string.
    const rows = await query
      .orderBy('variable.userId', 'ASC', 'NULLS FIRST')
      .getMany();
    return Object.fromEntries(rows.map(({ name, value }) => [name, value]));
  }

  async get(id: string, userId?: string): Promise<EnvironmentVariableDto> {
    const row = await this.query(userId)
      .andWhere('variable.id = :id', { id })
      .getOne();
    if (!row)
      throw new EnvironmentVariableError('ENVIRONMENT_VARIABLE_NOT_FOUND', 404);
    return toDto(row);
  }

  async create(
    input: EnvironmentVariableInput,
    userId?: string,
  ): Promise<EnvironmentVariableDto> {
    try {
      const row = await this.repository.save(
        this.repository.create({
          ...input,
          userId: userId ?? null,
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
    userId?: string,
  ): Promise<EnvironmentVariableDto> {
    try {
      const result = await this.repository.update(
        { id, userId: userId ?? IsNull() },
        input,
      );
      if (!result.affected)
        throw new EnvironmentVariableError(
          'ENVIRONMENT_VARIABLE_NOT_FOUND',
          404,
        );
      return await this.get(id, userId);
    } catch (error) {
      writeError(error);
    }
  }

  async remove(id: string, userId?: string): Promise<void> {
    const result = await this.repository.delete({
      id,
      userId: userId ?? IsNull(),
    });
    if (!result.affected)
      throw new EnvironmentVariableError('ENVIRONMENT_VARIABLE_NOT_FOUND', 404);
  }
}
