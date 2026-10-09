import type { RequestLogSummary } from '@aime/shared/request-logs';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

export function RequestStatusBadge({
  status,
}: Pick<RequestLogSummary, 'status'>) {
  const { t } = useTranslation();
  return (
    <Badge
      variant={status === 'complete' ? 'secondary' : 'destructive'}
      className="shrink-0"
    >
      {t(
        status === 'complete'
          ? 'requestLogs.complete'
          : 'requestLogs.incomplete',
      )}
    </Badge>
  );
}
