export function exitReasonLabel(reason?: string) {
  if (!reason) return '未记录';
  return (
    (
      {
        stop_loss: '止损',
        take_profit: '止盈',
        moving_average_cross: '均线信号',
        main_contract_roll: '主力换月',
        strategy_signal: '策略信号',
      } as Record<string, string>
    )[reason] ?? reason
  );
}

export function exitMarkerLabel(reason?: string) {
  return reason ? `${exitReasonLabel(reason)}离场` : '离场';
}
