"""收盘价相对均线的距离；正值表示价格位于均线上方。"""
from quant_sdk import Factor


class MovingAverageDistance(Factor):
    def lookback(self, params):
        return int(params.get('window', 20))

    def compute(self, bars, params):
        average = sum(bar.close for bar in bars) / len(bars)
        return bars[-1].close / average - 1 if average else None
