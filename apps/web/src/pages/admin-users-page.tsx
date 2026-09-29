import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  UserActionDialog,
  type UserAction,
  type ManagedUser,
} from '@/components/user-action-dialog';
import { authClient, isAdmin } from '@/lib/auth-client';
import { authErrorKey } from '@/lib/auth-errors';
import { useAuthSession } from '@/lib/session-context';
import type { ErrorKey } from '@/i18n/config';

const pageSize = 20;

export function AdminUsersPage() {
  const { t, i18n } = useTranslation();
  const { data: session, refetch } = useAuthSession();
  const [searchField, setSearchField] = useState<'email' | 'name'>('email');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState({
    field: 'email' as 'email' | 'name',
    value: '',
    page: 0,
  });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    users: ManagedUser[];
    total: number;
    error: ErrorKey | null;
  } | null>(null);
  const [action, setAction] = useState<UserAction | null>(null);
  const [success, setSuccess] = useState(false);
  const [now, setNow] = useState(Date.now);
  const requestKey = JSON.stringify([query, revision]);
  const loading = result?.key !== requestKey;
  const users = loading ? [] : result.users;
  const total = loading ? 0 : result.total;
  const error = loading ? null : result.error;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await authClient.admin.listUsers({
          query: {
            limit: pageSize,
            offset: query.page * pageSize,
            searchField: query.field,
            searchValue: query.value || undefined,
            searchOperator: 'contains',
            sortBy: 'createdAt',
            sortDirection: 'desc',
          },
        });
        if (cancelled) return;
        if (response.error) throw response.error;
        if (query.page > 0 && query.page * pageSize >= response.data.total) {
          setQuery((current) => ({
            ...current,
            page: Math.max(0, Math.ceil(response.data.total / pageSize) - 1),
          }));
          return;
        }
        setNow(Date.now());
        setResult({
          key: requestKey,
          users: response.data.users,
          total: response.data.total,
          error: null,
        });
      } catch (cause) {
        if (!cancelled)
          setResult({
            key: requestKey,
            users: [],
            total: 0,
            error: authErrorKey(cause),
          });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [query, revision, requestKey]);

  useEffect(() => {
    const nextExpiry = Math.min(
      ...(result?.users ?? [])
        .filter((user) => user.banned && user.banExpires)
        .map((user) => new Date(user.banExpires!).getTime())
        .filter((expiry) => expiry >= now),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(0, nextExpiry - Date.now() + 1), 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [result, now]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuccess(false);
    setQuery({ field: searchField, value: searchInput.trim(), page: 0 });
    setRevision((value) => value + 1);
  }

  function openAction(next: UserAction) {
    setSuccess(false);
    setAction(next);
  }

  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
  });

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="mb-3 text-xs font-medium tracking-[0.18em] text-primary">
            {t('admin.eyebrow')}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('nav.users')}
          </h1>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            {t('admin.usersDescription')}
          </p>
        </div>
        <Button id="create-user" onClick={() => openAction({ kind: 'create' })}>
          <Plus />
          {t('users.create')}
        </Button>
      </section>

      {success && (
        <p
          role="status"
          className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm"
        >
          {t('users.success')}
        </p>
      )}

      <section
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
        aria-label={t('nav.users')}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-5">
          <form
            onSubmit={search}
            className="flex w-full flex-wrap gap-2 sm:w-auto"
          >
            <Select
              value={searchField}
              onValueChange={(value) =>
                setSearchField(value as 'email' | 'name')
              }
            >
              <SelectTrigger
                className="h-10"
                aria-label={t('users.searchField')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">{t('auth.email')}</SelectItem>
                <SelectItem value="name">{t('users.name')}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="min-w-40 flex-1 sm:w-64"
              aria-label={t('users.searchInput')}
              placeholder={t('users.searchPlaceholder')}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <Button type="submit" variant="outline">
              <Search />
              {t('users.search')}
            </Button>
          </form>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw />
            {t('users.refresh')}
          </Button>
        </div>

        <div aria-busy={loading}>
          {loading ? (
            <div
              role="status"
              className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" />
              {t('users.loading')}
            </div>
          ) : error ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-4 p-6">
              <p role="alert" className="text-sm text-destructive">
                {t(error)}
              </p>
              <Button
                variant="outline"
                onClick={() => setRevision((value) => value + 1)}
              >
                {t('session.retry')}
              </Button>
            </div>
          ) : users.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
              <Users className="size-8 text-muted-foreground" />
              <h2 className="font-medium">{t('users.empty')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('users.emptyHint')}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <caption className="sr-only">{t('nav.users')}</caption>
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    {(
                      [
                        'users.account',
                        'auth.email',
                        'users.role',
                        'users.status',
                        'users.createdAt',
                        'users.actions',
                      ] as const
                    ).map((key) => (
                      <th
                        key={key}
                        scope="col"
                        className="whitespace-nowrap px-5 py-3 font-medium"
                      >
                        {t(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.map((user) => {
                    const self = user.id === session?.user.id;
                    const banned =
                      user.banned &&
                      (!user.banExpires ||
                        new Date(user.banExpires).getTime() >= now);
                    return (
                      <tr key={user.id} className="hover:bg-muted/20">
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <span
                              className="max-w-48 truncate font-medium"
                              title={user.name}
                            >
                              {user.name}
                            </span>
                            {self && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                {t('users.you')}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {user.username || '—'}
                          </div>
                        </td>
                        <td
                          className="max-w-64 truncate px-5 py-4"
                          title={user.email}
                        >
                          {user.email}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4">
                          <span
                            className={
                              isAdmin(user.role)
                                ? 'rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary'
                                : 'rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground'
                            }
                          >
                            {isAdmin(user.role)
                              ? t('users.admin')
                              : t('users.user')}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={
                              banned
                                ? 'whitespace-nowrap text-destructive'
                                : 'whitespace-nowrap text-muted-foreground'
                            }
                          >
                            {banned ? t('users.banned') : t('users.active')}
                          </span>
                          {banned && (
                            <div className="mt-1 max-w-48 text-xs text-muted-foreground">
                              <p
                                className="truncate"
                                title={user.banReason ?? undefined}
                              >
                                {user.banReason}
                              </p>
                              <p>
                                {user.banExpires
                                  ? t('users.banUntil', {
                                      date: dateFormatter.format(
                                        new Date(user.banExpires),
                                      ),
                                    })
                                  : t('users.permanent')}
                              </p>
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-muted-foreground">
                          {dateFormatter.format(new Date(user.createdAt))}
                        </td>
                        <td className="px-5 py-4">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                id={`user-actions-${user.id}`}
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('users.actionsFor', {
                                  name: user.name,
                                })}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() =>
                                  openAction({ kind: 'edit', user })
                                }
                              >
                                {t('users.edit')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={self}
                                onSelect={() =>
                                  openAction({ kind: 'role', user })
                                }
                              >
                                {t('users.changeRole')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  openAction({ kind: 'password', user })
                                }
                              >
                                {t('users.resetPassword')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={self}
                                onSelect={() =>
                                  openAction({ kind: 'revoke', user })
                                }
                              >
                                {t('users.revoke')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={self}
                                onSelect={() =>
                                  openAction({
                                    kind: banned ? 'unban' : 'ban',
                                    user,
                                  })
                                }
                              >
                                {banned ? t('users.unban') : t('users.ban')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={self}
                                onSelect={() =>
                                  openAction({ kind: 'delete', user })
                                }
                              >
                                {t('users.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {!loading && !error && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 text-sm text-muted-foreground">
            <p>{t('users.total', { count: total })}</p>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t('users.previous')}
                disabled={query.page === 0}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    page: current.page - 1,
                  }))
                }
              >
                <ChevronLeft />
              </Button>
              <span>{t('users.page', { page: query.page + 1, pages })}</span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t('users.next')}
                disabled={query.page + 1 >= pages}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    page: current.page + 1,
                  }))
                }
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </section>
      <p className="text-xs leading-6 text-muted-foreground">
        {t('users.selfHint')}
      </p>
      {action && (
        <UserActionDialog
          action={action}
          restoreFocus={() => {
            const trigger =
              action.kind === 'create'
                ? null
                : document.getElementById(`user-actions-${action.user.id}`);
            (trigger ?? document.getElementById('create-user'))?.focus();
          }}
          onClose={() => setAction(null)}
          onSuccess={() => {
            setAction(null);
            setSuccess(true);
            setRevision((value) => value + 1);
            if (action.kind === 'edit' && action.user.id === session?.user.id)
              void refetch();
          }}
        />
      )}
    </div>
  );
}
