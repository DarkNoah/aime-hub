import { isToolUIPart } from 'ai';
import { BookOpen, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { FileCode } from '@/components/file-code';
import { SkillMarkdown } from '@/components/skills/skill-markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getToolName } from '../tool-renderers/registry';
import { commandRecord } from './command-data';
import { parseSkillOutput } from './skill-output';
import type { PreviewPart } from './selection';

export function SkillPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const isRead = name === 'skill_read';
  const input = commandRecord(part.input);
  const skillName = isRead ? input?.skillName : input?.name;
  const path =
    isRead && typeof input?.path === 'string' ? input.path : undefined;
  const startLine =
    isRead && typeof input?.startLine === 'number'
      ? input.startLine
      : undefined;
  const endLine =
    isRead && typeof input?.endLine === 'number' ? input.endLine : undefined;
  const result = parseSkillOutput(part.output, {
    skillName: typeof skillName === 'string' ? skillName : undefined,
    path,
    startLine,
    endLine,
  });
  const failed =
    part.state === 'output-error' || !!part.errorText || result?.isError;
  const error =
    part.errorText || (result?.isError ? result.content : undefined);
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available';
  const markdown =
    !isRead || (path !== undefined && /\.(?:md|mdx|markdown)$/i.test(path));
  const extra =
    input &&
    Object.fromEntries(
      Object.entries(input).filter(([key, value]) => {
        if (
          key === (isRead ? 'skillName' : 'name') ||
          (isRead && key === 'path')
        )
          return typeof value !== 'string';
        if (isRead && (key === 'startLine' || key === 'endLine'))
          return typeof value !== 'number';
        return true;
      }),
    );
  const Icon = isRead ? FileText : BookOpen;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="text-sm font-medium">
              {t(isRead ? 'chat.skill.read' : 'chat.skill.activate')}
            </h3>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {name}
            </p>
          </div>
        </div>
        {getStatusBadge(failed ? 'output-error' : part.state)}
      </div>
      {(typeof skillName === 'string' || path !== undefined) && (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-muted/40 p-3 text-xs leading-5 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:whitespace-pre-wrap [&_dd]:[overflow-wrap:anywhere]">
          {typeof skillName === 'string' && (
            <>
              <dt>{t('chat.skill.name')}</dt>
              <dd>{skillName}</dd>
            </>
          )}
          {path !== undefined && (
            <>
              <dt>{t('chat.skill.path')}</dt>
              <dd className="font-mono">{path}</dd>
            </>
          )}
        </dl>
      )}
      {(result?.range || startLine !== undefined || endLine !== undefined) && (
        <div className="flex flex-wrap gap-2">
          {result?.range ? (
            <Badge variant="outline">
              {t('chat.skill.lines', result.range)}
            </Badge>
          ) : (
            <>
              {startLine !== undefined && (
                <Badge variant="outline">
                  {t('chat.readFile.offset', { line: startLine })}
                </Badge>
              )}
              {endLine !== undefined && (
                <Badge variant="outline">
                  {t('chat.skill.endLine', { line: endLine })}
                </Badge>
              )}
            </>
          )}
        </div>
      )}
      {input
        ? extra && Object.keys(extra).length > 0 && <ToolInput input={extra} />
        : part.input !== undefined && <ToolInput input={part.input} />}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t('chat.toolError')}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {error}
          </AlertDescription>
        </Alert>
      )}
      {result &&
        !result.isError &&
        (result.notice || result.content === '' ? (
          <p
            role="status"
            className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]"
          >
            {result.content || t('chat.skill.empty')}
          </p>
        ) : markdown ? (
          <Tabs
            key={part.toolCallId}
            defaultValue="preview"
            className="min-w-0 gap-3"
          >
            <TabsList>
              <TabsTrigger value="preview">{t('skills.preview')}</TabsTrigger>
              <TabsTrigger value="source">
                {t('skills.sourceContent')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="preview" className="min-w-0 text-sm leading-6">
              <SkillMarkdown content={result.content} />
            </TabsContent>
            <TabsContent value="source" className="min-w-0">
              <FileCode
                filename={path ?? 'SKILL.md'}
                code={result.content}
                showLineNumbers={false}
              />
            </TabsContent>
          </Tabs>
        ) : (
          <FileCode
            filename={path}
            code={result.content}
            showLineNumbers={false}
          />
        ))}
      {!result && <ToolOutput output={part.output} errorText={undefined} />}
      {pending && part.output === undefined && !failed && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('chat.skill.waiting')}
        </p>
      )}
    </div>
  );
}
