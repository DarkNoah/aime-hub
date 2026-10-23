"""One strategy for stocks, IM main and commodity main contracts."""
from quant_sdk import RiskLevels, Strategy


class MovingAverage(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], ctx.params.get('duration', 60))

    def on_roll(self, ctx, event, previous_contract):
        if previous_contract:
            # The old position remains an old-contract position until it actually fills.
            ctx.orders.target_position(previous_contract, 0, reason='main_contract_roll')

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        fast, slow = ctx.params.get('fast', 2), ctx.params.get('slow', 4)
        if not 0 < fast < slow:
            raise ValueError('Expected 0 < fast < slow')
        bars = ctx.data.history(bar.symbol, bar.duration, slow)
        if len(bars) < slow:
            return
        a = sum(b.close for b in bars[-fast:]) / fast
        b = sum(b.close for b in bars) / slow
        contract = ctx.data.resolve_contract(bar.symbol)
        instrument = ctx.data.instrument(contract)
        quantity = ctx.params.get('quantity', instrument.lot_size)
        side = 1 if a > b else -1 if a < b else 0
        if instrument.kind == 'stock':
            side = max(0, side)
        previous = ctx.state.get('target')
        target = [contract, side * quantity]
        if previous != target:
            entry_id = ctx.orders.target_position(*target, reason='moving_average_cross')
            ctx.state['target'] = target
            ctx.state['risk'] = None
            if side:
                actual = ctx.data.history(contract, 60, 1)
                if actual:
                    ctx.state['risk'] = {'entry_id': entry_id, 'reference': actual[-1].close,
                                         'best': actual[-1].close, 'side': side}
        risk = ctx.state.get('risk')
        actual = ctx.data.history(contract, 60, 1)
        if risk and actual:
            # Protective exits execute automatically; the next MA change can open a new entry.
            risk['best'] = (max if risk['side'] > 0 else min)(risk['best'], actual[-1].close)
            anchor = risk['best'] if ctx.params.get('trailing_stop', False) else risk['reference']
            stop = ctx.params.get('stop_loss_pct', 0.01)
            profit = ctx.params.get('take_profit_pct', 0.02)
            if stop < 0 or profit < 0:
                raise ValueError('Risk percentages must be nonnegative')
            return RiskLevels(contract, entry_id=risk['entry_id'],
                              stop_loss=anchor * (1 - risk['side'] * stop) if stop else None,
                              take_profit=risk['reference'] * (1 + risk['side'] * profit) if profit else None)

