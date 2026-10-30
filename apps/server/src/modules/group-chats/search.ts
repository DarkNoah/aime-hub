/** Word segmentation plus CJK bigrams keeps Chinese phrase/partial matches searchable. */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function messageSearchTerms(text: string) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US');
  const terms: Record<string, number> = Object.create(null);
  for (const part of segmenter.segment(normalized)) {
    if (part.isWordLike) terms[part.segment] = (terms[part.segment] ?? 0) + 1;
  }
  const bigrams: Record<string, number> = Object.create(null);
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...match[0]];
    for (let index = 0; index + 1 < chars.length; index++) {
      const term = chars[index] + chars[index + 1];
      bigrams[term] = (bigrams[term] ?? 0) + 1;
    }
  }
  // Keep occurrence frequency without double-counting a two-character word
  // emitted by both the word segmenter and bigram tokenizer.
  for (const [term, count] of Object.entries(bigrams)) {
    terms[term] = Math.max(terms[term] ?? 0, count);
  }
  return {
    terms,
    count: Object.values(terms).reduce((sum, value) => sum + value, 0),
  };
}
