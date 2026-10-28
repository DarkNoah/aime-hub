/** Public scaffold. Reading a factor does not imply a trading rule or submit orders. */
export function factorStrategySource(versionId: string) {
  return `from quant_sdk import Strategy, load_factor


class FactorStrategy(Strategy):
    def on_start(self, ctx):
        self.factor = load_factor("${versionId}")
        ctx.data.subscribe(ctx.params['symbol'], ctx.params.get('duration', 86400))

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        value = self.factor.value(ctx, bar.symbol, bar.duration)
        if value is None:
            return
        ctx.log("因子值", value=value)
        # 在这里加入交易规则、仓位与风控。
`;
}
