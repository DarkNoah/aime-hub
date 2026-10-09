import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { CreateProviderTables1780000001000 } from './migrations/1780000001000-create-provider-tables.js';
import { Provider, ProviderModel, Setting } from './provider-entities.js';
import { Project, ProjectMember } from './project-entities.js';
import { CreateProjectTables1780000002000 } from './migrations/1780000002000-create-project-tables.js';
import { ProjectListState1780000003000 } from './migrations/1780000003000-project-list-state.js';
import { EnvironmentVariable } from './environment-variable-entity.js';
import { CreateEnvironmentVariables1780000004000 } from './migrations/1780000004000-create-environment-variables.js';
import { ChatRequestLog } from './request-log-entity.js';
import { CreateChatRequestLogs1780000005000 } from './migrations/1780000005000-create-chat-request-logs.js';

export { EnvironmentVariable };
export { ChatRequestLog };

export { Provider, ProviderModel, Setting, Project, ProjectMember };
export { CreateProjectTables1780000002000 };
export { CreateProviderTables1780000001000 };

export function createDataSource(databaseUrl: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [
      Provider,
      ProviderModel,
      Setting,
      Project,
      ProjectMember,
      EnvironmentVariable,
      ChatRequestLog,
    ],
    migrations: [
      CreateProviderTables1780000001000,
      CreateProjectTables1780000002000,
      ProjectListState1780000003000,
      CreateEnvironmentVariables1780000004000,
      CreateChatRequestLogs1780000005000,
    ],
    synchronize: false,
    migrationsRun: false,
  });
}
