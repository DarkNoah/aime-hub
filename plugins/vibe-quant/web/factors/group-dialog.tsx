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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@app/plugin-ui';
import type { FactorGroup } from '../../factor-types';
import { groupDescendants, groupOptions } from '../../factor-groups';

export type GroupAction =
  | { type: 'create'; parent_id: string | null }
  | { type: 'edit' | 'delete'; group: FactorGroup };

export function GroupDialog({
  action,
  groups,
  busy,
  onClose,
  onSave,
}: {
  action: GroupAction;
  groups: FactorGroup[];
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, parent_id: string | null) => void;
}) {
  const [name, setName] = useState(
    action.type === 'create' ? '' : action.group.name,
  );
  const [parent, setParent] = useState(
    (action.type === 'create' ? action.parent_id : action.group.parent_id) ??
      'root',
  );
  const excluded =
    action.type === 'create'
      ? new Set<string>()
      : groupDescendants(groups, action.group.id);
  const deleting = action.type === 'delete';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {deleting
              ? `删除“${name}”`
              : action.type === 'create'
                ? '新建因子组'
                : '编辑因子组'}
          </DialogTitle>
          <DialogDescription>
            {deleting
              ? '此组及其子组将被删除，其中的因子会移到“未分类”。因子代码、已发布版本和分析报告都会保留。'
              : '按研究主题组织因子，可选择上级分组建立多级目录。'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(name.trim(), parent === 'root' ? null : parent);
          }}
        >
          {!deleting && (
            <>
              <Label className="grid gap-2">
                分组名称
                <Input
                  autoFocus
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  placeholder="例如：趋势与动量"
                />
              </Label>
              <Label className="grid gap-2">
                上级分组
                <Select
                  value={parent}
                  onValueChange={setParent}
                  disabled={busy}
                >
                  <SelectTrigger aria-label="上级分组">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="root">根目录</SelectItem>
                    {groupOptions(groups)
                      .filter((g) => !excluded.has(g.id))
                      .map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Label>
            </>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              variant={deleting ? 'destructive' : 'default'}
              disabled={busy || !name.trim()}
            >
              {busy ? '保存中…' : deleting ? '删除分组' : '保存分组'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
