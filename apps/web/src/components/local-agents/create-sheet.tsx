import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';
import type {
  LocalAgentFile,
  LocalAgentIssue,
  LocalAgentScope,
} from '@aime/shared/agents';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { localAgentErrorKey } from './api';

const example =
  '---\nname: code-reviewer\ndisplayName: 代码审查助手\ndescription: Review correctness and maintainability\nenabled: true\n---\n\nReview the current changes and explain specific improvements.';

export function LocalAgentSheet({
  scope,
  agent,
  readOnly = false,
  onClose,
  onSaved,
  restoreFocus,
}: {
  scope: LocalAgentScope;
  agent?: LocalAgentFile;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (agent: LocalAgentFile) => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState(agent?.content ?? '');
  const [issues, setIssues] = useState<LocalAgentIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<HTMLInputElement>(null);

  async function save() {
    if (pending.current || readOnly) return;
    if (new TextEncoder().encode(content).length > 100_000) {
      toast.error(t('localAgents.fileInvalid'));
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      const body = { target: scope, format: 'md' as const, content };
      const result = agent
        ? await api.localAgents.update({
            body: { ...body, filename: agent.filename, version: agent.version },
          })
        : await api.localAgents.create({ body });
      if (!result.ok) {
        setIssues(result.issues);
        editor.current?.focus();
        toast.error(t('localAgents.invalid'));
        return;
      }
      onSaved(result.agent);
      toast.success(
        t(agent ? 'localAgents.updated' : 'localAgents.created', {
          filename: result.agent.filename,
        }),
      );
      onClose();
    } catch (error) {
      toast.error(t(localAgentErrorKey(error)));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-2xl"
        showCloseButton={!saving}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>
            {agent
              ? readOnly
                ? agent.displayName
                : t('localAgents.editNamed', { name: agent.displayName })
              : t('localAgents.create')}
          </SheetTitle>
          <SheetDescription>
            {agent ? agent.filename : t('localAgents.createHint')}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: '[&>div]:block!' }}
        >
          <div className="space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  {t(`localAgents.scope.${scope.scope}`)}
                </Badge>
                <Badge variant="outline">Markdown</Badge>
              </div>
              {!agent && (
                <>
                  <input
                    ref={upload}
                    type="file"
                    accept=".md"
                    className="hidden"
                    aria-label={t('localAgents.import')}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      if (file.size > 100_000 || !/\.md$/i.test(file.name)) {
                        toast.error(t('localAgents.fileInvalid'));
                        return;
                      }
                      void file
                        .text()
                        .then((text) => {
                          setContent(text);
                          setIssues([]);
                        })
                        .catch(() => toast.error(t('localAgents.fileInvalid')));
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => upload.current?.click()}
                  >
                    <Upload />
                    {t('localAgents.import')}
                  </Button>
                </>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="local-agent-content">
                {t('localAgents.content')}
              </Label>
              <p
                id="local-agent-fields"
                className="text-sm leading-6 text-muted-foreground"
              >
                {t('localAgents.requiredMd')}
              </p>
              <Textarea
                ref={editor}
                id="local-agent-content"
                className="min-h-80 resize-none font-mono text-sm leading-6"
                spellCheck={false}
                readOnly={readOnly}
                disabled={saving}
                value={content}
                placeholder={example}
                maxLength={100_000}
                aria-invalid={issues.length > 0}
                aria-describedby={
                  issues.length
                    ? 'local-agent-fields local-agent-errors'
                    : 'local-agent-fields'
                }
                onChange={(event) => {
                  setContent(event.target.value);
                  setIssues([]);
                }}
              />
              {!!issues.length && (
                <ul
                  id="local-agent-errors"
                  role="alert"
                  className="space-y-1 text-sm text-destructive"
                >
                  {issues.map((issue) => (
                    <li key={issue}>{t(`localAgents.issue.${issue}`)}</li>
                  ))}
                </ul>
              )}
            </div>
            {!readOnly && (
              <p className="text-sm leading-6 text-muted-foreground">
                {t(agent ? 'localAgents.editHint' : 'localAgents.storageHint')}
              </p>
            )}
          </div>
        </ScrollArea>
        <SheetFooter className="flex-row justify-end border-t px-6 py-4">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t('common.close')}
          </Button>
          {!readOnly && (
            <Button
              disabled={saving || !content.trim() || content === agent?.content}
              onClick={() => void save()}
            >
              {t(
                saving
                  ? 'users.saving'
                  : agent
                    ? 'agents.save'
                    : 'localAgents.create',
              )}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
