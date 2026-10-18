type SubtitleFormat = 'srt' | 'vtt';
type Cue = {
  start: number;
  end: number;
  text: string;
  id: string;
  settings: string;
};
type Block = { raw: string; cue?: Cue };
type Tag = { name: string; raw: string };
type Glyph = { value: string; raw: string; tags: Tag[] };

// Line lengths follow the Chinese/Latin Netflix guides. Single-line cues are
// intentional here. Timing limits are targets, never permission to extend audio.
const maxDuration = 7_000;
const minDuration = 834;
const maxMergeGap = 400;
const cjk =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const softEnding = /[,，、;；]+[”’"'」』）)\]】》]*$/u;
const strongEnding = /[.!?。！？…⋯—–][”’"'」』）)\]】》]*$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

function timestamp(value: string) {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!match) return null;
  const ms =
    ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) *
      1_000 +
    Number(match[4]);
  return Number.isSafeInteger(ms) ? ms : null;
}

function parse(source: string, format: SubtitleFormat): Block[] | null {
  const blocks = source
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n(?:[\t ]*\r?\n)+/);
  const result: Block[] = [];
  if (format === 'vtt') {
    if (!/^WEBVTT(?:[ \t\n\r]|$)/.test(blocks[0])) return null;
    result.push({ raw: blocks.shift()! });
  }
  for (const raw of blocks) {
    if (
      format === 'vtt' &&
      /^(?:NOTE(?:[ \t\n]|$)|STYLE(?:\r?\n|$)|REGION(?:\r?\n|$))/.test(raw)
    ) {
      result.push({ raw });
      continue;
    }
    const lines = raw.split(/\r?\n/);
    const index = lines[0]?.includes('-->') ? 0 : 1;
    const match = /^(\S+)[ \t]+-->[ \t]+(\S+)([^\r\n]*)$/.exec(
      lines[index] ?? '',
    );
    if (!match || (format === 'srt' && index === 1 && !/^\d+$/.test(lines[0])))
      return null;
    const start = timestamp(match[1]);
    const end = timestamp(match[2]);
    if (
      start === null ||
      end === null ||
      end <= start ||
      lines.length <= index + 1
    )
      return null;
    result.push({
      raw,
      cue: {
        start,
        end,
        id: index === 1 ? lines[0] : '',
        settings: match[3],
        text: lines.slice(index + 1).join('\n'),
      },
    });
  }
  return result;
}

function joinText(left: string, right: string) {
  // Do not insert spaces into Chinese words when removing provider line wraps.
  const last = left.at(-1) ?? '';
  const first = right[0] ?? '';
  const space =
    (cjk.test(last) || /[，。！？、；：]/u.test(last)) && cjk.test(first)
      ? ''
      : ' ';
  return left + space + right;
}

function singleLine(text: string) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/[\r\n\u2028\u2029]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce(joinText, '')
    .trim();
}

function entityValue(raw: string) {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&nbsp;': ' ',
    '&quot;': '"',
    '&apos;': "'",
  };
  if (named[raw]) return named[raw];
  const match = /^&#(x[\da-f]+|\d+);$/i.exec(raw);
  if (!match) return raw;
  const code =
    match[1][0].toLowerCase() === 'x'
      ? Number.parseInt(match[1].slice(1), 16)
      : Number(match[1]);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
}

