import { ProjectEnvironmentVariables1780000037000 } from './migrations/1780000037000-project-environment-variables.js';
import { IssueSourceThread1780000036000 } from './migrations/1780000036000-issue-source-thread.js';
import { CreateIssues1780000035000 } from './migrations/1780000035000-create-issues.js';
import { GroupChatA2aCard1780000033000 } from './migrations/1780000033000-group-chat-a2a-card.js';
import { GroupChatReads1780000032000 } from './migrations/1780000032000-group-chat-reads.js';
import { GroupChatMembers1780000027000 } from './migrations/1780000027000-group-chat-members.js';
import { GroupChatA2aMembers1780000030000 } from './migrations/1780000030000-group-chat-a2a-members.js';
import { GroupChatA2aMemberDeletion1780000031000 } from './migrations/1780000031000-group-chat-a2a-member-deletion.js';
import { GroupChatIdleWake1780000029000 } from './migrations/1780000029000-group-chat-idle-wake.js';
import { GroupChatAgents1780000026000 } from './migrations/1780000026000-group-chat-agents.js';
import { CreateGroupChats1780000024000 } from './migrations/1780000024000-create-group-chats.js';
import {
  KnowledgeBaseRecord,
  KnowledgeDocumentRecord,
  KnowledgeBaseMember,
  KnowledgeDocumentVersion,
} from './knowledge-entities.js';
import { CreateKnowledge1780000015000 } from './migrations/1780000015000-create-knowledge.js';
import { KnowledgeModelRebuild1780000016000 } from './migrations/1780000016000-knowledge-model-rebuild.js';
import { KnowledgeSharing1780000017000 } from './migrations/1780000017000-knowledge-sharing.js';
import { KnowledgeDocumentVersions1780000018000 } from './migrations/1780000018000-knowledge-document-versions.js';
import { KnowledgeUnifiedVectors1780000019000 } from './migrations/1780000019000-knowledge-unified-vectors.js';
import { KnowledgeDocumentMetadata1780000021000 } from './migrations/1780000021000-knowledge-document-metadata.js';
export type { KnowledgeRebuildJob } from './knowledge-entities.js';
export {
  KnowledgeBaseRecord,
  KnowledgeDocumentRecord,
  KnowledgeBaseMember,
  KnowledgeDocumentVersion,
};
import 'reflect-metadata';
import { DataSource, type EntitySchema } from 'typeorm';
import { CreatePluginTables1780000014000 } from './migrations/1780000014000-create-plugin-tables.js';
import { PluginConfiguration1780000022000 } from './migrations/1780000022000-plugin-configuration.js';
import { PluginAccess1780000025000 } from './migrations/1780000025000-plugin-access.js';
import { CreateProviderTables1780000001000 } from './migrations/1780000001000-create-provider-tables.js';
import { Provider, ProviderModel, Setting } from './provider-entities.js';
import { Project, ProjectMember } from './project-entities.js';
import { CreateProjectTables1780000002000 } from './migrations/1780000002000-create-project-tables.js';
import { ProjectListState1780000003000 } from './migrations/1780000003000-project-list-state.js';
import { EnvironmentVariable } from './environment-variable-entity.js';
import { UserEnvironmentVariables1780000028000 } from './migrations/1780000028000-user-environment-variables.js';
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

import { CreateUsageRecords1780000012000 } from './migrations/1780000012000-create-usage-records.js';
import { ProviderModelType1780000013000 } from './migrations/1780000013000-provider-model-type.js';
import { ProviderOcrModel1780000020000 } from './migrations/1780000020000-provider-ocr-model.js';
import { ProviderAsrModel1780000023000 } from './migrations/1780000023000-provider-asr-model.js';

import { UsageRecord } from './usage-entity.js';
export { UsageRecord };

export { GeneratedAsset };

export { EnvironmentVariable };
export { ChatRequestLog };

export { Provider, ProviderModel, Setting, Project, ProjectMember };
export { CreateProjectTables1780000002000 };
export { CreateProviderTables1780000001000 };

export function createDataSource(
  databaseUrl: string,
  pluginEntities: EntitySchema[] = [],
): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [
      KnowledgeBaseRecord,
      KnowledgeDocumentRecord,
      KnowledgeBaseMember,
      KnowledgeDocumentVersion,
      ...pluginEntities,
      Provider,
      ProviderModel,
      Setting,
      Project,
      ProjectMember,
      EnvironmentVariable,
      ChatRequestLog,
      UsageRecord,
      GeneratedAsset,
    ],
    migrations: [
      ProjectEnvironmentVariables1780000037000,
      IssueSourceThread1780000036000,
      CreateIssues1780000035000,
      GroupChatA2aCard1780000033000,
      GroupChatReads1780000032000,
      GroupChatA2aMemberDeletion1780000031000,
      GroupChatA2aMembers1780000030000,
      GroupChatIdleWake1780000029000,
      UserEnvironmentVariables1780000028000,
      GroupChatMembers1780000027000,
      GroupChatAgents1780000026000,
      PluginAccess1780000025000,
      CreateGroupChats1780000024000,
      ProviderAsrModel1780000023000,
      PluginConfiguration1780000022000,
      KnowledgeDocumentMetadata1780000021000,
      KnowledgeUnifiedVectors1780000019000,
      KnowledgeDocumentVersions1780000018000,
      KnowledgeSharing1780000017000,
      KnowledgeModelRebuild1780000016000,
      CreateKnowledge1780000015000,
      CreatePluginTables1780000014000,
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
      CreateUsageRecords1780000012000,
      ProviderModelType1780000013000,
      ProviderOcrModel1780000020000,
    ],
    synchronize: false,
    migrationsRun: false,
  });
}
