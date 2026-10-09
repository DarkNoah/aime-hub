import { useTranslation } from 'react-i18next';

export function PreviewLoading() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t('files.loading')}
      className="space-y-3 p-5 motion-safe:animate-pulse"
    >
      <div className="h-4 w-2/3 rounded bg-muted" />
      <div className="h-4 w-4/5 rounded bg-muted" />
      <div className="h-4 w-1/2 rounded bg-muted" />
    </div>
  );
}
