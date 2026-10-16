import type { Engine, Instrument } from '../shared.js';

export function searchTerms(value: string) {
  const term = value
    .trim()
    .slice(0, 80)
    .replace(/[%_\\]/g, '\\$&');
  const continuous = /主连|主力连续/i.test(term);
  return {
    term: term
      .replace(/主力连续|主连/g, '')
      .replace(/xxx$|\*$/i, '')
      .trim(),
    continuous,
  };
}
export function supports(engine: Engine, instrument: Instrument) {
  return (
    !instrument.expired && (engine === 'tqsdk' || instrument.kind === 'stock')
  );
}
