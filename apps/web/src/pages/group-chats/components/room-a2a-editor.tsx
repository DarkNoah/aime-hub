import { useId, useState } from 'react';
import { Copy, KeyRound, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { GroupChatA2AMember } from '@aime/shared/group-chats';
import { PasswordInput } from '@/components/password-input';
import { Badge } from '@/components/ui/badge';
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
import { groupChatApi, groupChatErrorKey } from '../api';

export function RoomA2aEditor({
  roomId,
  member,
  onSaved,
  onClose,
}: {
  roomId: string;
  member?: GroupChatA2AMember;
  onSaved: (member: GroupChatA2AMember) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(member?.name ?? '');
  const [pending, setPending] = useState(false);
  // This secret is held only by this mounted dialog and is never persisted.
  const [created, setCreated] = useState<{
    member: GroupChatA2AMember;
    apiKey: string;
  } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const current = created?.member ?? member;
  const endpoint = `${window.location.origin}/api/a2a/rooms/${roomId}`;
  const connections = [
    ['Agent Card', `${endpoint}/.well-known/agent-card.json`],
    ['A2A JSON-RPC', endpoint],
    [t('groupChat.a2a.history'), `${endpoint}/messages?after=0&limit=50`],
    [t('groupChat.a2a.events'), `${endpoint}/events?afterRevision=0`],
  ];

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('groupChat.a2a.copied'));
    } catch {
      toast.error(t('chat.copyFailed'));
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !name.trim() || created || member?.revokedAt) return;
    setPending(true);
    try {
      if (member) {
        onSaved(
          await groupChatApi.updateA2aMember(roomId, member.id, { name }),
        );
        toast.success(t('groupChat.a2a.saved'));
        onClose();
      } else {
        const result = await groupChatApi.createA2aMember(roomId, name);
        setCreated(result);
        onSaved(result.member);
        toast.success(t('groupChat.a2a.created'));
      }
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }
  async function revoke() {
    if (!current || pending) return;
    setPending(true);
    try {
      onSaved(await groupChatApi.revokeA2aMember(roomId, current.id));
      toast.success(t('groupChat.a2a.revokedToast'));
      onClose();
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden="true" />
            {t(member ? 'groupChat.a2a.edit' : 'groupChat.a2a.add')}
          </DialogTitle>
          <DialogDescription>{t('groupChat.a2a.hint')}</DialogDescription>
        </DialogHeader>
        <form className="min-h-0" onSubmit={(event) => void save(event)}>
          <ScrollArea
            viewportProps={{ className: 'max-h-[60dvh] [&>div]:block!' }}
          >
            <div className="space-y-5 px-6 py-4">
              <div className="space-y-2">
                <Label htmlFor={`${id}-name`}>{t('groupChat.agentName')}</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  autoComplete="off"
                  placeholder={t('groupChat.a2a.namePlaceholder')}
                  disabled={pending || !!created || !!current?.revokedAt}
                  required
                />
              </div>
              {created && (
                <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-4">
                  <p role="status" className="text-sm font-medium">
                    {t('groupChat.a2a.keyOnce')}
                  </p>
                  <div className="flex min-w-0 items-center gap-2">
                    <PasswordInput
                      id={`${id}-key`}
                      aria-label="API Key"
                      value={created.apiKey}
                      readOnly
                      autoComplete="off"
                      groupClassName="min-w-0 flex-1"
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t('groupChat.a2a.copyKey')}
                      title={t('groupChat.a2a.copyKey')}
                      onClick={() => void copy(created.apiKey)}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
              {current && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">
                      {t('groupChat.a2a.connection')}
                    </p>
                    <Badge
                      variant={current.revokedAt ? 'destructive' : 'secondary'}
                    >
                      {t(
                        current.revokedAt
                          ? 'groupChat.a2a.revoked'
                          : 'groupChat.a2a.member',
                      )}
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('groupChat.a2a.authHint')}
                  </p>
                  <code className="block rounded-md bg-muted px-3 py-2 text-xs">
                    Authorization: Bearer &lt;API_KEY&gt;
                  </code>
                  {connections.map(([label, url], index) => (
                    <div key={label} className="space-y-1.5">
                      <Label htmlFor={`${id}-url-${index}`} className="text-xs">
                        {label}
                      </Label>
                      <div className="flex min-w-0 items-center gap-2">
                        <Input
                          id={`${id}-url-${index}`}
                          value={url}
                          readOnly
                          className="min-w-0 flex-1 font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('groupChat.a2a.copyUrl', {
                            name: label,
                          })}
                          title={t('groupChat.a2a.copyUrl', { name: label })}
                          onClick={() => void copy(url)}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('groupChat.a2a.protocolHint')}
                  </p>
                </div>
              )}
              {member && !member.revokedAt && (
                <div className="space-y-3 border-t pt-4">
                  {confirmRevoke ? (
                    <>
                      <p role="alert" className="text-sm text-destructive">
                        {t('groupChat.a2a.revokeHint')}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={pending}
                          onClick={() => void revoke()}
                        >
                          {t('groupChat.a2a.confirmRevoke')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={() => setConfirmRevoke(false)}
                        >
                          {t('agents.cancel')}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={pending}
                      onClick={() => setConfirmRevoke(true)}
                    >
                      <Unplug className="size-4" />
                      {t('groupChat.a2a.revoke')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
          <DialogFooter className="border-t px-6 py-4">
            <Button
              type="button"
              variant={created ? 'default' : 'outline'}
              disabled={pending}
              onClick={onClose}
            >
              {t(created ? 'groupChat.a2a.keySaved' : 'common.close')}
            </Button>
            {!created && !member?.revokedAt && (
              <Button type="submit" disabled={pending || !name.trim()}>
                {t(
                  pending
                    ? 'groupChat.a2a.saving'
                    : member
                      ? 'groupChat.a2a.save'
                      : 'groupChat.a2a.createKey',
                )}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
