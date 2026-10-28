export const factorError = (error: unknown) => {
  const message =
    error instanceof Error ? error.message : '操作失败，请稍后重试';
  return (
    (
      {
        ADMIN_REQUIRED: '仅管理员可以修改和执行 Python 因子',
        FACTOR_SERVICE_UNAVAILABLE: '因子服务暂不可用，请稍后重试',
        PLUGIN_DISABLED: '插件已停用',
      } as Record<string, string>
    )[message] ?? message
  );
};
export const number = (value: number | null | undefined, percent = false) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : percent
      ? `${(value * 100).toFixed(2)}%`
      : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
export const dateTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false });
