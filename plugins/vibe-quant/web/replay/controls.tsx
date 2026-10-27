import {
  useEffect,
  useId,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@app/plugin-ui';
import {
  Crosshair,
  History,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import type { useCandleReplay } from './use-candle-replay';
import { useReplayStepControls } from './use-step-controls';
import { replayTimeInput } from './candle-replay';

export function ReplayControls({
  replay,
  duration,
  picking,
  onPickingChange,
  scope,
  defaultTime,
  disabled,
  navigation,
  historical,
  linkedStrategies = false,
}: {
  replay: ReturnType<typeof useCandleReplay>;
  duration: number;
  picking: boolean;
  onPickingChange: (value: boolean) => void;
  scope: RefObject<HTMLDivElement | null>;
  defaultTime?: number;
  disabled: boolean;
  navigation: ReactNode;
  historical: boolean;
  linkedStrategies?: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const session = replay.session;
  const startTime = session?.bars[session.startIndex]?.time;
  useEffect(() => {
    if (startTime !== undefined) setInput(replayTimeInput(startTime, duration));
  }, [startTime, duration]);
  const currentTime = session ? replay.bars.at(-1)?.time : undefined;
  const finished = replay.atEnd;
  const stepControls = useReplayStepControls({
    enabled: !!session && !picking && !replay.loading,
    sessionId: session?.id,
    speed: replay.speed,
    step: replay.stepBy,
    scope,
  });
  const busy = picking || replay.loading;
  return (
    <div className="shrink-0 border-t px-3 py-2" aria-label="K 线回放控制">
      {!expanded ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setInput(
                defaultTime === undefined
                  ? ''
                  : replayTimeInput(defaultTime, duration),
              );
              setExpanded(true);
              onPickingChange(true);
            }}
          >
            <History className="size-4" />K 线回放
          </Button>
          {navigation}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={picking ? 'secondary' : 'outline'}
              aria-pressed={picking}
              disabled={replay.loading}
              onClick={() => {
                replay.pause();
                onPickingChange(!picking);
              }}
            >
              <Crosshair className="size-4" />
              {picking ? '取消点选' : '点选 K 线'}
            </Button>
            <form
              className="flex min-w-0 flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onPickingChange(false);
                void replay.start(input);
              }}
            >
              <Label htmlFor={id} className="text-xs">
                回放起点
              </Label>
              <Input
                id={id}
                type="datetime-local"
                step="60"
                required
                value={input}
                aria-label="回放起点（北京时间）"
                className="h-8 w-[13rem] min-w-0 text-xs"
                disabled={replay.loading}
                onChange={(event) => setInput(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                type="submit"
                disabled={!input || replay.loading}
              >
                {replay.loading ? '定位中…' : session ? '重新定位' : '定位回放'}
              </Button>
            </form>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                replay.exit();
                setExpanded(false);
                onPickingChange(false);
              }}
            >
              <X className="size-4" />
              {session || replay.loading ? '退出回放' : '收起'}
            </Button>
          </div>
          {session && (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="播放控制"
            >
              <Button
                size="sm"
                onClick={replay.toggle}
                disabled={busy || finished || !!replay.error}
                aria-label={session.playing ? '暂停回放' : '播放回放'}
              >
                {session.playing ? (
                  <Pause className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
                {session.playing ? '暂停' : '播放'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="touch-none select-none"
                {...stepControls.buttonProps(-1)}
                disabled={busy || !replay.canRetreat}
                aria-keyshortcuts="ArrowLeft"
                title="按住持续回退，松开停止（←）"
              >
                <SkipBack className="size-4" />
                上一根
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="touch-none select-none"
                {...stepControls.buttonProps(1)}
                disabled={busy || !replay.canAdvance}
                aria-keyshortcuts="ArrowRight"
                title="按住持续前进，松开停止（→）"
              >
                <SkipForward className="size-4" />
                下一根
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={replay.restart}
                disabled={busy || session.index === session.startIndex}
              >
                <RotateCcw className="size-4" />
                重播
              </Button>
              <Select
                value={String(replay.speed)}
                onValueChange={(value) => replay.setSpeed(Number(value))}
              >
                <SelectTrigger
                  size="sm"
                  className="w-28 text-xs"
                  aria-label="回放速度"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[2000, 1000, 500, 250, 100].map((speed) => (
                    <SelectItem key={speed} value={String(speed)}>
                      {speed / 1000} 秒 / 根
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <output
                aria-label="回放进度"
                aria-live="off"
                className="flex flex-wrap items-center gap-2 text-xs tabular-nums"
              >
                <Badge variant={session.playing ? 'default' : 'secondary'}>
                  {finished
                    ? '回放结束'
                    : session.playing
                      ? replay.waitingForStrategy
                        ? '等待策略计算…'
                        : replay.canAdvance
                          ? '回放中'
                          : '加载后续 K 线…'
                      : '已暂停'}
                </Badge>
                {currentTime !== undefined && (
                  <span>
                    {replayTimeInput(currentTime, duration).replace('T', ' ')} ·{' '}
                    {session.index < session.startIndex
                      ? `起点前 ${session.startIndex - session.index} 根`
                      : `已推进 ${session.index - session.startIndex} 根`}
                  </span>
                )}
              </output>
            </div>
          )}
          <div className="space-y-1 text-xs leading-5 text-muted-foreground">
            {picking && (
              <p role="status">点击图中 K 线作为起点，按 Esc 取消。</p>
            )}
            <p>
              {session
                ? `${linkedStrategies ? '策略随回放计算，回退同步恢复状态；页头、侧栏仍为最新行情。' : historical ? '成交标记随对应 K 线显示。' : '仅回放 K 线与指标，页头、侧栏仍为最新行情。'}按住上一根／下一根或 ←／→ 连续步进，松开即停。`
                : `按北京时间${duration < 86400 ? '及 K 线结束时间' : ''}定位；休市时取前一根，定位后先暂停。`}
            </p>
          </div>
          {replay.error && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 text-xs text-destructive"
            >
              <span>{replay.error}</span>
              {session && (
                <Button size="sm" variant="outline" onClick={replay.retry}>
                  重试加载
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
