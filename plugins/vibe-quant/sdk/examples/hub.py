"""Read-only market connection; run via the instructions in ../README.md."""
import argparse
import json
import os

from quant_sdk import Fees, HubClient, Instrument, RunConfig, TradingCalendar, backtest, live
from strategy import MovingAverage


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['backtest', 'monitor', 'paper'])
    parser.add_argument('--symbols', required=True, help='One signal symbol; actual contracts are resolved historically')
    parser.add_argument('--rules', required=True, help='JSON mapping exact symbols or product prefixes to Instrument fields')
    parser.add_argument('--calendar', required=True, help='JSON {YYYY-MM-DD: true/false} from the exchange calendar')
    parser.add_argument('--start', type=float, required=True, help='History/warm-up start as UTC epoch seconds')
    parser.add_argument('--end', type=float, help='Required for backtest; optional live stop time')
    parser.add_argument('--duration', type=int, default=60)
    parser.add_argument('--cash', type=float, default=1_000_000)
    parser.add_argument('--output', default='.quant-runs')
    args = parser.parse_args()
    with open(args.rules, encoding='utf-8') as stream:
        profiles = json.load(stream)
    with open(args.calendar, encoding='utf-8') as stream:
        calendar = TradingCalendar(json.load(stream))

    def rules(symbol, metadata):
        candidates = [key for key in profiles if key == symbol or key.endswith('*') and symbol.startswith(key[:-1])]
        if not candidates:
            raise ValueError(f'Missing execution rules for {symbol}')
        values = dict(profiles[max(candidates, key=len)])
        fee = Fees(**values.pop('fees', {}))
        return Instrument(symbol, metadata['kind'], fees=fee, **values)

    # Host middleware requires both an authenticated session and an allowed frontend Origin.
    client = HubClient(os.environ['QUANT_API_URL'], headers={
        'Cookie': os.environ['QUANT_SESSION_COOKIE'], 'Origin': os.environ['QUANT_ORIGIN'],
    })
    params = {'symbol': args.symbols, 'duration': args.duration}
    config = RunConfig(initial_cash=args.cash, end=args.end, benchmark_symbol=args.symbols)
    def output(event):
        if event['type'] == 'signal':
            print(json.dumps(event, ensure_ascii=False), flush=True)

    if args.mode == 'backtest':
        if args.end is None:
            parser.error('--end is required for backtest')
        data = client.snapshot([args.symbols], start=args.start, end=args.end, duration=args.duration,
                               calendar=calendar, rules=rules)
        result = backtest.run(MovingAverage(), data, params=params, config=config, output_dir=args.output, on_event=output)
    else:
        # Subscribe before warm-up so events arriving during history loading have a cursor.
        with client.stream([args.symbols], calendar=calendar, rules=rules, duration=args.duration) as source:
            warmup = client.snapshot([args.symbols], start=args.start, end=source.cutoff,
                                    duration=args.duration, calendar=calendar, rules=rules)
            result = live.run(MovingAverage(), source, warmup=warmup, params=params, config=config,
                              mode=args.mode, output_dir=args.output, on_event=output)
    print(json.dumps({'status': result['status'], 'message': result['message'],
                      'metrics': result['metrics'], 'artifacts': result['artifacts']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
