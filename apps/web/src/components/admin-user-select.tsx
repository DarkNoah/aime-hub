import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { authClient } from '@/features/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LoadingState } from '@/components/loading-state';

type User = { id: string; name: string; email: string };
const pageSize = 20;

/** Administrator-only picker, with selections preserved across searches and pages. */
export function AdminUserSelect({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange(value: string[]): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState({ search: '', page: 0 });
  const [result, setResult] = useState<{
    key: typeof query;
    users: User[];
    total: number;
    error: boolean;
  }>();
  const [known, setKnown] = useState<Record<string, User>>({});
  const [retry, setRetry] = useState(0);
  const loading = result?.key !== query;

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void authClient.admin
        .listUsers({
          query: {
            limit: pageSize,
            offset: query.page * pageSize,
            searchField: query.search.includes('@') ? 'email' : 'name',
            searchValue: query.search || undefined,
            searchOperator: 'contains',
            sortBy: 'createdAt',
            sortDirection: 'desc',
          },
        })
        .then((response) => {
          if (cancelled) return;
          if (response.error) throw response.error;
          setResult({
            key: query,
            users: response.data.users,
            total: response.data.total,
            error: false,
          });
          setKnown((current) => ({
            ...current,
            ...Object.fromEntries(
              response.data.users.map((user) => [user.id, user]),
            ),
          }));
        })
        .catch(() => {
          if (!cancelled)
            setResult({ key: query, users: [], total: 0, error: true });
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, retry]);

  useEffect(() => {
    let cancelled = false;
    const missing = value.filter((id) => !known[id]);
    if (missing.length)
      void Promise.all(
        missing.map(async (id) => {
          const response = await authClient.admin
            .getUser({ query: { id } })
            .catch(() => null);
          return [id, response?.data ?? { id, name: id, email: '' }] as const;
        }),
      ).then((entries) => {
        if (!cancelled)
          setKnown((current) => ({
            ...current,
            ...Object.fromEntries(entries),
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [value, known]);

  const remove = (id: string) => onChange(value.filter((item) => item !== id));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">
          {t('plugins.accessSelectedCount', { count: value.length })}
        </Badge>
        {value.map((id) => (
          <Badge key={id} variant="outline" className="max-w-full gap-1">
            <span className="truncate" title={known[id]?.email}>
              {known[id]?.name ?? id}
            </span>
            <button
              type="button"
              disabled={disabled}
              className="rounded-sm p-0.5 focus-visible:outline focus-visible:outline-2"
              aria-label={t('plugins.accessRemoveUser', {
                name: known[id]?.name ?? id,
              })}
              onClick={() => remove(id)}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        aria-label={t('plugins.accessSearch')}
        placeholder={t('plugins.accessSearch')}
        disabled={disabled}
        value={query.search}
        onChange={(event) => setQuery({ search: event.target.value, page: 0 })}
      />
      <ScrollArea
        className="rounded-md border"
        viewportProps={{ className: 'h-52' }}
      >
        {loading ? (
          <LoadingState />
        ) : result?.error ? (
          <div role="alert" className="space-y-2 p-3 text-sm">
            <p className="text-destructive">{t('plugins.accessUsersFailed')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRetry((current) => current + 1)}
            >
              {t('plugins.configReload')}
            </Button>
          </div>
        ) : result?.users.length ? (
          result.users.map((user) => (
            <label
              key={user.id}
              className="flex cursor-pointer items-center gap-3 border-b p-3 last:border-0 hover:bg-muted/50"
            >
              <Checkbox
                disabled={disabled}
                checked={value.includes(user.id)}
                onCheckedChange={(checked) =>
                  checked
                    ? onChange([...new Set([...value, user.id])])
                    : remove(user.id)
                }
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {user.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </span>
            </label>
          ))
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            {t('plugins.accessNoUsers')}
          </p>
        )}
      </ScrollArea>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('plugins.accessPrevious')}
          disabled={disabled || loading || !query.page}
          onClick={() =>
            setQuery((current) => ({ ...current, page: current.page - 1 }))
          }
        >
          <ChevronLeft />
        </Button>
        <span className="text-sm tabular-nums">{query.page + 1}</span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('plugins.accessNext')}
          disabled={
            disabled ||
            loading ||
            (query.page + 1) * pageSize >= (result?.total ?? 0)
          }
          onClick={() =>
            setQuery((current) => ({ ...current, page: current.page + 1 }))
          }
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
