import { useEffect, useId, useState } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MemberProfile } from '@aime/shared/group-chats';
import { MemberAvatar } from '@/components/member-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  groupChatApi,
  groupChatErrorKey,
  type GroupChatErrorKey,
} from '../api';

export function RoomMemberEditor({
  roomId,
  projectId,
  onAdded,
  onClose,
}: {
  roomId: string;
  projectId?: string;
  onAdded: (member: MemberProfile) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    users: MemberProfile[];
    error?: GroupChatErrorKey;
  } | null>(null);
  const [selected, setSelected] = useState<MemberProfile | null>(null);
  const [pending, setPending] = useState(false);
  const search = query.trim();
  useEffect(() => {
    if (search.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void groupChatApi
        .searchUsers(roomId, search, controller.signal)
        .then((users) => {
          if (!controller.signal.aborted) setResult({ query: search, users });
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setResult({
              query: search,
              users: [],
              error: groupChatErrorKey(cause),
            });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [roomId, search, revision]);
  const current = result?.query === search ? result : null;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || pending) return;
    setPending(true);
    try {
      onAdded(await groupChatApi.addMember(roomId, selected.id));
      toast.success(t('groupChat.memberAdded'));
      onClose();
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{t('groupChat.addMember')}</DialogTitle>
          <DialogDescription>
            {t(
              projectId
                ? 'groupChat.addProjectMemberHint'
                : 'groupChat.addPersonalMemberHint',
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="min-h-0" onSubmit={(event) => void save(event)}>
          <div className="space-y-2 px-6 py-4">
            <Label htmlFor={id}>{t('groupChat.searchMembers')}</Label>
            <Input
              id={id}
              autoComplete="off"
              value={query}
              disabled={pending}
              placeholder={t('groupChat.searchMembersHint')}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(null);
              }}
            />
          </div>
          <ScrollArea
            viewportProps={{ className: 'max-h-[40dvh] [&>div]:block!' }}
          >
            <div className="px-6 pb-4">
              {search.length < 2 ? (
                <p className="text-sm text-muted-foreground">
                  {t('groupChat.searchMembersHint')}
                </p>
              ) : !current ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('groupChat.searchingMembers')}
                </p>
              ) : current.error ? (
                <div role="alert" className="space-y-2">
                  <p className="text-sm text-destructive">{t(current.error)}</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setResult(null);
                      setRevision((value) => value + 1);
                    }}
                  >
                    {t('chat.retry')}
                  </Button>
                </div>
              ) : current.users.length ? (
                <ul
                  className="space-y-1"
                  aria-label={t('groupChat.searchResults')}
                >
                  {current.users.map((member) => (
                    <li key={member.id}>
                      <Button
                        type="button"
                        variant={
                          selected?.id === member.id ? 'secondary' : 'ghost'
                        }
                        className="h-auto w-full justify-start gap-3 px-2 py-3 text-left"
                        disabled={pending}
                        aria-pressed={selected?.id === member.id}
                        onClick={() => setSelected(member)}
                      >
                        <MemberAvatar
                          member={member}
                          label={
                            member.name ||
                            member.username ||
                            t('groupChat.unknownMember')
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {member.name || member.username}
                          </span>
                          {member.username && (
                            <span className="block truncate text-xs font-normal text-muted-foreground">
                              @{member.username}
                            </span>
                          )}
                        </span>
                        {selected?.id === member.id && (
                          <Check
                            className="size-4 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('groupChat.noMemberResults')}
                </p>
              )}
            </div>
          </ScrollArea>
          <DialogFooter className="border-t px-6 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('agents.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !selected}>
              {t(pending ? 'groupChat.addingMember' : 'groupChat.addMember')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
