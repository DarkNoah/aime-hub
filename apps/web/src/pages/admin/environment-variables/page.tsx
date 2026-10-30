import { EnvironmentVariablesManager } from '@/components/environment-variables/manager';
import { api } from '@/lib/rpc';

export function AdminEnvironmentVariablesPage() {
  return (
    <EnvironmentVariablesManager
      client={api.environmentVariables}
      description="admin.environmentVariablesDescription"
    />
  );
}
