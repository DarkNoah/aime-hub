import { useId, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@app/plugin-ui';
import { toast } from 'sonner';
import { defaultParameters, validateParameters } from './preferences';
import type {
  IndicatorDefinition,
  IndicatorParameters,
  IndicatorValue,
} from './types';

export function IndicatorSettingsDialog({
  definition,
  parameters,
  onClose,
  onSave,
}: {
  definition: IndicatorDefinition;
  parameters: IndicatorParameters;
  onClose: () => void;
  onSave: (parameters: IndicatorParameters) => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState(() => ({ ...parameters }));
  const [error, setError] = useState('');
  function change(key: string, value: IndicatorValue) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError('');
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b p-5 pr-12">
          <DialogTitle className="flex items-center gap-2">
            {definition.name} 设置
            <Badge variant="secondary">
              {definition.type === 'main' ? '主图' : '副图'}
            </Badge>
          </DialogTitle>
          <DialogDescription>{definition.description}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const issue = validateParameters(definition, draft);
            if (issue) {
              setError(issue);
              return;
            }
            onSave(draft);
            toast.success(`${definition.name} 参数已应用`);
            onClose();
          }}
        >
          <ScrollArea viewportProps={{ className: 'max-h-[55dvh]' }}>
            <div className="grid gap-4 p-5">
              {definition.parameters.map((parameter) => {
                const id = `${formId}-${parameter.key}`;
                return (
                  <div
                    key={parameter.key}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] items-center gap-x-4 gap-y-1"
                  >
                    <Label htmlFor={id}>{parameter.label}</Label>
                    {parameter.type === 'select' ? (
                      <Select
                        value={String(draft[parameter.key])}
                        onValueChange={(value) => change(parameter.key, value)}
                      >
                        <SelectTrigger id={id} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {parameter.options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : parameter.type === 'boolean' ? (
                      <Switch
                        id={id}
                        checked={Boolean(draft[parameter.key])}
                        onCheckedChange={(value) =>
                          change(parameter.key, value)
                        }
                      />
                    ) : parameter.type === 'color' ? (
                      <Input
                        id={id}
                        type="color"
                        value={String(draft[parameter.key])}
                        onChange={(event) =>
                          change(parameter.key, event.target.value)
                        }
                        className="w-full cursor-pointer p-1"
                      />
                    ) : (
                      <Input
                        id={id}
                        type="number"
                        value={String(draft[parameter.key])}
                        min={parameter.min}
                        max={parameter.max}
                        step={parameter.step ?? (parameter.integer ? 1 : 'any')}
                        onChange={(event) =>
                          change(
                            parameter.key,
                            event.target.value === ''
                              ? ''
                              : Number(event.target.value),
                          )
                        }
                      />
                    )}
                    {parameter.description && (
                      <p className="col-span-2 text-xs text-muted-foreground">
                        {parameter.description}
                      </p>
                    )}
                  </div>
                );
              })}
              {definition.source && (
                <p className="text-xs text-muted-foreground">
                  来源：
                  {definition.source.url ? (
                    <a
                      href={definition.source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {definition.source.name}
                    </a>
                  ) : (
                    definition.source.name
                  )}
                </p>
              )}
            </div>
          </ScrollArea>
          {error && (
            <p role="alert" className="px-5 pb-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="border-t p-4 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(defaultParameters(definition));
                setError('');
              }}
            >
              恢复默认
            </Button>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button type="submit">应用参数</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
