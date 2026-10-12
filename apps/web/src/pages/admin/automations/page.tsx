import { AutomationManager } from '@/components/automations/manager';

export function AdminAutomationsPage() {
  return <AutomationManager scope={{ scope: 'system' }} />;
}
