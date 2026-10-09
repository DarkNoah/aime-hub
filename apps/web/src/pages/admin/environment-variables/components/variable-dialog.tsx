import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  environmentVariableInputSchema,
  type EnvironmentVariable,
} from '@aime/shared/environment-variables';
import { api } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';
import { PasswordInput } from '@/components/password-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { environmentVariableErrorKey } from '../api';

export type VariableAction =
  | { kind: 'create' }
  | { kind: 'edit' | 'delete'; variable: EnvironmentVariable };

export function VariableDialog({
  action,
  onClose,
  onSaved,
  onRemoved,
  restoreFocus,
}: {
  action: VariableAction;
  onClose: () => void;
  onSaved: (variable: EnvironmentVariable) => void;
  onRemoved: (id: string) => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const variable = action.kind === 'create' ? undefined : action.variable;
  const deleting = action.kind === 'delete';
  const [name, setName] = useState(variable?.name ?? '');
  const [value, setValue] = useState(variable?.value ?? '');
  const [description, setDescription] = useState(variable?.description ?? '');
  const [multiline, setMultiline] = useState(
    /[\r\n]/.test(variable?.value ?? ''),
  );
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<
    Partial<Record<'name' | 'value' | 'description' | 'form', TranslationKey>>
  >({});
  const submitting = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setErrors({});
    const parsed = environmentVariableInputSchema.safeParse({
      name,
      value,
      description,
    });
    if (!deleting && !parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'name') next.name = 'environmentVariables.nameHint';
        else if (field === 'value')
          next.value = 'environmentVariables.valueInvalid';
        else if (field === 'description')
          next.description = 'environmentVariables.descriptionInvalid';
      }
      setErrors(next);
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      if (deleting && variable) {
        await api.environmentVariables.remove({ params: { id: variable.id } });
        onRemoved(variable.id);
        toast.success(t('environmentVariables.deleted'));
      } else if (parsed.success) {
        const saved = variable
          ? await api.environmentVariables.update({
              params: { id: variable.id },
              body: parsed.data,
            })
          : await api.environmentVariables.create({ body: parsed.data });
        onSaved(saved);
        toast.success(
          t(
            variable
              ? 'environmentVariables.updated'
              : 'environmentVariables.created',
          ),
        );
      }
      onClose();
    } catch (error) {
      const key = environmentVariableErrorKey(error);
      setErrors(
        key === 'environmentVariables.conflict' ? { name: key } : { form: key },
      );
      toast.error(t(key));
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
        className="flex max-h-[90dvh] flex-col sm:max-w-xl"
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
            {t(
              deleting
                ? 'environmentVariables.delete'
                : variable
                  ? 'environmentVariables.edit'
                  : 'environmentVariables.create',
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              deleting
                ? 'environmentVariables.deleteHint'
                : 'environmentVariables.formHint',
              { name: variable?.name ?? '' },
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-col gap-5"
        >
          <ScrollArea
            className="min-h-0"
            viewportProps={{ className: 'max-h-[60dvh]' }}
          >
            <fieldset disabled={pending} className="min-w-0 space-y-5 p-1">
              {deleting ? (
                <code className="block break-all rounded-lg bg-muted p-3 text-sm">
                  {variable?.name}
                </code>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="variable-name">
                      {t('environmentVariables.name')}
                    </Label>
                    <Input
                      id="variable-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={128}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="API_KEY"
                      className="font-mono"
                      aria-invalid={!!errors.name}
                      aria-describedby="variable-name-hint"
                    />
                    <p
                      id="variable-name-hint"
                      className={
                        errors.name
                          ? 'text-xs text-destructive'
                          : 'text-xs text-muted-foreground'
                      }
                    >
                      {t(errors.name ?? 'environmentVariables.nameHint')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label htmlFor="variable-value">
                        {t('environmentVariables.value')}
                      </Label>
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor="variable-multiline"
                          className="text-xs text-muted-foreground"
                        >
                          {t('environmentVariables.multiline')}
                        </Label>
                        <Switch
                          id="variable-multiline"
                          checked={multiline}
                          disabled={pending || /[\r\n]/.test(value)}
                          onCheckedChange={setMultiline}
                        />
                      </div>
                    </div>
                    {multiline ? (
                      <Textarea
                        id="variable-value"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        maxLength={16384}
                        autoComplete="off"
                        spellCheck={false}
                        className="min-h-28 font-mono"
                        aria-invalid={!!errors.value}
                        aria-describedby="variable-value-hint"
                      />
                    ) : (
                      <PasswordInput
                        id="variable-value"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        disabled={pending}
                        maxLength={16384}
                        autoComplete="new-password"
                        autoCapitalize="none"
                        spellCheck={false}
                        showLabel={t('environmentVariables.showValues')}
                        hideLabel={t('environmentVariables.hideValues')}
                        className="font-mono"
                        aria-invalid={!!errors.value}
                        aria-describedby="variable-value-hint"
                      />
                    )}
                    <p
                      id="variable-value-hint"
                      className={
                        errors.value
                          ? 'text-xs text-destructive'
                          : 'text-xs text-muted-foreground'
                      }
                    >
                      {t(
                        errors.value ??
                          (multiline
                            ? 'environmentVariables.multilineHint'
                            : 'environmentVariables.valueHint'),
                      )}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="variable-description">
                      {t('environmentVariables.description')}
                    </Label>
                    <Textarea
                      id="variable-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      maxLength={1000}
                      rows={3}
                      aria-invalid={!!errors.description}
                      aria-describedby={
                        errors.description
                          ? 'variable-description-error'
                          : undefined
                      }
                    />
                    {errors.description ? (
                      <p
                        id="variable-description-error"
                        className="text-xs text-destructive"
                      >
                        {t(errors.description)}
                      </p>
                    ) : null}
                  </div>
                </>
              )}
              {errors.form ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(errors.form)}
                </p>
              ) : null}
            </fieldset>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              {t('environmentVariables.cancel')}
            </Button>
            <Button
              type="submit"
              variant={deleting ? 'destructive' : 'default'}
              disabled={pending}
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              {t(
                pending
                  ? 'environmentVariables.saving'
                  : deleting
                    ? 'environmentVariables.delete'
                    : 'environmentVariables.save',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
