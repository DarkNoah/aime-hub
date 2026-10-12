import { AutomationManager } from '@/components/automations/manager';

export function PersonalAutomationsPage() {
  return <AutomationManager scope={{ scope: 'personal' }} />;
}
