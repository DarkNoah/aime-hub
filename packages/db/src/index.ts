import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { CreateProviderTables1780000001000 } from './migrations/1780000001000-create-provider-tables.js';
import { Provider, ProviderModel, Setting } from './provider-entities.js';
import { Project, ProjectMember } from './project-entities.js';
import { CreateProjectTables1780000002000 } from './migrations/1780000002000-create-project-tables.js';

export { Provider, ProviderModel, Setting, Project, ProjectMember };
export { CreateProjectTables1780000002000 };
export { CreateProviderTables1780000001000 };

export function createDataSource(databaseUrl: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [Provider, ProviderModel, Setting, Project, ProjectMember],
    migrations: [
      CreateProviderTables1780000001000,
      CreateProjectTables1780000002000,
    ],
    synchronize: false,
    migrationsRun: false,
  });
}
