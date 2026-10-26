import { useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@app/plugin-ui';
import { Archive, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { StrategyStatus, StrategySummary } from '../../strategy-types';
import { errorText } from './format';

export function LifecycleActions({
  pluginId,
  strategy,
  busy,
  dirty,
  onBusy,
  onChanged,
  onError,
}: {
  pluginId: string;
  strategy: StrategySummary;
  busy: boolean;
  dirty: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: (strategy: StrategySummary) => void;
  onError: (message: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  async function change(status: StrategyStatus) {
    onBusy(true);
    try {
      const next = await pluginRequest<StrategySummary>(
        pluginId,
        `/strategies/${strategy.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status, revision: strategy.revision }),
        },
      );
      onChanged(next);
      setDeleting(false);
      toast.success(
        status === 'active'
          ? '策略已恢复'
          : status === 'archived'
            ? '策略已归档'
            : '策略已移入回收站',
      );
    } catch (error) {
      const message = errorText(error);
      onError(message);
      toast.error(message);
    } finally {
      onBusy(false);
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={busy}
            aria-label="策略操作"
            title={dirty ? '请先保存草稿，再归档或删除策略' : '策略操作'}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {strategy.status === 'active' ? (
            <DropdownMenuItem
              disabled={dirty}
              onSelect={() => void change('archived')}
            >
              <Archive className="size-4" />
              归档策略
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void change('active')}>
              <RotateCcw className="size-4" />
              恢复到当前策略
            </DropdownMenuItem>
          )}
          {strategy.status !== 'deleted' && (
            <DropdownMenuItem
              variant="destructive"
              disabled={dirty}
              onSelect={() => setDeleting(true)}
            >
              <Trash2 className="size-4" />
              删除策略
            </DropdownMenuItem>
          )}
          {dirty && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              请先保存草稿
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除「{strategy.name}」？</DialogTitle>
            <DialogDescription>
              策略会移入回收站，脚本、已发布版本和回测记录均会保留，可随时恢复。已提交的回测和调优任务会继续执行。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || dirty}
              onClick={() => void change('deleted')}
            >
              {busy ? '删除中…' : '移入回收站'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
