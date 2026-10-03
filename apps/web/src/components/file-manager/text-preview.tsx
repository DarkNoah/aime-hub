import { useEffect, useRef, useState } from 'react';
import type { ThemedToken, BundledLanguage } from 'shiki';
import { useTranslation } from 'react-i18next';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const languages: Record<string, BundledLanguage> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  mdx: 'mdx',
  sh: 'shellscript',
  bash: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  xml: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  toml: 'toml',
};

export default function TextPreview({
  text,
  path,
  line,
}: {
  text: string;
  path: string;
  line?: number;
}) {
  const { t } = useTranslation();
  const target = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<{
    source: string;
    tokens: ThemedToken[][];
  } | null>(null);
  const language = languages[path.split('.').at(-1)?.toLowerCase() ?? ''];
  const lines = text.split('\n');
  const shown = lines.slice(0, 10000);
  useEffect(() => {
    let cancelled = false;
    if (language && text.length < 100000)
      void import('shiki')
        .then(async ({ codeToTokens, bundledLanguages }) => {
          if (!(language in bundledLanguages)) return;
          const result = await codeToTokens(text, {
            lang: language,
            theme: 'github-light',
          });
          if (!cancelled)
            setHighlighted({ source: text, tokens: result.tokens });
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [language, text]);
  useEffect(() => {
    target.current?.scrollIntoView({ block: 'center' });
  }, [line, path, text]);
  const tokens = highlighted?.source === text ? highlighted.tokens : undefined;
  return (
    <ScrollArea
      className="h-full min-h-0 bg-card"
      viewportProps={{ tabIndex: 0, 'aria-label': t('files.textPreview') }}
    >
      {lines.length > shown.length && (
        <p className="sticky left-0 p-3 text-xs text-muted-foreground">
          {t('files.previewLimit')}
        </p>
      )}
      <div className="w-max min-w-full py-3 font-mono text-xs leading-6">
        {shown.map((value, index) => (
          <div
            key={index}
            ref={line === index + 1 ? target : undefined}
            className={cn('flex min-h-6', line === index + 1 && 'bg-accent')}
          >
            <span
              aria-hidden="true"
              className="sticky left-0 mr-4 w-14 shrink-0 select-none bg-card px-3 text-right text-muted-foreground"
            >
              {index + 1}
            </span>
            <code className="whitespace-pre pr-5">
              {tokens?.[index]
                ? tokens[index].map((token, i) => (
                    <span key={i} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))
                : value || '\n'}
            </code>
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
