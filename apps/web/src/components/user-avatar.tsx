import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export function UserAvatar({
  name,
  image,
  className,
}: {
  name: string;
  image?: string | null;
  className?: string;
}) {
  return (
    <Avatar className={className} role="img" aria-label={name}>
      {image && <AvatarImage src={image} alt="" className="object-cover" />}
      <AvatarFallback>{Array.from(name)[0]?.toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
