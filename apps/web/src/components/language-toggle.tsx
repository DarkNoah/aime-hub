import { useSyncExternalStore } from 'react';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  getLanguagePreference,
  setLanguagePreference,
  subscribeLanguagePreference,
} from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function LanguageToggle() {
  const { t } = useTranslation();
  const preference = useSyncExternalStore(
    subscribeLanguagePreference,
    getLanguagePreference,
  );
  const label = t('language.change', {
    language:
      preference === 'system'
        ? t('language.system')
        : preference === 'zh-CN'
          ? '简体中文'
          : 'English',
  });

  async function selectLanguage(value: string) {
    if (value !== 'system' && value !== 'zh-CN' && value !== 'en') return;
    if (!(await setLanguagePreference(value))) {
      toast.error(t('language.saveFailed'));
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} title={label}>
          <Languages aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('language.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={selectLanguage}
        >
          <DropdownMenuRadioItem value="system">
            {t('language.system')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="zh-CN" lang="zh-CN">
            简体中文
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="en" lang="en">
            English
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
