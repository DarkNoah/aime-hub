import { useTranslation } from 'react-i18next';
import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  const { t } = useTranslation();

  return (
    <Sonner
      position="top-center"
      richColors
      closeButton
      containerAriaLabel={t('common.notifications')}
      style={{ fontFamily: 'var(--font-sans)' }}
      toastOptions={{ closeButtonAriaLabel: t('common.close') }}
    />
  );
}
