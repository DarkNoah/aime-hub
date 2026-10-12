import {
  ArrowDownWideNarrow,
  ChevronDown,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { assetKinds, assetSorts, type AssetQuery } from '@aime/shared/assets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export function AssetFilters({
  search,
  kind,
  sort,
  onSearch,
  onKind,
  onSort,
  onReset,
}: {
  search: string;
  kind: AssetQuery['kind'];
  sort: AssetQuery['sort'];
  onSearch: (value: string) => void;
  onKind: (value: AssetQuery['kind']) => void;
  onSort: (value: AssetQuery['sort']) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const changed = search !== '' || kind !== 'all' || sort !== 'newest';
  return (
    <div className="space-y-2 border-b p-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            maxLength={200}
            className="h-9 pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
            aria-label={t('assets.search')}
            placeholder={t('assets.search')}
          />
          {search && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute top-1.5 right-1.5 text-muted-foreground"
              aria-label={t('assets.clearSearch')}
              title={t('assets.clearSearch')}
              onClick={() => onSearch('')}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              aria-label={`${t('assets.sort')}: ${t(`assets.sort.${sort}`)}`}
              title={t('assets.sort')}
            >
              <ArrowDownWideNarrow className="size-3.5 text-muted-foreground" />
              {t(`assets.sort.${sort}`)}
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('assets.sort')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => onSort(value as AssetQuery['sort'])}
            >
              {assetSorts.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {t(`assets.sort.${value}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-1.5">
        <div
          role="group"
          aria-label={t('assets.type')}
          className="grid min-w-0 flex-1 grid-cols-5 gap-0.5 rounded-md bg-muted/60 p-0.5"
        >
          {(['all', ...assetKinds] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={kind === value}
              className={cn(
                'h-7 min-w-0 px-1 text-xs font-normal text-muted-foreground',
                kind === value &&
                  'bg-background font-medium text-foreground shadow-xs hover:bg-background',
              )}
              onClick={() => onKind(value)}
            >
              {t(`assets.kind.${value}`)}
            </Button>
          ))}
        </div>
        {changed && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onReset}
            title={t('assets.resetFilters')}
            aria-label={t('assets.resetFilters')}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
