import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Search, UserPlus, Trash2 } from 'lucide-react';
import type {
  ProjectDetail,
  ProjectMember,
  ProjectUser,
} from '@aime/shared/projects';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { chatErrorKey } from '@/components/chat/api';
import { projectApi } from '../api';

export function MembersSheet({
  project,
  onClose,
}: {
  project: ProjectDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof chatErrorKey> | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<ProjectUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState(false);
  const [remove, setRemove] = useState<ProjectMember | null>(null);
  const manager = project.role !== 'member';
  useEffect(() => {
    const controller = new AbortController();
    void projectApi
      .members(project.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setMembers(value);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(chatErrorKey(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.id, retry]);
  useEffect(() => {
    if (!manager || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void projectApi
        .searchUsers(project.id, query, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setUsers(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) toast.error(t(chatErrorKey(cause)));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [manager, project.id, query, t]);
  async function mutate(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    try {
      await action();
      toast.success(t('projects.saved'));
    } catch (cause) {
      toast.error(t(chatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <SheetContent
        className="w-full sm:max-w-xl"
        closeLabel={t('common.close')}
      >
        <div className="space-y-2 p-6 pr-12">
          <SheetTitle>{t('projects.members')}</SheetTitle>
          <SheetDescription>{t('projects.membersHint')}</SheetDescription>
        </div>
        <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6">
          {manager && (
            <section className="space-y-3" aria-label={t('projects.addMember')}>
              <div className="relative">
                <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
                <Input
                  aria-label={t('projects.searchUsers')}
                  placeholder={t('projects.searchUsers')}
                  value={query}
                  disabled={pending}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setUsers([]);
                    setSearching(event.target.value.trim().length >= 2);
                  }}
                  className="pl-9"
                />
              </div>
              {query.trim().length >= 2 && (
                <div className="divide-y rounded-lg border">
                  {searching ? (
                    <p
                      role="status"
                      className="p-3 text-sm text-muted-foreground"
                    >
                      {t('chat.loading')}
                    </p>
                  ) : !users.length ? (
                    <p className="p-3 text-sm text-muted-foreground">
                      {t('projects.noUsers')}
                    </p>
                  ) : (
                    users.map((user) => (
                      <div
                        key={user.id}
                        className="flex items-center gap-3 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {user.name}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {user.username}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            void mutate(async () => {
                              const member = await projectApi.addMember(
                                project.id,
                                user.id,
                                'member',
                              );
                              setMembers((current) => [...current, member]);
                              setQuery('');
                              setUsers([]);
                            })
                          }
                        >
                          <UserPlus />
                          {t('projects.addMember')}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          )}
          {error && (
            <div role="alert" className="space-y-3 text-sm">
              <p>{t(error)}</p>
              <Button
                variant="outline"
                onClick={() => setRetry((value) => value + 1)}
              >
                {t('providers.retry')}
              </Button>
            </div>
          )}
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )}
          <div className="divide-y">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex flex-wrap items-center gap-3 py-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.username}
                  </p>
                </div>
                {project.role === 'owner' && member.role !== 'owner' ? (
                  <Select
                    value={member.role}
                    disabled={pending}
                    onValueChange={(value: 'admin' | 'member') =>
                      void mutate(async () => {
                        await projectApi.changeRole(
                          project.id,
                          member.id,
                          value,
                        );
                        setMembers((current) =>
                          current.map((item) =>
                            item.id === member.id
                              ? { ...item, role: value }
                              : item,
                          ),
                        );
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-28"
                      aria-label={t('projects.memberRole', {
                        name: member.name,
                      })}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">
                        {t('projects.role.member')}
                      </SelectItem>
                      <SelectItem value="admin">
                        {t('projects.role.admin')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary">
                    {t(`projects.role.${member.role}`)}
                  </Badge>
                )}
                {manager &&
                  member.role !== 'owner' &&
                  (project.role === 'owner' || member.role === 'member') && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={t('projects.removeNamed', {
                        name: member.name,
                      })}
                      onClick={() => setRemove(member)}
                    >
                      <Trash2 />
                    </Button>
                  )}
              </div>
            ))}
          </div>
        </div>
      </SheetContent>
      {remove && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) setRemove(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('projects.removeNamed', { name: remove.name })}
              </DialogTitle>
              <DialogDescription>{t('projects.removeHint')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setRemove(null)}
              >
                {t('users.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  void mutate(async () => {
                    await projectApi.removeMember(project.id, remove.id);
                    setMembers((current) =>
                      current.filter((item) => item.id !== remove.id),
                    );
                    setRemove(null);
                  })
                }
              >
                {t('projects.removeMember')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Sheet>
  );
}
