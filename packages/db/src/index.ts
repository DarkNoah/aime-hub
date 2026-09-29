import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  AuthAccount,
  AuthSession,
  AuthUser,
  AuthVerification,
} from './entities.js';
import { CreateAuthTables1780000000000 } from './migrations/1780000000000-create-auth-tables.js';
import { CreateProviderTables1780000001000 } from './migrations/1780000001000-create-provider-tables.js';
import { Provider, ProviderModel, Setting } from './provider-entities.js';

export { AuthAccount, AuthSession, AuthUser, AuthVerification };
export { Provider, ProviderModel, Setting };
export { CreateAuthTables1780000000000, CreateProviderTables1780000001000 };

export function createDataSource(databaseUrl: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [
      AuthUser,
      AuthSession,
      AuthAccount,
      AuthVerification,
      Provider,
      ProviderModel,
      Setting,
    ],
    migrations: [
      CreateAuthTables1780000000000,
      CreateProviderTables1780000001000,
    ],
    synchronize: false,
    migrationsRun: false,
  });
}
