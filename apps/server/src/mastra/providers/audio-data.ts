export const maxReferenceAudioBytes = 20_000_000;

export function audioMimeType(data: Buffer) {
  if (!data.length || data.length > maxReferenceAudioBytes)
    throw new Error('Invalid reference audio size');
  if (
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WAVE'
  )
    return 'audio/wav' as const;
  if (
    data.toString('ascii', 0, 3) === 'ID3' ||
    (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  )
    return 'audio/mpeg' as const;
  if (data.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac' as const;
  if (data.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg' as const;
  throw new Error('Unsupported reference audio');
}

/** Read WAV metadata; callers enforce size policy separately from format validation. */
export function wavMetadata(data: Buffer) {
  if (
    data.length < 44 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Invalid WAV response');
  const end = data.readUInt32LE(4) + 8;
  if (end > data.length || end < 44) throw new Error('Truncated WAV response');
  let sampleRate = 0;
  let byteRate = 0;
  let audioBytes = 0;
  for (let offset = 12; offset + 8 <= end;) {
    const chunk = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > end) throw new Error('Truncated WAV chunk');
    if (chunk === 'fmt ' && size >= 16) {
      sampleRate = data.readUInt32LE(start + 4);
      byteRate = data.readUInt32LE(start + 8);
    }
    if (chunk === 'data') audioBytes += size;
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !byteRate || !audioBytes)
    throw new Error('Empty WAV audio');
  return { sampleRate, duration: audioBytes / byteRate };
}
