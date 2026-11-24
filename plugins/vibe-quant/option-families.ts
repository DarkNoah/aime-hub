const indexOptions = {
  IM: ['MO', 'SSE.000852'],
  IF: ['IO', 'SSE.000300'],
  IH: ['HO', 'SSE.000016'],
} as const;

export function indexOptionSeries(symbol: string) {
  const contract = /^CFFEX\.(IM|IF|IH)(\d{4})$/.exec(symbol);
  const main = /^KQ\.m@CFFEX\.(IM|IF|IH)$/.exec(symbol);
  const product = contract?.[1] ?? main?.[1];
  if (!product) return undefined;
  const [option, underlying] =
    indexOptions[product as keyof typeof indexOptions];
  return { option, underlying, month: contract?.[2] };
}
