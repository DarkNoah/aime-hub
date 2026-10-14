import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
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

  // Values are selected explicitly for administrator reads and command execution.
  private query() {
    return this.repository
      .createQueryBuilder('variable')
      .addSelect('variable.value');
  }

  async list(): Promise<EnvironmentVariableDto[]> {
    return (await this.query().orderBy('variable.name', 'ASC').getMany()).map(
      toDto,
    );
  }

  async getEnv(): Promise<Record<string, string>> {
    const rows = await this.repository
      .createQueryBuilder('variable')
      .select(['variable.name', 'variable.value'])
      .getMany();
    return Object.fromEntries(rows.map(({ name, value }) => [name, value]));
  }

  async get(id: string): Promise<EnvironmentVariableDto> {
    const row = await this.query().where('variable.id = :id', { id }).getOne();
    if (!row)
      throw new EnvironmentVariableError('ENVIRONMENT_VARIABLE_NOT_FOUND', 404);
    return toDto(row);
  }

  async create(
    input: EnvironmentVariableInput,
  ): Promise<EnvironmentVariableDto> {
    try {
      const row = await this.repository.save(
        this.repository.create({
          ...input,
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
  ): Promise<EnvironmentVariableDto> {
    try {
      const result = await this.repository.update(id, input);
      if (!result.affected)
        throw new EnvironmentVariableError(
          'ENVIRONMENT_VARIABLE_NOT_FOUND',
          404,
        );
      return await this.get(id);
    } catch (error) {
      writeError(error);
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.repository.delete(id);
    if (!result.affected)
      throw new EnvironmentVariableError('ENVIRONMENT_VARIABLE_NOT_FOUND', 404);
  }
}
