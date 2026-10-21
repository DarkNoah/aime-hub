import { useId, useState } from 'react';
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
} from '@app/plugin-ui';
import { CalendarDays } from 'lucide-react';
import { jumpTimestamp, marketDate } from './chart-navigation';
import { barLabelTime } from './chart-time';

export function DateJump({
  defaultTime,
  duration,
  loading,
  onJump,
}: {
  defaultTime?: number;
  duration: number;
  loading: boolean;
  onJump: (time: number) => Promise<boolean>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [error, setError] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={() => {
          setDate(
            marketDate(
              defaultTime === undefined
                ? Date.now() / 1000
                : barLabelTime(defaultTime, duration),
            ),
          );
          setError('');
          setOpen(true);
        }}
      >
        <CalendarDays className="size-4" />
        日期跳转
      </Button>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const timestamp = jumpTimestamp(date, time, duration);
            if (timestamp === null) {
              setError('请选择有效的日期和时间');
              return;
            }
            setError('');
            void onJump(timestamp).then((success) => {
              if (success) setOpen(false);
            });
          }}
          className="space-y-5"
        >
          <DialogHeader>
            <DialogTitle>跳转到日期</DialogTitle>
            <DialogDescription>
              按中国标准时间（UTC+8）定位 K 线，并显示前后各 100
              根。休市时定位到最近可用的 K 线。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${id}-date`}>日期</Label>
            <Input
              id={`${id}-date`}
              type="date"
              required
              value={date}
              disabled={loading}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-time`}>时间（可选）</Label>
            <Input
              id={`${id}-time`}
              type="time"
              value={time}
              disabled={loading}
              onChange={(event) => setTime(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {duration < 86400 && '时间按 K 线结束时间填写。'}
              留空时从当天 00:00 定位。
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? '正在定位…' : '跳转到 K 线'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
