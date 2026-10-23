import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  jsonFieldsError,
  parseJsonFields,
  serializeJsonFields,
  type JsonField,
} from './json-object-fields';

const kinds = { string: '文本', number: '数字', boolean: '开关', json: 'JSON' };
export function JsonObjectEditor({
  value,
  onChange,
  label = '参数',
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  readOnly?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState(jsonFieldsError(value) ? 'json' : 'form');
  const [fields, setFields] = useState<JsonField[]>(() =>
    jsonFieldsError(value) ? [] : parseJsonFields(value),
  );
  const [previous, setPrevious] = useState(value);
  const [emitted, setEmitted] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<JsonField['kind']>('number');
  const [addError, setAddError] = useState('');
  const error = jsonFieldsError(value);
  if (previous !== value) {
    setPrevious(value);
    if (emitted !== value) {
      if (!error) setFields(parseJsonFields(value));
      else setMode('json');
    }
  }
  function update(next: JsonField[]) {
    setFields(next);
    const source = serializeJsonFields(next);
    setEmitted(source);
    onChange(source);
  }
  function changeMode(next: string) {
    if (next === 'form') {
      if (error) return;
      setFields(parseJsonFields(value));
    }
    setMode(next);
  }
  return (
    <Tabs
      value={mode}
      onValueChange={changeMode}
      aria-label={label}
      className="min-w-0 gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!!error}
              onClick={() => {
                setName('');
                setAddError('');
                setAdding(true);
              }}
            >
              <Plus className="size-3.5" />
              添加参数
            </Button>
          )}
          <TabsList aria-label={`${label}编辑方式`} className="h-8">
            <TabsTrigger
              value="form"
              disabled={!!error && mode === 'json'}
              className="text-xs"
            >
              表单
            </TabsTrigger>
            <TabsTrigger value="json" className="text-xs">
              JSON
            </TabsTrigger>
          </TabsList>
        </div>
      </div>
      <TabsContent value={mode}>
        {mode === 'json' ? (
          <ScrollArea
            className="h-64"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <Textarea
              aria-label={`${label} JSON`}
              readOnly={readOnly}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
              className="min-h-64 resize-none font-mono text-xs"
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
            />
          </ScrollArea>
        ) : (
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
            {fields.map((field, index) => (
              <div
                key={field.key}
                className={`min-w-0 space-y-2 ${field.kind === 'json' ? 'sm:col-span-2 xl:col-span-3' : ''}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Label
                    htmlFor={`${id}-${index}`}
                    className="min-w-0 break-all font-mono text-xs"
                  >
                    {field.key}
                  </Label>
                  <Badge
                    variant="outline"
                    className="ml-auto shrink-0 text-[10px]"
                  >
                    {kinds[field.kind]}
                  </Badge>
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除参数 ${field.key}`}
                      onClick={() =>
                        update(fields.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                  )}
                </div>
                {field.kind === 'boolean' ? (
                  <Switch
                    id={`${id}-${index}`}
                    checked={field.value === 'true'}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      update(
                        fields.map((f, i) =>
                          i === index ? { ...f, value: String(checked) } : f,
                        ),
                      )
                    }
                  />
                ) : field.kind === 'json' ? (
                  <ScrollArea
                    className="h-40"
                    viewportProps={{ className: '[&>div]:block!' }}
                  >
                    <Textarea
                      id={`${id}-${index}`}
                      readOnly={readOnly}
                      value={field.value}
                      spellCheck={false}
                      className="min-h-40 resize-none font-mono text-xs"
                      onChange={(e) =>
                        update(
                          fields.map((f, i) =>
                            i === index ? { ...f, value: e.target.value } : f,
                          ),
                        )
                      }
                    />
                  </ScrollArea>
                ) : (
                  <Input
                    id={`${id}-${index}`}
                    type={field.kind === 'number' ? 'number' : 'text'}
                    step={field.kind === 'number' ? 'any' : undefined}
                    readOnly={readOnly}
                    value={field.value}
                    className="tabular-nums"
                    onChange={(e) =>
                      update(
                        fields.map((f, i) =>
                          i === index ? { ...f, value: e.target.value } : f,
                        ),
                      )
                    }
                  />
                )}
              </div>
            ))}
            {!fields.length && (
              <p className="py-4 text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">
                暂无参数{!readOnly && '，可添加参数或切换 JSON 填写'}。
              </p>
            )}
          </div>
        )}
      </TabsContent>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加参数</DialogTitle>
            <DialogDescription>
              参数名需与脚本读取的名称一致。
            </DialogDescription>
          </DialogHeader>
          <Label className="grid gap-2">
            参数名
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setAddError('');
              }}
            />
          </Label>
          <Label className="grid gap-2">
            类型
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as JsonField['kind'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(kinds).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          {addError && (
            <p role="alert" className="text-sm text-destructive">
              {addError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                const key = name.trim();
                const current = parseJsonFields(value);
                if (!key || current.some((field) => field.key === key)) {
                  setAddError('参数名不能为空或重复');
                  return;
                }
                update([
                  ...current,
                  {
                    key,
                    kind,
                    value:
                      kind === 'number'
                        ? '0'
                        : kind === 'boolean'
                          ? 'false'
                          : kind === 'json'
                            ? '{}'
                            : '',
                  },
                ]);
                setMode('form');
                setAdding(false);
              }}
            >
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
