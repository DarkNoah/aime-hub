import { useTranslation } from 'react-i18next';
import type { AvailableAgent } from '@aime/shared/agents';
import { AgentMultiSelect } from '@/components/agent-selector/multi-select';
import { updateSubagentSelection } from '../subagent-selection';

export function SubagentsEditor({
  value,
  onChange,
  agents,
  disabled,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  agents: AvailableAgent[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">
        {t('agents.subagentsHint')}
      </p>
      <AgentMultiSelect
        value={[...new Set(Object.values(value))]}
        onValueChange={(ids) => onChange(updateSubagentSelection(value, ids))}
        agents={agents}
        label={t('agents.selectSubagents')}
        disabled={disabled}
      />
    </section>
  );
}
