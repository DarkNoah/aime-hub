import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeTranscriptionSubtitles as optimize } from '../audio/subtitles.js';

type Cue = { start: number; end: number; text: string };
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function time(ms: number, vtt = false) {
  return `00:${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1_000) % 60).padStart(2, '0')}${vtt ? '.' : ','}${String(ms % 1_000).padStart(3, '0')}`;
}
function document(cues: Cue[], vtt = false) {
  return (
    (vtt ? 'WEBVTT\n\n' : '') +
    cues
      .map(
        (cue, index) =>
          `${vtt ? '' : `${index + 1}\n`}${time(cue.start, vtt)} --> ${time(cue.end, vtt)}\n${cue.text}`,
      )
      .join('\n\n') +
    '\n\n'
  );
}
function cues(output: string) {
  return [
    ...output.matchAll(
      /(\d+):(\d{2}):(\d{2})[.,](\d{3}) --> (\d+):(\d{2}):(\d{2})[.,](\d{3})[^\n]*\n([^]*?)(?=\n\n|$)/g,
    ),
  ].map((match) => ({
    start: ((+match[1] * 60 + +match[2]) * 60 + +match[3]) * 1_000 + +match[4],
    end: ((+match[5] * 60 + +match[6]) * 60 + +match[7]) * 1_000 + +match[8],
    text: match[9],
  }));
}
function assertSingleLine(output: string) {
  const parsed = cues(output);
  for (const cue of parsed) {
    assert.ok(cue.end > cue.start);
    assert.doesNotMatch(cue.text, /[\r\n\u2028\u2029]/);
    assert.doesNotMatch(
      cue.text,
      /[,，、;；](?:[”’"'」』）)\]】》]|<\/[^>]+>)*$/u,
    );
  }
  return parsed;
}

test('merges short Chinese and English continuations before clearing trailing commas', () => {
  for (const vtt of [false, true]) {
    const source = document(
      [
        { start: 0, end: 600, text: '我想要一杯珍珠奶茶，' },
        { start: 800, end: 2_400, text: '正常微冰，' },
        { start: 4_000, end: 4_600, text: 'Hello,' },
        { start: 4_700, end: 6_000, text: 'world,' },
      ],
      vtt,
    );
    const result = optimize(source, vtt ? 'vtt' : 'srt');
    assert.deepEqual(assertSingleLine(result), [
      { start: 0, end: 2_400, text: '我想要一杯珍珠奶茶，正常微冰' },
      { start: 4_000, end: 6_000, text: 'Hello, world' },
    ]);
  }
});

test('flattens Chinese and English wraps and removes trailing commas inside quotes and tags', () => {
  const lines = [
    '你好\n世界，',
    'Hello\nworld,',
    '“你好，，；”',
    '<i>你好，</i>',
    '你好，<br>世界，',
    '真的？',
    '太棒了！',
    '等等……',
    'Done.',
  ];
  const source = document(
    lines.map((text, i) => ({
      start: i * 3_000,
      end: i * 3_000 + 1_000,
      text,
    })),
  );
  assert.deepEqual(
    assertSingleLine(optimize(source, 'srt')).map((cue) => cue.text),
    [
      '你好世界',
      'Hello world',
      '“你好”',
      '<i>你好</i>',
      '你好，世界',
      '真的？',
      '太棒了！',
      '等等……',
      'Done.',
    ],
  );
});

test('does not merge across pauses, overlaps, strong endings or speaker markers', () => {
  for (const [text, gap] of [
    ['你好，', 401],
    ['你好，', -100],
    ['你好。', 0],
    ['你好？', 0],
    ['等等…', 0],
    ['-你好，', 0],
    ['张三：你好，', 0],
    ['[旁白]你好，', 0],
    ['<v Alice>你好，</v>', 0],
  ] as const) {
    const source = document([
      { start: 0, end: 800, text },
      { start: 800 + gap, end: 2_000, text: '接着说，' },
    ]);
    assert.equal(assertSingleLine(optimize(source, 'srt')).length, 2, text);
  }
});

test('splits long Chinese subtitles at phrase boundaries into single-line cues within original timing', () => {
  const text = '我想要一杯珍珠奶茶，正常微冰，不要加糖，谢谢你！';
  const source = document([{ start: 2_000, end: 14_000, text }]);
  const output = optimize(source, 'srt');
  const result = assertSingleLine(output);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, '我想要一杯珍珠奶茶');
  assert.equal(result[0].start, 2_000);
  assert.equal(result.at(-1)!.end, 14_000);
  assert.equal(
    result
      .map((cue) => cue.text)
      .join('')
      .replaceAll('，', ''),
    text.replaceAll('，', ''),
  );
  result.forEach((cue, i) => {
    assert.ok([...graphemes.segment(cue.text)].length <= 16);
    assert.ok(cue.end - cue.start >= 834 && cue.end - cue.start <= 7_000);
    if (i) assert.equal(result[i - 1].end, cue.start);
  });
  assert.equal(optimize(output, 'srt'), output);
});

test('splits long English at word boundaries and retains all words', () => {
  const text =
    'Hello, this is a long subtitle that should be split into readable single lines without breaking ordinary words,';
  const output = optimize(document([{ start: 0, end: 9_000, text }]), 'srt');
  const result = assertSingleLine(output);
  assert.ok(result.length >= 3);
  assert.equal(
    result
      .map((cue) => cue.text)
      .join(' ')
      .replaceAll(',', ''),
    text.replaceAll(',', ''),
  );
  result.forEach((cue) =>
    assert.ok([...graphemes.segment(cue.text)].length <= 42),
  );
  assert.equal(optimize(output, 'srt'), output);
});

test('duration-only splitting respects words and cannot manufacture time for dense speech', () => {
  const result = assertSingleLine(
    optimize(
      document([
        { start: 1_000, end: 22_000, text: 'one two three four five six' },
      ]),
      'srt',
    ),
  );
  assert.ok(result.length >= 3);
  assert.equal(result[0].start, 1_000);
  assert.equal(result.at(-1)!.end, 22_000);
  result.forEach((cue) => assert.ok(cue.end - cue.start <= 7_000));
  const heldWord = document([{ start: 0, end: 20_000, text: 'Hello!' }]);
  assert.equal(optimize(heldWord, 'srt'), heldWord);
  const dense = assertSingleLine(
    optimize(
      document([{ start: 5_000, end: 5_200, text: '很长的字幕'.repeat(16) }]),
      'srt',
    ),
  );
  assert.equal(dense[0].start, 5_000);
  assert.equal(dense.at(-1)!.end, 5_200);
  assert.ok(dense.every((cue) => cue.end - cue.start > 0));
});

test('hard splits keep trailing punctuation with words and nested commas are removed in one pass', () => {
  const word = 'a'.repeat(42) + '?';
  const output = optimize(
    document([{ start: 0, end: 4_000, text: word }]),
    'srt',
  );
  const result = assertSingleLine(output);
  assert.equal(result.length, 2);
  assert.equal(result.map((cue) => cue.text).join(''), word);
  assert.ok(
    result.every((cue) => cue.text.length > 1 && cue.text.length <= 42),
  );
  const quoted = optimize(
    document([{ start: 0, end: 1_000, text: '“你好，”；' }]),
    'srt',
  );
  assert.equal(assertSingleLine(quoted)[0].text, '“你好”');
  assert.equal(optimize(quoted, 'srt'), quoted);
});

test('preserves VTT metadata, identifiers, settings and balanced formatting when splitting', () => {
  const source =
    'WEBVTT example\nLanguage: zh\n\nSTYLE\n::cue(.red) { color: red; }\n\nREGION\nid:bottom\n\nNOTE keep this metadata\nunchanged\n\nintro\n00:00.000 --> 00:10.000 line:90% align:start\n<v Alice><c.red>这是一个很长的字幕，需要按照词语边界拆分成单行，不能丢失格式标签，</c></v>\n\nnext\n00:10.000 --> 00:11.000 line:10%\n第二句，\n\n';
  const output = optimize(source, 'vtt');
  assert.match(output, /^WEBVTT example\nLanguage: zh/);
  assert.ok(output.includes('STYLE\n::cue(.red) { color: red; }'));
  assert.ok(output.includes('REGION\nid:bottom'));
  assert.ok(output.includes('NOTE keep this metadata\nunchanged'));
  const result = assertSingleLine(output);
  assert.ok(result.length >= 3);
  for (const cue of result.slice(0, -1))
    assert.match(cue.text, /^<v Alice><c.red>[^<]+<\/c><\/v>$/);
  assert.match(output, /intro\n.* line:90% align:start/);
  assert.match(output, /next\n.* line:10%\n第二句/);
});

test('retains entities, Unicode graphemes, styles, BOM and CRLF', () => {
  const content = '<i>' + '👨‍👩‍👧‍👦 👩🏽‍💻 cafe\u0301 &amp; '.repeat(8) + 'end,</i>';
  const output = optimize(
    '\uFEFF' +
      document([{ start: 0, end: 12_000, text: content }]).replaceAll(
        '\n',
        '\r\n',
      ),
    'srt',
  );
  assert.ok(output.startsWith('\uFEFF'));
  assert.doesNotMatch(output, /(?<!\r)\n/);
  const result = assertSingleLine(output.replaceAll('\r\n', '\n'));
  const texts = result.map((cue) => cue.text).join('');
  assert.equal(texts.match(/👨‍👩‍👧‍👦/g)?.length, 8);
  assert.equal(texts.match(/👩🏽‍💻/g)?.length, 8);
  assert.equal(texts.match(/cafe\u0301/g)?.length, 8);
  assert.equal(texts.match(/&amp;/g)?.length, 8);
  for (const cue of result) assert.match(cue.text, /^<i>.*<\/i>$/);
});

test('preserves karaoke alignment, rejects partial parsing and drops empty punctuation-only cues', () => {
  const karaoke =
    'WEBVTT\n\n00:00.000 --> 00:04.000\n你好<00:02.000>世界，\n\n';
  assert.match(optimize(karaoke, 'vtt'), /你好<00:02.000>世界\n/);
  for (const source of [
    'not a subtitle,',
    '1\n00:61:00,000 --> 00:62:00,000\n你好，\n',
    '1\n00:00:01,000 --> 00:00:00,000\n你好，\n',
    document([{ start: 0, end: 1_000, text: '你好，' }]) + 'broken block',
  ])
    assert.equal(optimize(source, 'srt'), source);
  const empty = optimize(
    document([{ start: 0, end: 1_000, text: '，,；' }]),
    'srt',
  );
  assert.equal(cues(empty).length, 0);
});
