import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { CreateProviderTables1780000001000 } from './migrations/1780000001000-create-provider-tables.js';
import { Provider, ProviderModel, Setting } from './provider-entities.js';

export { Provider, ProviderModel, Setting };
export { CreateProviderTables1780000001000 };

export function createDataSource(databaseUrl: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [Provider, ProviderModel, Setting],
    migrations: [CreateProviderTables1780000001000],
    synchronize: false,
    migrationsRun: false,
  });
}
