"""python examples/offline.py --output /tmp/quant-runs (no credentials/network)."""
import argparse
from datetime import datetime
from zoneinfo import ZoneInfo

from quant_sdk import Bar, Dataset, Event, Fees, Instrument, LiveRunner, Roll, RunConfig, backtest
from strategy import MovingAverage


def sample(signal, actual):
    start = datetime(2026, 10, 19, 9, 30, tzinfo=ZoneInfo('Asia/Shanghai')).timestamp()
    events = []
    if signal.kind == 'continuous':
        events.append(Event('initial-mapping', start, Roll(signal.symbol, actual.symbol, start, '2026-10-19')))
    prices = [100, 101, 102, 103, 102, 100, 98, 99, 101, 102]
    for n, price in enumerate(prices):
        for item in dict.fromkeys([actual, signal]):
            bar = Bar(item.symbol, start + n * 60, start + (n + 1) * 60, '2026-10-19',
                      60, price, price + 1, price - 1, price, 10000)
            events.append(Event(f'{item.symbol}:{n}', bar.end_time, bar))
    return Dataset(dict.fromkeys([signal, actual]), events, metadata={'fixture': True, 'prices': 'synthetic'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='.quant-runs')
    args = parser.parse_args()
    stock = Instrument('SSE.600000', 'stock', .01, lot_size=100, t_plus_one=True, fees=Fees(minimum=5))
    cases = [
        (Instrument('KQ.m@CFFEX.IM', 'continuous', .2),
         Instrument('CFFEX.IM2611', 'future', .2, multiplier=200, margin_rate=.15, fees=Fees(per_unit=2))),
        (Instrument('KQ.m@SHFE.rb', 'continuous', 1),
         Instrument('SHFE.rb2701', 'future', 1, multiplier=10, margin_rate=.15, fees=Fees(per_unit=2))),
        (stock, stock),
    ]
    for signal, actual in cases:
        dataset = sample(signal, actual)
        params = {'symbol': signal.symbol}
        config = RunConfig(initial_cash=1_000_000, slippage_ticks=1, benchmark_symbol=signal.symbol)
        historical = backtest.run(MovingAverage(), dataset, params=params, config=config, output_dir=args.output)
        streamed = LiveRunner(MovingAverage(), dataset.instruments, params=params, config=config,
                              mode='paper', output_dir=args.output).run(dataset.events)
        assert historical['status'] == streamed['status'] == 'succeeded', (historical['message'], streamed['message'])
        for field in ('signals', 'risk_levels', 'fills', 'trades', 'metrics', 'equity_curve'):
            assert historical[field] == streamed[field], field
        print(signal.symbol, '一致性验证通过', historical['metrics'])
        print('回测记录:', historical['artifacts'])


if __name__ == '__main__':
    main()
