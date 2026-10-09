import { lazy, Suspense, useMemo } from 'react';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/theme/context';
import { fileCodeOptions, fileCodeStyles } from './file-code-options';

const FileViewer = lazy(() =>
  import('@pierre/diffs/react').then((module) => ({
    default: module.File<undefined, undefined>,
  })),
);

export function FileCode({
  filename = 'file.txt',
  code,
  showLineNumbers = true,
}: {
  filename?: string;
  code: string;
  showLineNumbers?: boolean;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const file = useMemo(
    () => ({ name: filename, contents: code }),
    [filename, code],
  );
  const options = useMemo(
    () => ({
      ...fileCodeOptions,
      themeType: resolvedTheme,
      disableLineNumbers: !showLineNumbers,
    }),
    [resolvedTheme, showLineNumbers],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t('fileCode.copied'));
    } catch {
      toast.error(t('fileCode.copyFailed'));
    }
  }

  return (
    <section
      aria-label={t('fileCode.title')}
      className="min-w-0 overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h4 className="text-xs font-medium">{t('fileCode.title')}</h4>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t('fileCode.copy')}
          title={t('fileCode.copy')}
          onClick={() => void copy()}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {code === '' ? (
        <p className="p-4 text-xs text-muted-foreground">
          {t('fileCode.empty')}
        </p>
      ) : (
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {t('fileCode.loading')}
            </p>
          }
        >
          <FileViewer
            file={file}
            options={options}
            style={fileCodeStyles}
            className="block min-w-0"
          />
        </Suspense>
      )}
    </section>
  );
}
