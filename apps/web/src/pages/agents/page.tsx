import { LocalAgentsManager } from '@/components/local-agents/manager';

export function PersonalAgentsPage() {
  return <LocalAgentsManager scope={{ scope: 'personal' }} />;
}
