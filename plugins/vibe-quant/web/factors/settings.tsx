import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
  Textarea,
} from '@app/plugin-ui';
import type { FactorDraft } from '../../factor-types';

export function FactorSettings({
  initial,
  busy,
  onSave,
  onClose,
  creating = false,
}: {
  initial: FactorDraft;
  busy: boolean;
  creating?: boolean;
  onSave: (
    value: Pick<FactorDraft, 'name' | 'description' | 'enabled'>,
  ) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{creating ? '新建期货因子' : '因子设置'}</DialogTitle>
          <DialogDescription>
            {creating
              ? '从均线乖离模板开始，使用 Python 编写因子。'
              : '修改名称、描述和启用状态。停用后已有固定版本仍可被策略引用。'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(value);
          }}
        >
          <Label className="grid gap-2">
            名称
            <Input
              autoFocus
              required
              maxLength={100}
              value={value.name}
              disabled={busy}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
              placeholder="例如：20 日均线乖离"
            />
          </Label>
          <Label className="grid gap-2">
            描述
            <Textarea
              maxLength={2000}
              value={value.description}
              disabled={busy}
              onChange={(e) =>
                setValue({ ...value, description: e.target.value })
              }
              placeholder="说明因子的计算逻辑和方向"
            />
          </Label>
          <Label className="flex items-center justify-between">
            启用因子
            <Switch
              disabled={busy}
              checked={value.enabled}
              onCheckedChange={(enabled) => setValue({ ...value, enabled })}
            />
          </Label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button disabled={busy || !value.name.trim()}>
              {busy ? '保存中…' : creating ? '创建因子' : '保存设置'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