function glyphs(text: string): Glyph[] {
  const result: Glyph[] = [];
  let tags: Tag[] = [];
  for (const token of text.split(
    /(<\/?(?:b|i|u|font|c|v|lang|ruby|rt)(?:[ .][^>]*|\s*)>|&(?:#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);)/gi,
  )) {
    const tag = /^<(\/?)(b|i|u|font|c|v|lang|ruby|rt)(?:[ .][^>]*|\s*)>$/i.exec(
      token,
    );
    if (tag) {
      const name = tag[2].toLowerCase();
      if (tag[1]) {
        let index = tags.length - 1;
        while (index >= 0 && tags[index].name !== name) index--;
        if (index >= 0) tags = tags.slice(0, index);
      } else tags = [...tags, { name, raw: token }];
    } else if (
      /^&(?:#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);$/i.test(token)
    ) {
      result.push({ value: entityValue(token), raw: token, tags });
    } else {
      for (const { segment } of graphemes.segment(token))
        result.push({ value: segment, raw: segment, tags });
    }
  }
  return result;
}

function render(glyphs: Glyph[]) {
  let result = '';
  let active: Tag[] = [];
  for (const glyph of glyphs) {
    let common = 0;
    while (common < active.length && active[common] === glyph.tags[common])
      common++;
    result += active
      .slice(common)
      .reverse()
      .map((tag) => `</${tag.name}>`)
      .join('');
    result += glyph.tags
      .slice(common)
      .map((tag) => tag.raw)
      .join('');
    result += glyph.raw;
    active = glyph.tags;
  }
  return (
    result +
    [...active]
      .reverse()
      .map((tag) => `</${tag.name}>`)
      .join('')
  );
}

function clean(glyphs: Glyph[]) {
  const result = [...glyphs];
  while (result.length && /^\s+$/.test(result[0].value)) result.shift();
  while (result.length && /^\s+$/.test(result.at(-1)!.value)) result.pop();
  let index = result.length - 1;
  // Keep sentence endings and meaningful ellipses; remove dangling soft marks,
  // including commas immediately before a closing quote or formatting tag.
  while (index >= 0) {
    if (/^[”’"'」』）)\]】》]$/u.test(result[index].value)) index--;
    else if (/^[,，、;；\s]+$/u.test(result[index].value))
      result.splice(index--, 1);
    else break;
  }
  return result;
}

function lineLimit(text: string, language?: string) {
  return cjk.test(text) || /^zh(?:-|$)/i.test(language ?? '') ? 16 : 42;
}

function canMerge(
  left: Cue,
  right: Cue,
  format: SubtitleFormat,
  language?: string,
) {
  const gap = right.start - left.end;
  if (
    gap < 0 ||
    gap > maxMergeGap ||
    right.end - left.start > maxDuration ||
    left.settings !== right.settings
  )
    return false;
  // Explicit identifiers, formatting and speaker labels can carry meaning that
  // plain ASR text cannot resolve. Never merge across these boundaries.
  if (
    (format === 'vtt' && (left.id || right.id)) ||
    /<|(?:^|\n)\s*[-–—[\]]|^\s*[^:：\n]{1,20}[:：]/u.test(left.text) ||
    /<|(?:^|\n)\s*[-–—[\]]|^\s*[^:：\n]{1,20}[:：]/u.test(right.text)
  )
    return false;
  const a = singleLine(left.text);
  const b = singleLine(right.text);
  if (!clean(glyphs(a)).length || !clean(glyphs(b)).length) return false;
  if (strongEnding.test(a)) return false;
  const limit = lineLimit(a + b, language);
  const short = (cue: Cue, text: string) =>
    cue.end - cue.start < minDuration ||
    [...graphemes.segment(text)].length <= (limit === 16 ? 4 : 12);
  return (
    (softEnding.test(a) || short(left, a) || short(right, b)) &&
    clean(glyphs(joinText(a, b))).length <= limit
  );
}

function parts(text: string, duration: number, language?: string) {
  const all = clean(glyphs(singleLine(text)));
  if (!all.length) return [];
  const plain = all.map((glyph) => glyph.value).join('');
  const limit = lineLimit(plain, language);
  const wordOffsets = new Set<number>();
  for (const word of words.segment(plain))
    wordOffsets.add(word.index + word.segment.length);
  let offset = 0;
  const boundaries = all.map((glyph) => {
    offset += glyph.value.length;
    return wordOffsets.has(offset);
  });
  const output: Glyph[][] = [];
  let start = 0;
  const count = Math.max(
    Math.ceil(all.length / limit),
    Math.ceil(duration / maxDuration),
  );
  while (start < all.length) {
    const remaining = all.length - start;
    const desired = Math.max(
      Math.ceil(remaining / limit),
      count - output.length,
    );
    if (remaining <= limit && desired <= 1) {
      output.push(clean(all.slice(start)));
      break;
    }
    const target = Math.min(limit, Math.ceil(remaining / desired));
    let end = -1;
    let best = Infinity;
    for (
      let index = start + 1;
      index <= Math.min(start + limit, all.length - 1);
      index++
    ) {
      if (!boundaries[index - 1]) continue;
      const before = all[index - 1].value;
      const after = all[index].value;
      if (
        /^[,，、;；.!?。！？…⋯”’"'」』）)\]】》]$/u.test(after) ||
        /^[“‘「『（([【《]$/u.test(before)
      )
        continue;
      if (index - start < target * 0.5) continue;
      const bonus = strongEnding.test(before)
        ? 5
        : softEnding.test(before)
          ? 3
          : 0;
      const score = Math.abs(index - start - target) - bonus;
      if (score < best) {
        best = score;
        end = index;
      }
    }
    // A long word can be cut at a grapheme boundary for the hard line limit.
    // A short, long-held word stays intact instead of inventing repeated speech.
    if (end < 0) {
      end = remaining > limit ? start + target : all.length;
      // Do not strand a question mark, closing quote or ellipsis in its own cue.
      while (
        end > start + 1 &&
        end < all.length &&
        /^[,，、;；.!?。！？…⋯”’"'」』）)\]】》]$/u.test(all[end].value)
      )
        end--;
    }
    const part = clean(all.slice(start, end));
    if (part.length) output.push(part);
    start = end;
    while (start < all.length && /^\s+$/.test(all[start].value)) start++;
  }
  return output;
}

function durations(parts: Glyph[][], total: number) {
  const minimum = total >= parts.length * minDuration ? minDuration : 1;
  const maximum = total <= parts.length * maxDuration ? maxDuration : total;
  const weights = parts.map((part) => part.length);
  // Allocate by visible length, bounded by reading-time targets when feasible.
  let low = 0;
  let high = total;
  for (let i = 0; i < 48; i++) {
    const scale = (low + high) / 2;
    const sum = weights.reduce(
      (sum, weight) =>
        sum + Math.max(minimum, Math.min(maximum, weight * scale)),
      0,
    );
    if (sum < total) low = scale;
    else high = scale;
  }
  const result = weights.map((weight) =>
    Math.floor(Math.max(minimum, Math.min(maximum, weight * low))),
  );
  let rest = total - result.reduce((sum, value) => sum + value, 0);
  for (let i = 0; rest > 0; i = (i + 1) % result.length) {
    if (result[i] < maximum) {
      result[i]++;
      rest--;
    }
  }
  return result;
}

function split(cue: Cue, language?: string): Cue[] {
  const chunks = parts(cue.text, cue.end - cue.start, language);
  if (!chunks.length) return [];
  // There must be at least one millisecond for every emitted cue.
  if (chunks.length > cue.end - cue.start)
    return [{ ...cue, text: render(clean(glyphs(singleLine(cue.text)))) }];
  const lengths = durations(chunks, cue.end - cue.start);
  let start = cue.start;
  return chunks.map((chunk, index) => {
    const end = start + lengths[index];
    const result = { ...cue, start, end, text: render(chunk) };
    start = end;
    return result;
  });
}

function formatTime(ms: number, format: SubtitleFormat) {
  const hours = Math.floor(ms / 3_600_000)
    .toString()
    .padStart(2, '0');
  const minutes = Math.floor((ms / 60_000) % 60)
    .toString()
    .padStart(2, '0');
  const seconds = Math.floor((ms / 1_000) % 60)
    .toString()
    .padStart(2, '0');
  return `${hours}:${minutes}:${seconds}${format === 'srt' ? ',' : '.'}${(ms % 1_000).toString().padStart(3, '0')}`;
}

/** Only call for SRT/VTT. Native JSON and plain transcription text are untouched. */
export function optimizeTranscriptionSubtitles(
  source: string,
  format: SubtitleFormat,
  language?: string,
) {
  const blocks = parse(source, format);
  if (!blocks) return source; // Never partially rewrite a malformed document.
  const result: Block[] = [];
  let changed = false;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block.cue) {
      result.push(block);
      continue;
    }
    let cue = block.cue;
    while (
      blocks[index + 1]?.cue &&
      canMerge(cue, blocks[index + 1].cue!, format, language)
    ) {
      const next = blocks[++index].cue!;
      cue = {
        ...cue,
        end: next.end,
        text: joinText(singleLine(cue.text), singleLine(next.text)),
      };
      changed = true;
    }
    // Inline karaoke timestamps already carry alignment. Preserve those times.
    const cues = /<\d{2}:/.test(cue.text)
      ? [{ ...cue, text: render(clean(glyphs(singleLine(cue.text)))) }]
      : split(cue, language);
    if (
      cues.length !== 1 ||
      cues[0].text !== block.cue.text ||
      cues[0].start !== block.cue.start ||
      cues[0].end !== block.cue.end
    )
      changed = true;
    result.push(...cues.map((cue) => ({ raw: '', cue })));
  }
  if (!changed) return source;
  let sequence = 0;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const serialized = result
    .map((block) => {
      if (!block.cue) return block.raw;
      const cue = block.cue;
      const id = format === 'srt' ? String(++sequence) : cue.id;
      return `${id ? `${id}\n` : ''}${formatTime(cue.start, format)} --> ${formatTime(cue.end, format)}${cue.settings}\n${cue.text}`;
    })
    .join('\n\n')
    .replace(/\r?\n/g, newline);
  return `${source.startsWith('\uFEFF') ? '\uFEFF' : ''}${serialized}${newline}${newline}`;
}
