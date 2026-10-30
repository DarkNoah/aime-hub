import { Bot, Cable } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

export function RoomAgentAvatar({
  name,
  external = false,
  onMention,
}: {
  name: string;
  external?: boolean;
  onMention?: () => void;
}) {
  const { t } = useTranslation();
  const Icon = external ? Cable : Bot;
  const avatar = (
    <Avatar title={name} aria-label={onMention ? undefined : name}>
      <AvatarFallback className="bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </AvatarFallback>
    </Avatar>
  );
  return onMention ? (
    <button
      type="button"
      onClick={onMention}
      aria-label={t('groupChat.mentionNamed', { name })}
      title={t('groupChat.mentionNamed', { name })}
      className="h-fit shrink-0 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {avatar}
    </button>
  ) : (
    avatar
  );
}
