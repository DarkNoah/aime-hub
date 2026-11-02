import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Trash2, UserPlus } from 'lucide-react';
import type {
  KnowledgeMemberPage,
  KnowledgeUserPage,
} from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { PermissionSelect } from './permission-select';
import { knowledgeError } from './errors';

type PageInput = { id: string; query: string; cursor?: string };
const loadMembers = (input: PageInput, signal: AbortSignal) =>
  api.knowledge.members(input, { signal });
const loadUsers = (input: PageInput, signal: AbortSignal) =>
  api.knowledge.searchUsers(input, { signal });

// Each request is bounded; changing one permission never reloads or resets the page.
function useSharingPage<T extends { nextCursor?: string }>(
  id: string,
  load: (input: PageInput, signal: AbortSignal) => Promise<T>,
  minQuery = 0,
) {
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const cursor = cursors.at(-1);
  const active = query.trim().length >= minQuery;
  useEffect(() => {
    if (!active) return;
    const c = new AbortController();
    const timer = setTimeout(
      () => {
        void load({ id, query: query.trim(), cursor }, c.signal)
          .then((result) => {
            if (!c.signal.aborted) {
              setData(result);
              setError(undefined);
            }
          })
          .catch((e) => {
            if (!c.signal.aborted) setError(e);
          })
          .finally(() => {
            if (!c.signal.aborted) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [id, query, cursor, revision, active, load]);
  function search(value: string) {
    setQuery(value);
    setCursors([undefined]);
    setData(undefined);
    setError(undefined);
    setLoading(true);
  }
  function refresh() {
    setLoading(true);
    setRevision((v) => v + 1);
  }
  function next() {
    if (!data?.nextCursor) return;
    setCursors((v) => [...v, data.nextCursor]);
    setData(undefined);
    setError(undefined);
    setLoading(true);
  }
  function previous() {
    setCursors((v) => v.slice(0, -1));
    setData(undefined);
    setError(undefined);
    setLoading(true);
  }
  return {
    query,
    search,
    data,
    setData,
    loading,
    error,
    refresh,
    next,
    previous,
    page: cursors.length,
    active,
  };
}

function PageButtons({
  page,
  nextCursor,
  disabled,
  onPrevious,
  onNext,
}: {
  page: number;
  nextCursor?: string;
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  if (page === 1 && !nextCursor) return null;
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || page === 1}
        onClick={onPrevious}
      >
        {t('knowledge.previousPage')}
      </Button>
      <span className="text-xs text-muted-foreground">
        {t('knowledge.pageNumber', { page })}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !nextCursor}
        onClick={onNext}
      >
        {t('knowledge.nextPage')}
      </Button>
    </div>
  );
}

export function SharingMembers({
  id,
  disabled,
  onBusyChange,
}: {
  id: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const members = useSharingPage<KnowledgeMemberPage>(id, loadMembers);
  const users = useSharingPage<KnowledgeUserPage>(id, loadUsers, 2);
  async function mutate(action: () => Promise<void>) {
    if (disabled) return;
    onBusyChange(true);
    try {
      await action();
      toast.success(t('knowledge.saved'));
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      onBusyChange(false);
    }
  }
  const memberDisabled = disabled || members.loading || !!members.error;
  return (
    <section className="space-y-4">
      <section aria-label={t('knowledge.addMember')} className="space-y-2">
        <Input
          aria-label={t('knowledge.searchUsers')}
          placeholder={t('knowledge.searchUsers')}
          maxLength={100}
          value={users.query}
          disabled={disabled}
          onChange={(e) => users.search(e.target.value)}
        />
        {users.active && (
          <>
            {users.error ? (
              <div role="alert" className="text-sm">
                {t(knowledgeError(users.error))}{' '}
                <Button variant="ghost" size="sm" onClick={users.refresh}>
                  {t('knowledge.retry')}
                </Button>
              </div>
            ) : users.loading ? (
              <p role="status" className="text-sm">
                {t('knowledge.loading')}
              </p>
            ) : (
              <div className="divide-y rounded-lg border">
                {!users.data?.users.length && (
                  <p className="p-3 text-sm text-muted-foreground">
                    {t('knowledge.noUsers')}
                  </p>
                )}
                {users.data?.users.map((user) => (
                  <div key={user.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{user.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {user.username}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={memberDisabled}
                      onClick={() =>
                        void mutate(async () => {
                          await api.knowledge.setMember({
                            id,
                            member: { userId: user.id, permission: 'read' },
                          });
                          users.setData(
                            (current) =>
                              current && {
                                ...current,
                                users: current.users.filter(
                                  (u) => u.id !== user.id,
                                ),
                              },
                          );
                          members.refresh();
                        })
                      }
                    >
                      <UserPlus />
                      {t('knowledge.addMember')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <PageButtons
              page={users.page}
              nextCursor={users.data?.nextCursor}
              disabled={disabled || users.loading || !!users.error}
              onPrevious={users.previous}
              onNext={users.next}
            />
          </>
        )}
      </section>
      <section aria-label={t('knowledge.members')} className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Label>{t('knowledge.members')}</Label>
          {members.data && (
            <Badge variant="secondary">{members.data.total}</Badge>
          )}
        </div>
        <Input
          aria-label={t('knowledge.searchMembers')}
          placeholder={t('knowledge.searchMembers')}
          maxLength={100}
          value={members.query}
          disabled={disabled}
          onChange={(e) => members.search(e.target.value)}
        />
        {!!members.error && (
          <div role="alert" className="text-sm">
            {t(knowledgeError(members.error))}{' '}
            <Button variant="ghost" size="sm" onClick={members.refresh}>
              {t('knowledge.retry')}
            </Button>
          </div>
        )}
        {members.loading && (
          <p role="status" className="text-sm">
            {t('knowledge.loading')}
          </p>
        )}
        {!members.loading &&
          !members.error &&
          !members.data?.members.length && (
            <p className="text-sm text-muted-foreground">
              {t(
                members.query
                  ? 'knowledge.noMatchingMembers'
                  : 'knowledge.addMemberHint',
              )}
            </p>
          )}
        {members.data?.members.map((member) => (
          <div
            key={member.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
          >
            <div className="min-w-24 flex-1">
              <p className="break-all text-sm font-medium">{member.name}</p>
              <p className="break-all text-xs text-muted-foreground">
                {member.username}
              </p>
            </div>
            <PermissionSelect
              value={member.permission}
              disabled={memberDisabled}
              label={t('knowledge.memberPermission', { name: member.name })}
              onChange={(permission) =>
                void mutate(async () => {
                  const updated = await api.knowledge.setMember({
                    id,
                    member: { userId: member.id, permission },
                  });
                  members.setData(
                    (current) =>
                      current && {
                        ...current,
                        members: current.members.map((m) =>
                          m.id === updated.id ? updated : m,
                        ),
                      },
                  );
                })
              }
            />
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={memberDisabled}
              aria-label={t('knowledge.removeMember', { name: member.name })}
              onClick={() =>
                void mutate(async () => {
                  await api.knowledge.removeMember({ id, userId: member.id });
                  members.setData(
                    (current) =>
                      current && {
                        ...current,
                        total: current.total - 1,
                        members: current.members.filter(
                          (m) => m.id !== member.id,
                        ),
                      },
                  );
                  if (users.active) users.refresh();
                })
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <PageButtons
          page={members.page}
          nextCursor={members.data?.nextCursor}
          disabled={disabled || members.loading || !!members.error}
          onPrevious={members.previous}
          onNext={members.next}
        />
      </section>
    </section>
  );
}
