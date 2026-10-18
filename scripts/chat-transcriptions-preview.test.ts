import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptionExcerpt } from '@aime/shared/audio';
import {
  parseTranscriptionsOutput,
  transcriptionTimestamp,
} from '../apps/web/src/components/chat/message-preview/transcriptions-output.js';

test('native and persisted JSON retain text and real metadata; legacy timestamps remain readable', () => {
  const output = {
    text: '你好\n世界',
    language: 'zh',
    duration: 2.5,
    segments: [
      { start: 0, end: 1.25, text: '你好' },
      { startSecond: 1.25, endSecond: 2.5, text: '世界' },
      { start: -1, end: 2, text: 'invalid' },
    ],
  };
  for (const value of [output, JSON.stringify(output)]) {
    const parsed = parseTranscriptionsOutput(value, 'verbose_json');
    assert.equal(parsed?.text, output.text);
    assert.equal(parsed?.duration, 2.5);
    assert.equal(parsed?.language, 'zh');
    assert.deepEqual(parsed?.cues, [
      { start: 0, end: 1.25, text: '你好' },
      { start: 1.25, end: 2.5, text: '世界' },
    ]);
  }
  const plain = parseTranscriptionsOutput({
    text: 'Hello',
    usage: { seconds: 42 },
  });
  assert.equal(plain?.duration, undefined);
  assert.deepEqual(plain?.cues, []);
});

test('subtitle previews parse SRT and VTT cues without inventing duration or losing multiline text', () => {
  const srt =
    '1\r\n00:00:01,500 --> 00:00:03,000\r\n第一行\r\n第二行\r\n\r\n2\r\n01:00:00,000 --> 01:00:02,250\r\n结尾';
  const result = parseTranscriptionsOutput(srt, 'srt');
  assert.deepEqual(result?.cues, [
    { start: 1.5, end: 3, text: '第一行\n第二行' },
    { start: 3600, end: 3602.25, text: '结尾' },
  ]);
  assert.equal(result?.duration, undefined);
  assert.equal(result?.text, '第一行\n第二行\n结尾');
  const vtt =
    '\uFEFFWEBVTT\n\nNOTE a comment\nnot a cue\n\nintro\n00:01.500 --> 00:03.000 align:start\n<script>alert(1)</script>';
  assert.deepEqual(parseTranscriptionsOutput(vtt, 'vtt')?.cues, [
    { start: 1.5, end: 3, text: '<script>alert(1)</script>' },
  ]);
  const broken = `${srt}\n\n3\ninvalid timestamp\nKeep this text`;
  assert.equal(parseTranscriptionsOutput(broken, 'srt')?.text, broken);
  assert.deepEqual(parseTranscriptionsOutput(broken, 'srt')?.cues, []);
});

test('plain text, empty results, failures and unknown payloads stay distinct', () => {
  const literal = '{"text":"This is a literal transcript"}';
  assert.equal(parseTranscriptionsOutput(literal, 'text')?.text, literal);
  assert.equal(parseTranscriptionsOutput('', 'text')?.text, '');
  assert.equal(parseTranscriptionsOutput({ text: '' }, 'json')?.failed, false);
  assert.equal(
    parseTranscriptionsOutput('legacy transcript')?.text,
    'legacy transcript',
  );
  assert.equal(
    parseTranscriptionsOutput({ ok: false, text: 'Provider unavailable' })
      ?.message,
    'Provider unavailable',
  );
  assert.equal(
    parseTranscriptionsOutput({
      isError: true,
      error: { message: 'Timed out' },
    })?.failed,
    true,
  );
  for (const value of [null, undefined, 123, [], { unexpected: true }])
    assert.equal(parseTranscriptionsOutput(value), null);
  assert.equal(parseTranscriptionsOutput('not json', 'json'), null);
  assert.equal(transcriptionTimestamp(3661.25), '01:01:01.250');
  assert.equal(transcriptionTimestamp(59.9999), '01:00');
});

test('transcription excerpts respect the 2000-character boundary and keep both ends without splitting surrogate pairs', () => {
  for (const text of [
    '',
    '汉'.repeat(1999),
    '汉'.repeat(2000),
    '😀'.repeat(2000),
  ]) {
    assert.deepEqual(transcriptionExcerpt(text), { text, truncated: false });
  }
  for (const text of [
    '开头' + '中'.repeat(1997) + '结尾',
    '😀'.repeat(1001) + '🦊'.repeat(1000),
  ]) {
    const result = transcriptionExcerpt(text);
    assert.equal(result.truncated, true);
    assert.equal(Array.from(result.text).length, 2000);
    const [head, tail] = result.text.split('\n… [middle omitted] …\n');
    assert.ok(text.startsWith(head));
    assert.ok(text.endsWith(tail));
    assert.ok(head.length > 0 && tail.length > 0);
    assert.ok(Math.abs(Array.from(head).length - Array.from(tail).length) <= 1);
    assert.doesNotMatch(result.text, /[\uD800-\uDFFF]/u);
  }
});

test('large plain text and subtitle previews show only the excerpt instead of parsing partial cues', () => {
  const text = '开头\n' + '中间内容'.repeat(800) + '\n结尾';
  for (const format of ['text', 'srt', 'vtt']) {
    const source =
      format === 'text'
        ? text
        : (format === 'vtt' ? 'WEBVTT\n\n' : '') +
          '1\n00:00:00.000 --> 00:00:01.000\n' +
          text;
    const result = parseTranscriptionsOutput(source, format);
    assert.equal(result?.truncated, true);
    assert.equal(result.text, transcriptionExcerpt(source).text);
    assert.deepEqual(result.cues, []);
    assert.ok(result.text.startsWith(source.slice(0, 20)));
    assert.ok(result.text.endsWith('结尾'));
  }
});

test('JSON previews cap the whole serialized response even when every individual field is short', () => {
  const original = {
    text: '短正文',
    language: 'zh',
    duration: 100,
    segments: Array.from({ length: 100 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: `第${i}句`,
    })),
    usage: { seconds: 100 },
  };
  const serialized = JSON.stringify(original);
  for (const format of ['json', 'verbose_json']) {
    for (const output of [original, serialized]) {
      const result = parseTranscriptionsOutput(output, format);
      assert.equal(result?.truncated, true);
      assert.equal(result.text, transcriptionExcerpt(original).text);
      assert.equal(Array.from(result.text).length, 2000);
      assert.equal(result.duration, 100);
      assert.equal(result.language, 'zh');
      assert.deepEqual(result.cues, []);
      assert.ok(result.text.endsWith('"usage":{"seconds":100}}'));
    }
  }
  assert.equal(JSON.stringify(original), serialized);
  const hugeText = { text: '开头' + '中'.repeat(3000) + '结尾' };
  assert.equal(
    parseTranscriptionsOutput(hugeText, 'json')?.text,
    transcriptionExcerpt(hugeText).text,
  );
});
