"""Public SDK scaffold. Add your own strategy in the editor or a private file."""
from quant_sdk import Strategy


class CustomStrategy(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], ctx.params.get('duration', 60))

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        # Add your own signal and risk rules here. The blank template places no orders.
        pass
