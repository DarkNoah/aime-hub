import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

export function PasswordInput({
  disabled,
  groupClassName,
  showLabel,
  hideLabel,
  ...props
}: Omit<ComponentProps<typeof InputGroupInput>, 'type'> & {
  groupClassName?: string;
  showLabel?: string;
  hideLabel?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const toggleLabel = visible
    ? (hideLabel ?? t('auth.hidePassword'))
    : (showLabel ?? t('auth.showPassword'));

  return (
    <InputGroup className={groupClassName} data-disabled={disabled}>
      <InputGroupInput
        {...props}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-sm"
          disabled={disabled}
          onClick={() => setVisible((value) => !value)}
          aria-label={toggleLabel}
          aria-pressed={visible}
          aria-controls={props.id}
          title={toggleLabel}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
