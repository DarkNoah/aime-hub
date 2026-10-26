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
        orb_negative_pnl: '持仓超时亏损',
        orb_14_45: '尾盘平仓',
      } as Record<string, string>
    )[reason] ?? reason
  );
}

export function exitMarkerLabel(reason?: string) {
  if (reason === 'orb_14_45') return '尾盘平仓';
  return reason ? `${exitReasonLabel(reason)}离场` : '离场';
}

/** Match protective exits to their existing chart price-line colors. */
export function exitReasonColor(reason?: string) {
  return reason === 'take_profit'
    ? '#dc4c5c'
    : reason === 'stop_loss'
      ? '#16a085'
      : '#d97706';
}
