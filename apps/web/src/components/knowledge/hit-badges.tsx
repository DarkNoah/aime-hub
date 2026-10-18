import { useTranslation } from 'react-i18next';
import type { KnowledgeHit } from '@aime/shared/knowledge';
import { Badge } from '@/components/ui/badge';

export function KnowledgeHitBadges({ hit }: { hit: KnowledgeHit }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{t(`knowledge.${hit.mode}`)}</Badge>
      {hit.scores?.rerank !== undefined && (
        <Badge variant="outline">
          {`Rerank ${hit.scores.rerank.toFixed(3)}`}
        </Badge>
      )}
      {hit.scores && (
        <Badge variant="outline">{`RRF ${hit.scores.rrf.toFixed(4)}`}</Badge>
      )}
      {hit.fallbacks?.map((stage) => (
        <Badge key={stage} variant="outline">
          {t(
            stage === 'vector'
              ? 'knowledge.vectorFallback'
              : hit.fallbackReasons?.rerank === 'timeout'
                ? 'knowledge.rerankTimeout'
                : hit.fallbackReasons?.rerank === 'model_conflict'
                  ? 'knowledge.rerankModelConflict'
                  : hit.fallbackReasons?.rerank === 'invalid_response'
                    ? 'knowledge.rerankInvalid'
                    : 'knowledge.rerankFallback',
          )}
        </Badge>
      ))}
    </div>
  );
}
