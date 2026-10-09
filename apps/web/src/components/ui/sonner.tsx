import { useTranslation } from 'react-i18next';
import { Toaster as Sonner } from 'sonner';
import { useTheme } from '@/components/theme/context';

export function Toaster() {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      position="top-center"
      richColors
      closeButton
      containerAriaLabel={t('common.notifications')}
      style={{ fontFamily: 'var(--font-sans)' }}
      toastOptions={{ closeButtonAriaLabel: t('common.close') }}
    />
  );
}
