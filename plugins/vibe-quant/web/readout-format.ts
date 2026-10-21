export function pricePrecision(priceTick: number) {
  const tick = Number.isFinite(priceTick) && priceTick > 0 ? priceTick : 0.01;
  const [base, exponent = '0'] = String(tick).split('e');
  return Math.min(
    8,
    Math.max(0, (base.split('.')[1]?.length ?? 0) - Number(exponent)),
  );
}

export function readoutTime(time?: number) {
  if (time === undefined || !Number.isFinite(time)) return '—';
  return new Date((time + 8 * 3600) * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

const quantity = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 2,
});
export function readoutQuantity(value?: number | null, currency = false) {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  return quantity.format(value) + (currency ? '元' : '');
}
