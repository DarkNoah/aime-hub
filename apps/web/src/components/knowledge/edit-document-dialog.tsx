import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  KnowledgeDocument,
  KnowledgeBase,
  KnowledgeDocumentDetail,
} from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ImportDialog } from './import-dialog';
import { knowledgeError } from './errors';
export function EditDocumentDialog({
  id,
  base,
  newVersion = false,
  locked,
  onClose,
  onSaved,
}: {
  id: string;
  base: KnowledgeBase;
  newVersion?: boolean;
  locked: boolean;
  onClose: () => void;
  onSaved: (document: KnowledgeDocument) => void;
}) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<KnowledgeDocumentDetail>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const c = new AbortController();
    void api.knowledge
      .document({ id }, { signal: c.signal })
      .then(setDocument)
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [id]);
  if (document)
    return (
      <ImportDialog
        baseId={document.baseId}
        document={document}
        fields={base.fields}
        embeddingEnabled={!!base.embeddingModel}
        newVersion={newVersion}
        locked={
          locked ||
          document.status === 'processing' ||
          (newVersion && document.status === 'pending')
        }
        onClose={onClose}
        onImported={onSaved}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge.editDocument')}</DialogTitle>
          <DialogDescription>
            {t('knowledge.editDocumentHint')}
          </DialogDescription>
        </DialogHeader>
        <p role={error ? 'alert' : 'status'}>
          {t(error ? knowledgeError(error) : 'knowledge.loading')}
        </p>
      </DialogContent>
    </Dialog>
  );
}
