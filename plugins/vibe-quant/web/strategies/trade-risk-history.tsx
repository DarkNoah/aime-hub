import { useState } from 'react';
import {
  Badge,
  Button,
  ScrollArea,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/plugin-ui';
import type { RiskLevelRecord } from '../../strategy-types';
import { dateTime, number } from './format';

export function TradeRiskHistory({
  records,
  triggeredId,
  visible,
  onVisibleChange,
  onNavigate,
}: {
  records: readonly RiskLevelRecord[];
  triggeredId?: string | null;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  onNavigate: (time: number) => void;
}) {
  const [page, setPage] = useState(0);
  if (!records.length)
    return (
      <p className="border-b px-4 py-2 text-xs text-muted-foreground">
        本次回测未记录这笔交易的止盈止损。脚本返回 RiskLevels
        后重新回测即可显示。
      </p>
    );
  return (
    <div className="border-b px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <Switch
            checked={visible}
            onCheckedChange={onVisibleChange}
            aria-label="显示策略止盈止损"
          />
          策略止盈止损
        </label>
        <span className="text-rose-600 dark:text-rose-400">■ 止盈范围</span>
        <span className="text-emerald-600 dark:text-emerald-400">
          ■ 止损范围
        </span>
        <Badge variant="outline">{records.length} 次计算</Badge>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground">
          计算记录 · 按计算时间分段绘制，点击时间定位
        </summary>
        <ScrollArea className="mt-2 h-52">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>计算时间</TableHead>
                <TableHead>止盈</TableHead>
                <TableHead>止损</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.slice(page * 30, (page + 1) * 30).map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => onNavigate(record.time)}
                    >
                      {dateTime(record.time)}
                    </Button>
                    {record.id === triggeredId && (
                      <Badge variant="outline" className="ml-2">
                        触发平仓依据
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {record.take_profit === null
                      ? '未设置'
                      : number(record.take_profit)}
                  </TableCell>
                  <TableCell>
                    {record.stop_loss === null
                      ? '未设置'
                      : number(record.stop_loss)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
        {records.length > 30 && (
          <div className="mt-2 flex items-center justify-end gap-3">
            <span>
              {page + 1} / {Math.ceil(records.length / 30)}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!page}
              onClick={() => setPage(page - 1)}
            >
              上一页计算
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={(page + 1) * 30 >= records.length}
              onClick={() => setPage(page + 1)}
            >
              下一页计算
            </Button>
          </div>
        )}
      </details>
    </div>
  );
}
