import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { mcpCreateSchema, type McpServer } from '@aime/shared/mcp';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  formToInput,
  inputToForm,
  parseMcpJson,
  serializeMcpJson,
  type McpForm,
} from '../config';
import { mcpFormError } from '../api';
import { ServerForm } from './server-form';

export type McpAction =
  { kind: 'create' } | { kind: 'edit' | 'delete'; server: McpServer };

export function McpDialog({
  action,
  onClose,
  onSaved,
  onRemoved,
  restoreFocus,
}: {
  action: McpAction;
  onClose: () => void;
  onSaved: (servers: McpServer[]) => void;
  onRemoved: (id: string) => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const server = action.kind === 'create' ? undefined : action.server;
  const deleting = action.kind === 'delete';
  const [forms, setForms] = useState<McpForm[]>(() => [inputToForm(server)]);
  const [mode, setMode] = useState('form');
  const [json, setJson] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const formJson = useRef<string | undefined>(undefined);

  function switchMode(next: string) {
    if (next === mode || submitting.current) return;
    try {
      if (next === 'json') {
        const serialized = serializeMcpJson(forms.map(formToInput));
        formJson.current = serialized;
        setJson(serialized);
      } else if (json !== formJson.current) {
        setForms(parseMcpJson(json, !!server).map(inputToForm));
      }
      setMode(next);
      setError(undefined);
    } catch (cause) {
      setError(mcpFormError(cause, t));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError(undefined);
    let servers;
    if (!deleting) {
      try {
        servers = mcpCreateSchema.parse({
          servers:
            mode === 'json'
              ? parseMcpJson(json, !!server)
              : forms.map(formToInput),
        }).servers;
      } catch (cause) {
        setError(mcpFormError(cause, t));
        return;
      }
    }
    submitting.current = true;
    setPending(true);
    try {
      if (deleting && server) {
        await api.mcp.remove({
          params: { id: server.id },
          query: { revision: server.revision },
        });
        onRemoved(server.id);
        toast.success(t('mcp.deleted'));
      } else if (servers) {
        const saved = server
          ? [
              await api.mcp.update({
                params: { id: server.id },
                body: { ...servers[0], revision: server.revision },
              }),
            ]
          : await api.mcp.create({ body: { servers } });
        onSaved(saved);
        toast.success(
          t(server ? 'mcp.updated' : 'mcp.created', { count: saved.length }),
        );
      }
      onClose();
    } catch (cause) {
      const message = mcpFormError(cause, t);
      setError(message);
      toast.error(message);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-2xl"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          if (submitting.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {t(deleting ? 'mcp.delete' : server ? 'mcp.edit' : 'mcp.create')}
          </DialogTitle>
          <DialogDescription>
            {t(deleting ? 'mcp.deleteHint' : 'mcp.editorHint', {
              name: server?.name ?? '',
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={submit}
          className="flex min-h-0 flex-col gap-4"
        >
          <ScrollArea
            className="min-h-0"
            viewportProps={{ className: 'max-h-[62dvh]' }}
          >
            <fieldset disabled={pending} className="min-w-0 space-y-4 p-1">
              {deleting ? (
                <code className="block break-all rounded-md bg-muted p-3 text-sm">
                  {server?.name}
                </code>
              ) : (
                <Tabs value={mode} onValueChange={switchMode}>
                  <TabsList aria-label={t('mcp.inputMode')}>
                    <TabsTrigger value="form" disabled={pending}>
                      {t('mcp.form')}
                    </TabsTrigger>
                    <TabsTrigger value="json" disabled={pending}>
                      JSON
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="form" className="mt-3 space-y-6">
                    {forms.map((form, index) => (
                      <section
                        key={form.key}
                        className="space-y-4 border-b pb-6 last:border-0 last:pb-0"
                      >
                        {forms.length > 1 ? (
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-medium">
                              {form.name ||
                                t('mcp.serverNumber', { index: index + 1 })}
                            </h3>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('mcp.removeForm', {
                                index: index + 1,
                              })}
                              onClick={() =>
                                setForms((current) =>
                                  current.filter(
                                    (item) => item.key !== form.key,
                                  ),
                                )
                              }
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        ) : null}
                        <ServerForm
                          value={form}
                          disabled={pending}
                          onChange={(value) =>
                            setForms((current) =>
                              current.map((item) =>
                                item.key === value.key ? value : item,
                              ),
                            )
                          }
                        />
                      </section>
                    ))}
                    {!server ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={forms.length >= 50}
                        onClick={() =>
                          setForms((current) => [...current, inputToForm()])
                        }
                      >
                        <Plus />
                        {t('mcp.addAnother')}
                      </Button>
                    ) : null}
                  </TabsContent>
                  <TabsContent value="json" className="mt-3 space-y-2">
                    <Label htmlFor="mcp-json">{t('mcp.jsonConfig')}</Label>
                    <Textarea
                      id="mcp-json"
                      value={json}
                      onChange={(event) => setJson(event.target.value)}
                      rows={17}
                      className="font-mono text-xs leading-6"
                      spellCheck={false}
                      autoComplete="off"
                      aria-describedby="mcp-json-hint"
                    />
                    <p
                      id="mcp-json-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {t(server ? 'mcp.jsonEditHint' : 'mcp.jsonHint')}
                    </p>
                  </TabsContent>
                </Tabs>
              )}
            </fieldset>
          </ScrollArea>
          {error ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('mcp.cancel')}
            </Button>
            <Button
              type="submit"
              variant={deleting ? 'destructive' : 'default'}
              disabled={pending}
            >
              {pending ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : null}
              {t(pending ? 'mcp.saving' : deleting ? 'mcp.delete' : 'mcp.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
