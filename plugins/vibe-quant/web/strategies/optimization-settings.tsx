import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@app/plugin-ui';
import {
  OPTIMIZATION_METRICS,
  POINT_OPTIMIZATION_METRICS,
  type OptimizationConfig,
  type OptimizationMetric,
} from '../../optimization-types';

export const defaultOptimization: OptimizationConfig = {
  search_space: {},
  metric: 'sharpe',
  n_trials: 30,
  timeout_seconds: 600,
  seed: 42,
  min_trades: 1,
};

export function OptimizationSettings({
  value,
  onChange,
  space,
  onSpaceChange,
  validationStart,
  onValidationChange,
  points = false,
}: {
  value: OptimizationConfig;
  onChange: (value: OptimizationConfig) => void;
  space: string;
  onSpaceChange: (space: string) => void;
  validationStart: string;
  onValidationChange: (value: string) => void;
  points?: boolean;
}) {
  return (
    <section className="space-y-4 border-t pt-5">
      <h3 className="text-sm font-medium">搜索范围与验证</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        在同一份行情和交易规则下搜索参数，完成后将最佳参数保存为当前策略的新版本。
      </p>
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Label className="grid gap-2 text-xs">
            优化目标
            <Select
              value={value.metric}
              onValueChange={(metric) =>
                onChange({ ...value, metric: metric as OptimizationMetric })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(OPTIMIZATION_METRICS)
                  .filter(([key]) =>
                    points
                      ? POINT_OPTIMIZATION_METRICS.includes(
                          key as OptimizationMetric,
                        )
                      : !['total_points', 'max_drawdown_points'].includes(key),
                  )
                  .map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                      {key.startsWith('max_drawdown')
                        ? '（越小越好）'
                        : '（越大越好）'}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Label>
          {(
            [
              ['n_trials', '试验次数', 1, 200],
              ['timeout_seconds', '搜索时间上限（秒）', 1, 3600],
              ['min_trades', '最少交易笔数', 1, undefined],
              ['seed', '随机种子', 0, 4294967295],
            ] as const
          ).map(([key, label, min, max]) => (
            <Label key={key} className="grid gap-2 text-xs">
              {label}
              <Input
                required
                type="number"
                step="1"
                min={min}
                max={max}
                value={Number.isFinite(value[key]) ? value[key] : ''}
                onChange={(e) =>
                  onChange({ ...value, [key]: e.target.valueAsNumber })
                }
              />
            </Label>
          ))}
          <Label className="grid gap-2 text-xs">
            验证开始时间（可留空）
            <Input
              type="datetime-local"
              value={validationStart}
              onChange={(e) => onValidationChange(e.target.value)}
            />
          </Label>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {validationStart
            ? '开始时间之前用于选参，之后只验证一次。验证账户重新初始化，使用此前行情预热，建议按完整交易日划分。'
            : '未设置验证区间，本次结果全部为样本内结果。建议留出后段数据检验最佳参数。'}
          搜索最多 200 次，每次最多 5 分钟；验证另有 5 分钟上限。
        </p>
        <Label className="grid gap-2 text-xs">
          参数搜索范围（JSON）
          <Textarea
            required
            className="min-h-40 font-mono text-xs"
            spellCheck={false}
            value={space}
            onChange={(e) => onSpaceChange(e.target.value)}
            placeholder={
              '{\n  "fast": {"type": "int", "low": 2, "high": 10},\n  "slow": {"type": "int", "low": 15, "high": 60}\n}'
            }
          />
        </Label>
        <p className="text-xs leading-5 text-muted-foreground">
          只能填写所选版本已有的默认参数名。int / float 填 low、high，可选 step
          或 log；categorical 填 choices 数组。
          未搜索的参数沿用原版本默认值。symbol、duration、execution_model
          固定，不参与搜索。
        </p>
      </>
    </section>
  );
}
