import { useState } from 'react';
import {
  Badge,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
} from '@app/plugin-ui';
import {
  ArrowDownRight,
  ArrowUpRight,
  MoveUpRight,
  Check,
  ChevronDown,
  Eraser,
  Layers,
  ListFilter,
  Minus,
  MousePointer2,
  PencilRuler,
  Slash,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import {
  isTwoPointTool,
  type DrawingState,
  type DrawingTool,
  type FibonacciOptions,
} from './model';

const TOOLS = [
  {
    tool: 'trend',
    label: '趋势线',
    icon: TrendingUp,
    detail: '连接两个价格点',
  },
  {
    tool: 'ray',
    label: '射线',
    icon: MoveUpRight,
    detail: '从起点沿第二点方向延伸',
  },
  {
    tool: 'segment',
    label: '线段',
    icon: Slash,
    detail: '仅连接起点和终点',
  },
  {
    tool: 'horizontal',
    label: '水平线',
    icon: Minus,
    detail: '标记支撑或阻力',
  },
  {
    tool: 'fibonacci',
    label: '斐波那契回撤',
    icon: ListFilter,
    detail: '两点测量回撤比例与价位',
  },
  {
    tool: 'long',
    label: '多头仓位',
    icon: ArrowUpRight,
    detail: '止盈在上，止损在下',
  },
  {
    tool: 'short',
    label: '空头仓位',
    icon: ArrowDownRight,
    detail: '止盈在下，止损在上',
  },
] as const;

export function DrawingToolbar({
  state,
  onTool,
  onDelete,
  onClear,
  onCrossPeriod,
  onFibonacciOptions,
}: {
  state: DrawingState;
  onTool: (tool: DrawingTool) => void;
  onDelete: () => void;
  onClear: () => void;
  onCrossPeriod: (value: boolean) => void;
  onFibonacciOptions: (options: Partial<FibonacciOptions>) => void;
}) {
  const [clearOpen, setClearOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const active = TOOLS.find(({ tool }) => tool === state.tool);
  const ActiveIcon = active?.icon ?? PencilRuler;
  return (
    <>
      <div
        role="toolbar"
        aria-label="图表划线工具"
        aria-orientation="vertical"
        className="order-first flex w-11 shrink-0 flex-col items-center gap-1 border-r bg-muted/20 px-1 py-2"
      >
        <Button
          variant={state.tool === 'cursor' ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label="选择和拖动"
          aria-pressed={state.tool === 'cursor'}
          title="选择和拖动"
          onClick={() => onTool('cursor')}
        >
          <MousePointer2 className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={active ? 'secondary' : 'ghost'}
              size="icon-sm"
              className="relative"
              aria-label="划线工具"
              title={active ? `划线工具：${active.label}` : '划线工具'}
            >
              <ActiveIcon
                className={`size-4 ${state.tool === 'long' ? 'text-rose-600 dark:text-rose-400' : state.tool === 'short' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}
              />
              <ChevronDown className="absolute right-0 bottom-0 size-2.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="start"
            className="w-56 max-w-[calc(100vw-4rem)] motion-reduce:animate-none"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuLabel>划线工具</DropdownMenuLabel>
            {TOOLS.map(({ tool, label, icon: Icon, detail }) => (
              <div key={tool}>
                {tool === 'long' && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  aria-label={`绘制${label}`}
                  onSelect={() => requestAnimationFrame(() => onTool(tool))}
                  className="gap-3 py-2"
                >
                  <Icon
                    className={`size-4 ${tool === 'long' ? 'text-rose-600 dark:text-rose-400' : tool === 'short' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}
                  />
                  <span className="flex-1">
                    <span className="block">{label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {detail}
                    </span>
                  </span>
                  {state.tool === tool && <Check className="size-3.5" />}
                </DropdownMenuItem>
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="my-1 w-5 border-t" />
        <Button
          variant={state.crossPeriod ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label="划线显示设置"
          title={
            state.selectedFibonacci
              ? '斐波那契回撤与跨周期设置'
              : state.selected
                ? '选中划线的跨周期设置'
                : '新划线的跨周期设置'
          }
          onClick={() => setSettingsOpen(true)}
        >
          <Layers className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="删除选中划线"
          title="删除选中划线（Delete）"
          disabled={!state.selected}
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="清空划线"
          title="清空当前视图的划线"
          disabled={!state.count}
          onClick={() => setClearOpen(true)}
        >
          <Eraser className="size-4" />
        </Button>
        {!!state.count && (
          <Badge
            variant="secondary"
            className="mt-1 max-w-full px-1.5 text-[10px] tabular-nums"
            aria-label={`${state.count} 条划线`}
          >
            {state.count}
          </Badge>
        )}
      </div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>划线显示设置</DialogTitle>
            <DialogDescription>
              {state.selected
                ? '设置选中划线的显示范围。'
                : '设置当前标的新划线的默认显示范围。'}
              跨周期划线在同一标的的所有周期共享，编辑和删除同步生效。
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
            {state.selected ? '此线跨周期显示' : '新线跨周期显示'}
            <Switch
              aria-label="跨周期显示"
              checked={state.crossPeriod}
              onCheckedChange={onCrossPeriod}
            />
          </label>
          {state.selectedFibonacci && (
            <div className="space-y-3 rounded-md border p-3">
              <p className="text-sm font-medium">斐波那契回撤</p>
              <p className="text-xs text-muted-foreground">
                档位：0%、23.6%、38.2%、50%、61.8%、78.6%、100%。 默认起点为
                100%，终点为 0%。
              </p>
              {(
                [
                  ['reverse', '反转回撤方向'],
                  ['extendLeft', '向左延伸'],
                  ['extendRight', '向右延伸'],
                  ['background', '显示背景色带'],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-4 text-sm"
                >
                  {label}
                  <Switch
                    aria-label={label}
                    checked={state.selectedFibonacci![key]}
                    onCheckedChange={(value) =>
                      onFibonacciOptions({ [key]: value })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSettingsOpen(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>清空划线</DialogTitle>
            <DialogDescription>
              删除当前视图的 {state.count} 条划线。
              {state.sharedCount > 0 &&
                `其中 ${state.sharedCount} 条跨周期线也会从该标的的其他周期删除。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onClear();
                setClearOpen(false);
              }}
            >
              清空全部划线
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DrawingHint({ state }: { state: DrawingState }) {
  const positionDirection = (side: 'long' | 'short') =>
    side === 'long' ? '上拉止盈，下拉止损' : '上拉止损，下拉止盈';
  const hint = isTwoPointTool(state.tool)
    ? state.placingEnd
      ? state.tool === 'ray'
        ? '点击第二点确定延伸方向，Esc 取消'
        : state.tool === 'fibonacci'
          ? '点击波段终点（0%）完成回撤，Esc 取消'
          : '点击终点完成，Esc 取消'
      : state.tool === 'ray'
        ? '在主图点击起点，再点击第二点，射线沿此方向延伸'
        : state.tool === 'fibonacci'
          ? '依次点击波段起点（100%）和终点（0%）'
          : '在主图 K 线区域点击起点和终点'
    : state.tool === 'horizontal'
      ? '在主图点击放置水平线，Esc 取消'
      : state.tool === 'long' || state.tool === 'short'
        ? state.placingEnd
          ? `${positionDirection(state.tool)}；点击或松开完成，Esc 取消`
          : `点击或按住入场点，${positionDirection(state.tool)}`
        : state.selected
          ? state.selectedPosition
            ? `${state.selectedPosition === 'long' ? '多头' : '空头'}：${positionDirection(state.selectedPosition)}，拖动区域可整体移动`
            : '拖动图形或控制点调整，Delete 删除'
          : '';
  return hint ? (
    <p
      role="status"
      className="pointer-events-none absolute top-2 left-3 z-10 max-w-[calc(100%-1.5rem)] rounded border bg-card/95 px-2 py-1 text-xs text-muted-foreground"
    >
      {hint}
    </p>
  ) : null;
}
