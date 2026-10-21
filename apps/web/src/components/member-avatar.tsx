import type { MemberProfile } from '@aime/shared/group-chats';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export function MemberAvatar({
  member,
  label,
  size = 'default',
}: {
  member?: MemberProfile;
  label: string;
  size?: 'sm' | 'default';
}) {
  return (
    <Avatar size={size} title={label} aria-label={label}>
      {member?.image && <AvatarImage src={member.image} alt="" />}
      <AvatarFallback>{label.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
