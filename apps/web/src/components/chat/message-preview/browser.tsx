import { Fragment, useMemo, type ReactNode } from 'react';
import { isToolUIPart } from 'ai';
import { ExternalLink, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements/code-block';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Item, ItemContent, ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import type { TranslationKey } from '@/i18n/config';
import { getToolName } from '../tool-renderers/registry';
import {
  browserRecord,
  browserScreenshotOutput,
  parseBrowserOutput,
  parseBrowserTabs,
} from './browser-data';
import { readFileBlocks } from './read-file-output';
import { ToolMedia } from './tool-media';
import { webPreviewLink } from './web-link';
import type { PreviewPart } from './selection';

type BrowserTranslationKey = Extract<TranslationKey, `chat.browser.${string}`>;
const browserActions: Record<string, BrowserTranslationKey> = {
  browser_goto: 'chat.browser.goto',
  browser_snapshot: 'chat.browser.snapshot',
  browser_screenshot: 'chat.browser.screenshot',
  browser_click: 'chat.browser.click',
  browser_type: 'chat.browser.type',
  browser_press: 'chat.browser.press',
  browser_select: 'chat.browser.select',
  browser_scroll: 'chat.browser.scroll',
  browser_close: 'chat.browser.close',
  browser_hover: 'chat.browser.hover',
  browser_back: 'chat.browser.back',
  browser_dialog: 'chat.browser.dialog',
  browser_wait: 'chat.browser.wait',
  browser_tabs: 'chat.browser.tabs',
  browser_drag: 'chat.browser.drag',
  browser_evaluate: 'chat.browser.evaluate',
};

// Keep unknown fields visible when a provider adds new parameters or results.
const fieldLabels: Record<string, BrowserTranslationKey> = {
  url: 'chat.browser.url',
  title: 'chat.browser.pageTitle',
  ref: 'chat.browser.ref',
  triggerRef: 'chat.browser.triggerRef',
  sourceRef: 'chat.browser.sourceRef',
  targetRef: 'chat.browser.targetRef',
  sourceSelector: 'chat.browser.sourceSelector',
  targetSelector: 'chat.browser.targetSelector',
  text: 'chat.browser.text',
  value: 'chat.browser.value',
  selected: 'chat.browser.selected',
  key: 'chat.browser.key',
  modifiers: 'chat.browser.modifiers',
  button: 'chat.browser.button',
  clickCount: 'chat.browser.clickCount',
  clear: 'chat.browser.clear',
  delay: 'chat.browser.delay',
  label: 'chat.browser.label',
  index: 'chat.browser.index',
  action: 'chat.browser.action',
  state: 'chat.browser.state',
  timeout: 'chat.browser.timeout',
  waitUntil: 'chat.browser.waitUntil',
  direction: 'chat.browser.direction',
  amount: 'chat.browser.amount',
  fullPage: 'chat.browser.fullPage',
  interactiveOnly: 'chat.browser.interactiveOnly',
  maxDepth: 'chat.browser.maxDepth',
  arg: 'chat.browser.arg',
  position: 'chat.browser.position',
  scroll: 'chat.browser.scrollPosition',
  elementCount: 'chat.browser.elementCount',
  total: 'chat.browser.total',
  remaining: 'chat.browser.remaining',
  dialogType: 'chat.browser.dialogType',
};

function BrowserCode({
  code,
  title,
  language = 'yaml',
}: {
  code: string;
  title: string;
  language?: 'yaml' | 'json' | 'javascript';
}) {
  const { t } = useTranslation();
  return (
    <CodeBlock
      code={code}
      language={language}
      className="min-w-0 [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
    >
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            aria-label={t('chat.browser.copy', { name: title })}
            title={t('chat.browser.copy', { name: title })}
            disabled={!code}
            onCopy={() => toast.success(t('chat.browser.copied'))}
            onError={() => toast.error(t('chat.preview.copyFailed'))}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

function BrowserFields({ value }: { value: Record<string, unknown> }) {
  const { t } = useTranslation();
  const entries = Object.entries(value).filter(
    ([, value]) => value !== undefined,
  );
  if (!entries.length) return null;
  return (
    <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-xs leading-6">
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground [overflow-wrap:anywhere]">
            {Object.hasOwn(fieldLabels, key) ? t(fieldLabels[key]) : key}
          </dt>
          <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {typeof value === 'boolean' ? (
              <Badge variant="outline">
                {t(value ? 'chat.browser.yes' : 'chat.browser.no')}
              </Badge>
            ) : typeof value === 'object' && value !== null ? (
              <pre className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
                {JSON.stringify(value, null, 2)}
              </pre>
            ) : (
              String(value)
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function BrowserPage({
  url,
  title,
  children,
}: {
  url?: string;
  title?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const link = url ? webPreviewLink(url) : null;
  const label = title?.trim() || link?.hostname || t('chat.browser.page');
  return (
    <Item variant="muted" size="sm" className="min-w-0 px-3">
      <Globe
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <ItemContent className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {children}
          {link ? (
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              title={t('chat.webFetch.openLink')}
              className="min-w-0 rounded text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
            >
              {label}
              <ExternalLink
                className="ml-1 inline size-3.5"
                aria-hidden="true"
              />
            </a>
          ) : (
            <span className="text-sm font-medium [overflow-wrap:anywhere]">
              {label}
            </span>
          )}
        </div>
        {url !== undefined && (
          <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {url}
          </p>
        )}
      </ItemContent>
    </Item>
  );
}

export function BrowserPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const name = isToolUIPart(part) ? getToolName(part) : undefined;
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseBrowserOutput(output), [output]);
  const blocks = useMemo(
    () =>
      name === 'browser_screenshot'
        ? readFileBlocks(browserScreenshotOutput(output))
        : [],
    [name, output],
  );
  if (!isToolUIPart(part) || !name) return null;
  const hasMedia = blocks.some((block) => block.type === 'media');
  const input = browserRecord(part.input);
  const failed =
    part.state === 'output-error' ||
    !!part.errorText ||
    result?.success === false ||
    result?.isError === true;
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available';
  const error =
    part.errorText ||
    (failed
      ? (typeof result?.message === 'string' && result.message) ||
        t('chat.browser.failed')
      : undefined);
  const url = typeof result?.url === 'string' ? result.url : undefined;
  const title = typeof result?.title === 'string' ? result.title : undefined;
  const snapshot =
    name === 'browser_snapshot' && typeof result?.snapshot === 'string'
      ? result.snapshot
      : undefined;
  const tabs =
    name === 'browser_tabs' ? parseBrowserTabs(result?.tabs) : undefined;
  const hasEvaluation =
    name === 'browser_evaluate' && result && 'result' in result;
  const script =
    name === 'browser_evaluate' && typeof input?.script === 'string'
      ? input.script
      : undefined;
  const hint = typeof result?.hint === 'string' ? result.hint : undefined;
  const recoveryHint =
    typeof result?.recoveryHint === 'string' ? result.recoveryHint : undefined;
  const message =
    typeof result?.message === 'string' ? result.message : undefined;
  const hidden = new Set<string>();
  if (typeof result?.success === 'boolean') hidden.add('success');
  if (typeof result?.isError === 'boolean') hidden.add('isError');
  if (url !== undefined) hidden.add('url');
  if (title !== undefined) hidden.add('title');
  if (snapshot !== undefined) hidden.add('snapshot');
  if (tabs !== undefined) hidden.add('tabs');
  if (hasEvaluation) hidden.add('result');
  if (name === 'browser_screenshot' && typeof result?.base64 === 'string')
    hidden.add('base64');
  if (hint !== undefined) hidden.add('hint');
  if (recoveryHint !== undefined) hidden.add('recoveryHint');
  if (message !== undefined) hidden.add('message');
  if (failed && typeof result?.code === 'string') hidden.add('code');
  if (failed && typeof result?.canRetry === 'boolean') hidden.add('canRetry');
  if (hasMedia && typeof result?.base64 !== 'string') {
    // Preserve text alongside multimodal screenshots without repeating encoded bytes.
    if (Array.isArray(result?.content)) hidden.add('content');
    else if (result?.type === 'content') {
      hidden.add('type');
      hidden.add('value');
    } else {
      for (const key of [
        'type',
        'data',
        'image',
        'mediaType',
        'mimeType',
        'filename',
        'text',
      ])
        hidden.add(key);
    }
  }
  const extra = Object.fromEntries(
    Object.entries(result ?? {}).filter(([key]) => !hidden.has(key)),
  );

  return (
    <div className="min-w-0 space-y-4 [&_.animate-pulse]:motion-reduce:animate-none">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {browserActions[name]
              ? t(browserActions[name])
              : t('chat.browser.operation')}
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {name}
          </p>
        </div>
        {getStatusBadge(failed ? 'output-error' : part.state)}
      </div>
      {part.input !== undefined && (
        <section
          aria-label={t('chat.toolParameters')}
          className="min-w-0 space-y-2"
        >
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chat.toolParameters')}
          </h4>
          {script !== undefined && (
            <BrowserCode
              code={script}
              language="javascript"
              title={t('chat.browser.script')}
            />
          )}
          {input ? (
            Object.keys(input).length ? (
              <BrowserFields
                value={Object.fromEntries(
                  Object.entries(input).filter(
                    ([key]) => script === undefined || key !== 'script',
                  ),
                )}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('chat.browser.noParameters')}
              </p>
            )
          ) : (
            <ToolInput input={part.input} />
          )}
        </section>
      )}
      <section
        aria-label={t('chat.toolResult')}
        className="min-w-0 space-y-3 border-t pt-4"
      >
        {(url !== undefined || title !== undefined) && (
          <BrowserPage url={url} title={title} />
        )}
        <ToolOutput output={undefined} errorText={error} />
        {failed && result && (
          <div className="flex flex-wrap gap-2">
            {typeof result.code === 'string' && (
              <Badge
                variant="outline"
                className="max-w-full whitespace-normal break-all"
              >
                {result.code}
              </Badge>
            )}
            {typeof result.canRetry === 'boolean' && (
              <Badge variant="secondary">
                {t(
                  result.canRetry
                    ? 'chat.browser.retryable'
                    : 'chat.browser.notRetryable',
                )}
              </Badge>
            )}
          </div>
        )}
        {snapshot !== undefined &&
          (snapshot ? (
            <BrowserCode code={snapshot} title={t('chat.browser.snapshot')} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('chat.browser.emptySnapshot')}
            </p>
          ))}
        {hasMedia &&
          blocks.map((block, index) => {
            const key = `${part.toolCallId}:${index}`;
            if (block.type === 'media')
              return <ToolMedia key={key} media={block} />;
            if (block.type === 'text')
              return (
                <p
                  key={key}
                  className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]"
                >
                  {block.text}
                </p>
              );
            return (
              <ToolOutput
                key={key}
                output={block.value}
                errorText={undefined}
              />
            );
          })}
        {tabs !== undefined && (
          <section aria-label={t('chat.browser.tabs')} className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {t('browser.tabCount', { count: tabs.length })}
            </h4>
            {tabs.length ? (
              <ItemGroup className="gap-2">
                {tabs.map((tab, index) => (
                  <div role="listitem" key={`${tab.index}:${index}`}>
                    <BrowserPage url={tab.url} title={tab.title}>
                      <Badge variant="outline">
                        {t('chat.browser.tabIndex', { index: tab.index })}
                      </Badge>
                      {tab.active && (
                        <Badge variant="secondary">
                          {t('chat.browser.activeTab')}
                        </Badge>
                      )}
                    </BrowserPage>
                  </div>
                ))}
              </ItemGroup>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('chat.browser.emptyTabs')}
              </p>
            )}
          </section>
        )}
        {hasEvaluation && (
          <BrowserCode
            code={JSON.stringify(result.result, null, 2) ?? 'undefined'}
            language="json"
            title={t('chat.browser.evaluationResult')}
          />
        )}
        {message !== undefined && message !== error && (
          <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
            {message}
          </p>
        )}
        <BrowserFields value={extra} />
        {hint && (
          <p className="whitespace-pre-wrap text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            {hint}
          </p>
        )}
        {recoveryHint && (
          <div className="space-y-1">
            <h4 className="text-xs font-medium">
              {t('chat.browser.recovery')}
            </h4>
            <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
              {recoveryHint}
            </p>
          </div>
        )}
        {pending && output === undefined && !failed && (
          <div role="status" className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t('chat.browser.waiting')}
            </p>
            <Skeleton className="h-4 w-3/4" aria-hidden="true" />
            <Skeleton className="h-4 w-full" aria-hidden="true" />
          </div>
        )}
        {!result && !hasMedia && (
          <ToolOutput output={output} errorText={undefined} />
        )}
        {part.state === 'output-available' &&
          output === undefined &&
          !failed && (
            <p className="text-sm text-muted-foreground">
              {t('chat.browser.emptyOutput')}
            </p>
          )}
      </section>
    </div>
  );
}
