import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  knowledgeLocked,
  knowledgeFieldSchema,
  type KnowledgeField,
  type KnowledgeBase,
  type KnowledgeScope,
} from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ModelSelector } from '@/components/model-selector';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FieldsEditor } from './fields-editor';
import { knowledgeError } from './errors';

export function BaseDialog({
  scope,
  base,
  onClose,
  onSaved,
}: {
  scope: KnowledgeScope;
  base?: KnowledgeBase;
  onClose: () => void;
  onSaved: (base: KnowledgeBase) => void;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<KnowledgeField[]>(base?.fields ?? []);
  const fieldsValid =
    new Set(fields.map((f) => f.name)).size === fields.length &&
    fields.every((f) => knowledgeFieldSchema.safeParse(f).success);
  const [name, setName] = useState(base?.name ?? '');
  const [description, setDescription] = useState(base?.description ?? '');
  const [model, setModel] = useState<string | null>(
    base?.rebuild
      ? base.rebuild.embeddingModel
      : (base?.embeddingModel ?? null),
  );
  const [rerank, setRerank] = useState<string | null>(
    base?.rebuild ? base.rebuild.rerankModel : (base?.rerankModel ?? null),
  );
  const [loadingDefaults, setLoadingDefaults] = useState(!base);
  const [defaultsError, setDefaultsError] = useState(false);
  const locked = base ? knowledgeLocked(base) || !base.canManage : false;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (base) return;
    const c = new AbortController();
    void api.knowledge
      .modelDefaults(undefined, { signal: c.signal })
      .then((defaults) => {
        setModel(defaults.embeddingModel);
        setRerank(defaults.rerankModel);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setDefaultsError(true);
          toast.error(t(knowledgeError(e)));
        }
      })
      .finally(() => {
        if (!c.signal.aborted) setLoadingDefaults(false);
      });
    return () => c.abort();
  }, [base, t]);
  async function resetDefaults() {
    setLoadingDefaults(true);
    try {
      const defaults = await api.knowledge.modelDefaults();
      setModel(defaults.embeddingModel);
      setRerank(defaults.rerankModel);
      setDefaultsError(false);
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setLoadingDefaults(false);
    }
  }
  async function save() {
    if (
      !name.trim() ||
      !fieldsValid ||
      busy ||
      locked ||
      loadingDefaults ||
      defaultsError
    )
      return;
    setBusy(true);
    try {
      const result = base
        ? await api.knowledge.update({
            id: base.id,
            data: {
              name,
              description,
              embeddingModel: model,
              rerankModel: rerank,
            },
          })
        : await api.knowledge.create({
            scope,
            data: {
              fields,
              name,
              description,
              embeddingModel: model,
              rerankModel: rerank,
            },
          });
      onSaved(result);
      toast.success(
        t(
          knowledgeLocked(result)
            ? 'knowledge.rebuildQueued'
            : 'knowledge.saved',
        ),
      );
      onClose();
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="gap-0 p-0">
        <ScrollArea viewportProps={{ className: 'max-h-[90dvh]' }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-5 p-6"
          >
            <DialogHeader>
              <DialogTitle>
                {t(base ? 'knowledge.edit' : 'knowledge.create')}
              </DialogTitle>
              <DialogDescription>{t('knowledge.baseHint')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="kb-name">{t('knowledge.name')}</Label>
              <Input
                id="kb-name"
                value={name}
                maxLength={120}
                required
                disabled={busy || locked}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kb-description">
                {t('knowledge.description')}
              </Label>
              <Textarea
                id="kb-description"
                value={description}
                maxLength={2000}
                disabled={busy || locked}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('knowledge.embedding')}</Label>
              <ModelSelector
                label={t('knowledge.embedding')}
                modelType="embedding"
                value={model}
                onValueChange={setModel}
                disabled={busy || locked || loadingDefaults}
                noneLabel={t('knowledge.bm25')}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {t('knowledge.modelHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t('knowledge.rerank')}</Label>
              <ModelSelector
                label={t('knowledge.rerank')}
                modelType="rerank"
                value={rerank}
                onValueChange={setRerank}
                disabled={busy || locked || loadingDefaults}
                noneLabel={t('knowledge.noRerank')}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void resetDefaults()}
              disabled={busy || locked || loadingDefaults}
            >
              {t(
                loadingDefaults ? 'knowledge.loading' : 'knowledge.useDefaults',
              )}
            </Button>
            {base &&
              (model !== base.embeddingModel ||
                rerank !== base.rerankModel) && (
                <p className="rounded-lg bg-muted p-3 text-sm leading-6">
                  {t('knowledge.rebuildHint')}
                </p>
              )}
            <FieldsEditor
              fields={fields}
              onChange={setFields}
              disabled={!!base || busy || locked}
            />
            {!fieldsValid && (
              <p className="text-xs text-destructive">
                {t('knowledge.errorFields')}
              </p>
            )}
            {busy && !base && model && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('knowledge.probingEmbedding')}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={busy}
              >
                {t('knowledge.cancel')}
              </Button>
              <Button
                disabled={
                  !name.trim() ||
                  !fieldsValid ||
                  busy ||
                  locked ||
                  loadingDefaults ||
                  defaultsError
                }
              >
                {t(busy ? 'knowledge.saving' : 'knowledge.save')}
              </Button>
            </DialogFooter>
          </form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
