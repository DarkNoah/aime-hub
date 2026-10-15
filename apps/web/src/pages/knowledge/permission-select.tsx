import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
export function PermissionSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: 'read' | 'edit';
  onChange: (permission: 'read' | 'edit') => void;
  disabled: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="read">{t('knowledge.permission.read')}</SelectItem>
        <SelectItem value="edit">{t('knowledge.permission.edit')}</SelectItem>
      </SelectContent>
    </Select>
  );
}
