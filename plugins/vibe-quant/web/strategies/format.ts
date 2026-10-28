export const number = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const percent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : `${(value * 100).toFixed(2)}%`;
export const dateTime = (value: number | string | null | undefined) =>
  value == null
    ? '—'
    : new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString(
        'zh-CN',
        { timeZone: 'Asia/Shanghai', hour12: false },
      );
export function holdingDuration(
  entryTime: number | null | undefined,
  endTime: number | null | undefined,
) {
  if (
    entryTime == null ||
    endTime == null ||
    !Number.isFinite(entryTime) ||
    !Number.isFinite(endTime) ||
    endTime < entryTime
  )
    return '—';
  const seconds = endTime - entryTime;
  if (seconds === 0) return '0m';
  if (seconds < 60) return '<1m';
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  return [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    remainingMinutes ? `${remainingMinutes}m` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
const errors: Record<string, string> = {
  TQ_ACTUAL_FUTURES_ONLY:
    '天勤回测仅支持期货实际合约，如 CFFEX.IM2611；暂不支持主连和点数模式',
  TQ_AUTH_REQUIRED: '请先在插件设置中配置天勤账号和密码',
  TQ_OPTIMIZATION_UNSUPPORTED: '天勤引擎暂不支持参数调优，请选择内置回测',
  TQ_CALENDAR_UNSUPPORTED: '天勤回测使用供应商交易日历，请移除自定义日历',
  TQ_BENCHMARK_UNSUPPORTED:
    '天勤回测的基准暂仅支持与交易标的相同的合约，或留空',
  STRATEGY_CONFLICT:
    '草稿已在其他窗口更新。当前内容仍保留，请先复制，再重新载入。',
  UNSUPPORTED_INSTRUMENT: '行情目录中未找到该标的，或当前 SDK 尚不支持该类别',
  STRATEGY_NOT_FOUND: '策略不存在或无权访问',
  VERSION_NOT_FOUND: '版本不存在或无权访问',
  STRATEGY_DISABLED: '策略已停用，请先启用再运行回测或监听信号',
  MONITOR_NOT_FOUND: '信号标的不存在或无权访问',
  MONITOR_ENGINE_CHANGED: '行情引擎已切换，请切回该策略提示所使用的引擎后计算',
  MONITOR_CONFLICT: '监控设置已更新，请稍后重试',
  MONITOR_LIMIT: '每位用户最多保留 8 条策略提示，请先移除不需要的提示',
  INVALID_MONITOR_CONFIG: '请检查信号标的、版本、周期与交易规则',
  STRATEGY_ARCHIVED: '策略已归档，请恢复后再编辑、发布或新建任务',
  STRATEGY_DELETED: '策略已移入回收站，请恢复后再编辑、发布或新建任务',
  RUN_QUEUE_FULL: '已有 3 个回测或调优任务等待或执行，请完成或取消后重试',
  RUN_NOT_FOUND: '回测记录不存在或已删除',
  RUN_ACTIVE: '回测尚未结束，请先取消并等待任务停止后再删除',
  USE_OPTIMIZATION_ENDPOINT: '请通过「调优参数」入口创建调优任务',
  OPTIMIZATION_NOT_COMPLETED: '调优尚未成功完成，暂时无法生成草稿',
  OPTIMIZATION_RESULT_MISSING: '最佳参数结果尚未保存完整，请稍后重试',
  INVALID_BACKTEST_CONFIG: '请检查回测标的、版本、资金、交易规则和参数',
  INVALID_BACKTEST_TIME_RANGE:
    '请填写有效的开始和结束时间，结束时间须晚于开始时间，跨度最多十年；日期可超出已有行情范围',
  INVALID_OPTIMIZATION_CONFIG:
    '请检查调参搜索范围；验证开始时间必须位于回测区间内，试验次数 1–200、搜索上限 1–3600 秒',
  SCRIPT_EXECUTION_ADMIN_REQUIRED: '运行服务器 Python 脚本需要管理员权限',
  VALIDATION_ERROR: '请检查名称与脚本内容（最多 60,000 字符）',
  STRATEGY_SERVICE_UNAVAILABLE: '策略服务暂不可用，请检查连接和数据库迁移',
};
export const errorText = (error: unknown) =>
  error instanceof Error
    ? (errors[error.message] ?? error.message)
    : '操作失败，请重试';
export function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('参数中的数字必须是有限值');
    return item;
  });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('参数需要是 JSON 对象');
  return parsed as Record<string, unknown>;
}
