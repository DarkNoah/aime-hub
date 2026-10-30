"""Public SDK scaffold. Add your own strategy in the editor or a private file."""
from quant_sdk import Strategy


class CustomStrategy(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], ctx.params.get('duration', 60))

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        # Add your own signal and risk rules here. The blank template places no orders.
        # ctx.position(bar.symbol) returns an int: positive=long, negative=short, zero=flat.
        pass

    def on_stop(self, ctx, reason):
        # Optional cleanup. The runtime passes ctx and reason; keep both parameters.
        # reason is a string: 'succeeded', a cancellation message, or an error message.
        # Use ctx.log("research_diagnostics", reason=reason) for diagnostics, not ctx.emit.
        # No active event remains here: do not place orders or publish risk levels.
        pass
