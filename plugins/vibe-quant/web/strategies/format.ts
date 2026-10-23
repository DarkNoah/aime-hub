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
const errors: Record<string, string> = {
  STRATEGY_CONFLICT:
    '草稿已在其他窗口更新。当前内容仍保留，请先复制，再重新载入。',
  UNSUPPORTED_INSTRUMENT: '行情目录中未找到该标的，或当前 SDK 尚不支持该类别',
  STRATEGY_NOT_FOUND: '策略不存在或无权访问',
  VERSION_NOT_FOUND: '版本不存在或无权访问',
  STRATEGY_DISABLED: '策略已停用，请先启用再运行回测',
  RUN_QUEUE_FULL: '已有 3 个回测等待或执行，请完成或取消后重试',
  INVALID_BACKTEST_CONFIG:
    '请检查时间区间、资金、交易规则和参数；单次区间最多十年，结束时间不能在未来；主连价格模拟需选择主连标的',
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
