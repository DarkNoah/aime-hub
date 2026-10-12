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
import { AddRequestLogContext1780000006000 } from './migrations/1780000006000-add-request-log-context.js';
import { AddRequestLogResponse1780000007000 } from './migrations/1780000007000-add-request-log-response.js';
import { AddNotifications1780000008000 } from './migrations/1780000008000-add-notifications.js';
import { GeneratedAsset } from './generated-asset-entity.js';
import { CreateGeneratedAssets1780000009000 } from './migrations/1780000009000-create-generated-assets.js';
import { AddGeneratedAssetCreator1780000010000 } from './migrations/1780000010000-add-generated-asset-creator.js';
import { AddGeneratedAssetMetadata1780000011000 } from './migrations/1780000011000-add-generated-asset-metadata.js';

export { GeneratedAsset };

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
      GeneratedAsset,
    ],
    migrations: [
      CreateProviderTables1780000001000,
      CreateProjectTables1780000002000,
      ProjectListState1780000003000,
      CreateEnvironmentVariables1780000004000,
      CreateChatRequestLogs1780000005000,
      AddRequestLogContext1780000006000,
      AddRequestLogResponse1780000007000,
      AddNotifications1780000008000,
      CreateGeneratedAssets1780000009000,
      AddGeneratedAssetCreator1780000010000,
      AddGeneratedAssetMetadata1780000011000,
    ],
    synchronize: false,
    migrationsRun: false,
  });
}
