import { isToolUIPart } from 'ai';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  knowledgeHitSchema,
  knowledgeSearchResultSchema,
} from '@aime/shared/knowledge';
import { Badge } from '@/components/ui/badge';
import { KnowledgeHitBadges } from '@/components/knowledge/hit-badges';
import { ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import type { PreviewPart } from './selection';

const outputSchema = z.object({
  results: z.array(
    z.union([
      knowledgeSearchResultSchema.transform((hit) => ({
        ...hit,
        documentId: hit.item_id,
        text: hit.content,
        metadata: hit.extendValues,
      })),
      // Previously saved messages may use the internal hit shape.
      knowledgeHitSchema,
    ]),
  ),
});
const baseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  scope: z.string(),
  permission: z.enum(['owner', 'read', 'edit']),
  itemCount: z.number().optional(),
  extendColumns: z
    .array(z.object({ name: z.string(), columnType: z.string() }))
    .optional(),
});
const documentSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  name: z.string(),
  status: z.enum(['pending', 'processing', 'ready', 'failed']),
  version: z.number().optional(),
  deletedAt: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.json()).optional(),
});
const managementSchema = z.union([
  z.object({ bases: z.array(baseSchema) }),
  z.object({ base: baseSchema }),
  z.object({
    document: documentSchema,
  }),
  z.object({
    documents: z.array(documentSchema),
    errors: z
      .array(z.object({ path: z.string(), error: z.string() }))
      .optional(),
  }),
  z.object({
    id: z.string(),
    baseId: z.string(),
    name: z.string(),
    content: z.string(),
    image: z
      .object({
        data: z.string(),
        mimeType: z.enum([
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/gif',
          'image/bmp',
        ]),
      })
      .optional(),
    nextOffset: z.number().nullable(),
    version: z.number().optional(),
    metadata: z.record(z.string(), z.json()).optional(),
    versions: z
      .array(
        z.object({
          version: z.number(),
          name: z.string(),
          createdAt: z.string(),
        }),
      )
      .optional(),
  }),
]);
export function KnowledgeManagementPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const parsed = managementSchema.safeParse(part.output);
  const data = parsed.success ? parsed.data : undefined;
  const bases =
    data && 'bases' in data
      ? data.bases
      : data && 'base' in data
        ? [data.base]
        : [];
  const documents =
    data && 'document' in data
      ? [data.document]
      : data && 'documents' in data
        ? data.documents
        : [];
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">{t('nav.knowledge')}</h3>
      <ToolInput input={part.input} />
      {!data ? (
        <ToolOutput output={part.output} errorText={part.errorText} />
      ) : (
        <>
          {bases.map((base) => (
            <div key={base.id} className="space-y-2 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium">{base.name}</h4>
                <Badge variant="outline">
                  {t(`knowledge.permission.${base.permission}`)}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {base.description}
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {base.id}
              </p>
              {base.itemCount !== undefined && (
                <Badge variant="secondary">
                  {t('knowledge.documentCount', { count: base.itemCount })}
                </Badge>
              )}
              <div className="flex flex-wrap gap-1">
                {base.extendColumns?.map((field) => (
                  <Badge key={field.name} variant="outline">
                    {field.name} · {field.columnType}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
          {documents.map((document) => (
            <div key={document.id} className="space-y-2 rounded-lg border p-4">
              <h4 className="text-sm font-medium">{document.name}</h4>
              <Badge variant="secondary">
                {t(
                  document.deletedAt
                    ? 'knowledge.archived'
                    : `knowledge.${document.status}`,
                )}
              </Badge>
              {document.version !== undefined && (
                <Badge variant="outline">v{document.version}</Badge>
              )}
              <p className="break-all font-mono text-xs text-muted-foreground">
                {document.id}
              </p>
              <MetadataBadges metadata={document.metadata} />
            </div>
          ))}
          {'errors' in data &&
            data.errors?.map((error) => (
              <p key={error.path} className="text-sm text-destructive">
                {error.path}: {error.error}
              </p>
            ))}
          {'content' in data && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">{data.name}</h4>
              {data.version !== undefined && (
                <Badge variant="outline">v{data.version}</Badge>
              )}
              <MetadataBadges metadata={data.metadata} />
              {data.image && (
                <img
                  src={`data:${data.image.mimeType};base64,${data.image.data}`}
                  alt={data.name}
                  className="max-h-96 max-w-full rounded-lg object-contain"
                />
              )}
              <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                {data.content}
              </p>
              {data.nextOffset !== null && (
                <Badge variant="outline">
                  {t('knowledge.loadMore')} · {data.nextOffset}
                </Badge>
              )}
              {data.versions?.map((version) => (
                <p
                  key={version.version}
                  className="text-xs text-muted-foreground"
                >
                  v{version.version} · {version.name} ·{' '}
                  {new Date(version.createdAt).toLocaleString()}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
function MetadataBadges({ metadata }: { metadata?: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(metadata ?? {}).map(([key, value]) => (
        <Badge
          key={key}
          variant="outline"
          className="max-w-full break-all whitespace-normal"
        >
          {key}: {typeof value === 'string' ? value : JSON.stringify(value)}
        </Badge>
      ))}
    </div>
  );
}
export function KnowledgePreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const parsed = outputSchema.safeParse(part.output);
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">{t('nav.knowledge')}</h3>
      <ToolInput input={part.input} />
      {parsed.success ? (
        <div className="space-y-3">
          {parsed.data.results.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('knowledge.noResults')}
            </p>
          )}
          {parsed.data.results.map((hit) => (
            <div key={hit.id} className="space-y-2 rounded-lg border p-4">
              <Badge variant="outline">{hit.baseName}</Badge>
              <h4 className="text-sm font-medium">{hit.name}</h4>
              <KnowledgeHitBadges hit={hit} />
              <MetadataBadges metadata={hit.metadata} />
              <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                {hit.text}
              </p>
              {hit.sourceUrl && /^https?:\/\//i.test(hit.sourceUrl) && (
                <a
                  href={hit.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block break-all text-xs text-primary underline"
                >
                  {hit.sourceUrl}
                </a>
              )}
            </div>
          ))}
        </div>
      ) : (
        <ToolOutput output={part.output} errorText={part.errorText} />
      )}
    </div>
  );
}
