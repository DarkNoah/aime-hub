import { lazy, Suspense, useMemo, useState } from 'react';
import type { FileDiffOptions } from '@pierre/diffs';
import { useTranslation } from 'react-i18next';
import { Columns2, Rows3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { useTheme } from '@/components/theme/context';
import { fileCodeOptions, fileCodeStyles } from './file-code-options';

const DiffViewer = lazy(() =>
  import('@pierre/diffs/react').then((module) => ({
    default: module.MultiFileDiff<undefined, undefined>,
  })),
);

export function FileDiff({
  filename = 'fragment.txt',
  oldValue,
  newValue,
}: {
  filename?: string;
  oldValue: string;
  newValue: string;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [splitView, setSplitView] = useState(false);
  const oldFile = useMemo(
    () => ({ name: filename, contents: oldValue }),
    [filename, oldValue],
  );
  const newFile = useMemo(
    () => ({ name: filename, contents: newValue }),
    [filename, newValue],
  );
  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      ...fileCodeOptions,
      themeType: resolvedTheme,
      diffStyle: splitView ? 'split' : 'unified',
      diffIndicators: 'classic',
      expandUnchanged: true,
    }),
    [splitView, resolvedTheme],
  );

  return (
    <section
      aria-label={t('fileDiff.title')}
      className="min-w-0 overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <h4 className="text-xs font-medium">{t('fileDiff.title')}</h4>
        <ButtonGroup aria-label={t('fileDiff.layout')}>
          <Button
            size="sm"
            variant={splitView ? 'ghost' : 'secondary'}
            className="h-7 gap-1.5 px-2 text-xs"
            aria-pressed={!splitView}
            onClick={() => setSplitView(false)}
          >
            <Rows3 className="size-3.5" aria-hidden="true" />
            {t('fileDiff.unified')}
          </Button>
          <Button
            size="sm"
            variant={splitView ? 'secondary' : 'ghost'}
            className="h-7 gap-1.5 px-2 text-xs"
            aria-pressed={splitView}
            onClick={() => setSplitView(true)}
          >
            <Columns2 className="size-3.5" aria-hidden="true" />
            {t('fileDiff.split')}
          </Button>
        </ButtonGroup>
      </div>
      {splitView && (
        <div className="grid grid-cols-2 border-b bg-muted/50 text-xs text-muted-foreground">
          <span className="px-3 py-2">{t('fileDiff.before')}</span>
          <span className="border-l px-3 py-2">{t('fileDiff.after')}</span>
        </div>
      )}
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t('fileDiff.loading')}
          </p>
        }
      >
        <DiffViewer
          oldFile={oldFile}
          newFile={newFile}
          options={options}
          style={fileCodeStyles}
          className="block min-w-0"
        />
      </Suspense>
      {oldValue === newValue && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          {t('fileDiff.unchanged')}
        </p>
      )}
    </section>
  );
}
