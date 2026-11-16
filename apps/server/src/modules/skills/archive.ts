import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import {
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_ARCHIVE_MAX_ENTRIES,
  SKILL_ARCHIVE_MAX_UNPACKED_BYTES,
} from '@aime/shared/skills';
import { SkillError } from './errors.js';
import type { RepositoryFile, RepositorySnapshot } from './github.js';

type Entry = {
  path: string;
  directory: boolean;
  ignored: boolean;
  executable: boolean;
  size: number;
  crc: number;
  method: number;
  start: number;
  end: number;
};

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const invalid = () => new SkillError('SKILL_ARCHIVE_INVALID');
const unsafe = () => new SkillError('SKILL_ARCHIVE_UNSAFE');
const tooLarge = () => new SkillError('SKILL_ARCHIVE_TOO_LARGE', 413);
// ZIP's legacy filename encoding when the UTF-8 language flag is absent.
const cp437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new SkillError('ABORTED');
}

/** Validate all metadata before decompressing or writing any archive entries. */
function entries(data: Buffer): Entry[] {
  let end = data.length - 22;
  const limit = Math.max(0, end - 65_535);
  for (; end >= limit; end--)
    if (
      data.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + data.readUInt16LE(end + 20) === data.length
    )
      break;
  if (end < limit) throw invalid();
  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  const start = data.readUInt32LE(end + 16);
  // Multi-volume and ZIP64 containers are not accepted by this bounded importer.
  if (
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    data.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    size === 0xffffffff ||
    start === 0xffffffff ||
    start + size !== end
  )
    throw invalid();
  if (count > SKILL_ARCHIVE_MAX_ENTRIES) throw tooLarge();
  let cursor = start;
  let unpacked = 0;
  const result: Entry[] = [];
  const explicit = new Set<string>();
  const nodes = new Map<string, { name: string; directory: boolean }>();
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50)
      throw invalid();
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressed = data.readUInt32LE(cursor + 20);
    const length = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const attributes = data.readUInt32LE(cursor + 38);
    const offset = data.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      data.readUInt16LE(cursor + 34) ||
      compressed === 0xffffffff ||
      length === 0xffffffff ||
      offset === 0xffffffff
    )
      throw invalid();
    const rawName = data.subarray(cursor + 46, cursor + 46 + nameLength);
    const name =
      flags & 0x0800
        ? new TextDecoder('utf-8', { fatal: true }).decode(rawName)
        : Array.from(rawName, (value) =>
            value < 128 ? String.fromCharCode(value) : cp437[value - 128],
          ).join('');
    const directory = name.endsWith('/');
    const path = directory ? name.slice(0, -1) : name;
    const parts = path.split('/');
    if (
      !path ||
      /[\\:]/.test(path) ||
      Array.from(path).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      parts.some((part) => !part || part === '.' || part === '..')
    )
      throw unsafe();
    const mode = attributes >>> 16;
    const kind = mode & 0xf000;
    if (
      ![0, 0x4000, 0x8000].includes(kind) ||
      (kind === 0x4000 && !directory) ||
      (kind === 0x8000 && directory) ||
      ((attributes & 0x10) !== 0 && !directory)
    )
      throw unsafe();
    const key = path.normalize('NFC').toLowerCase();
    if (explicit.has(key)) throw unsafe();
    explicit.add(key);
    for (let depth = 1; depth <= parts.length; depth++) {
      const name = parts.slice(0, depth).join('/');
      const key = name.normalize('NFC').toLowerCase();
      const isDirectory = depth < parts.length || directory;
      const previous = nodes.get(key);
      if (
        previous &&
        (previous.name !== name || previous.directory !== isDirectory)
      )
        throw unsafe();
      nodes.set(key, { name, directory: isDirectory });
    }
    unpacked += length;
    if (unpacked > SKILL_ARCHIVE_MAX_UNPACKED_BYTES) throw tooLarge();
    if (directory && length !== 0) throw invalid();
    if (offset + 30 > start || data.readUInt32LE(offset) !== 0x04034b50)
      throw invalid();
    const localNameLength = data.readUInt16LE(offset + 26);
    const localExtraLength = data.readUInt16LE(offset + 28);
    const contentStart = offset + 30 + localNameLength + localExtraLength;
    const contentEnd = contentStart + compressed;
    if (
      contentEnd > start ||
      data.readUInt16LE(offset + 6) !== flags ||
      data.readUInt16LE(offset + 8) !== method ||
      !data.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName)
    )
      throw invalid();
    let rangeEnd = contentEnd;
    if (flags & 8) {
      let descriptor = contentEnd;
      if (
        descriptor + 4 <= start &&
        data.readUInt32LE(descriptor) === 0x08074b50
      )
        descriptor += 4;
      if (
        descriptor + 12 > start ||
        data.readUInt32LE(descriptor) !== crc ||
        data.readUInt32LE(descriptor + 4) !== compressed ||
        data.readUInt32LE(descriptor + 8) !== length
      )
        throw invalid();
      rangeEnd = descriptor + 12;
    } else if (
      data.readUInt32LE(offset + 14) !== crc ||
      data.readUInt32LE(offset + 18) !== compressed ||
      data.readUInt32LE(offset + 22) !== length
    )
      throw invalid();
    ranges.push({ start: offset, end: rangeEnd });
    result.push({
      path,
      directory,
      ignored: parts.some(
        (part) =>
          ['.git', '__macosx', '.ds_store'].includes(part.toLowerCase()) ||
          part.startsWith('._'),
      ),
      executable: (mode & 0o111) !== 0,
      size: length,
      crc,
      method,
      start: contentStart,
      end: contentEnd,
    });
    cursor = next;
  }
  if (cursor !== end) throw invalid();
  ranges.sort((left, right) => left.start - right.start);
  if (
    ranges.some(
      (range, index) => index > 0 && range.start < ranges[index - 1].end,
    )
  )
    throw invalid();
  return result;
}

export async function readSkillArchive(
  filename: string,
  data: Buffer,
  signal?: AbortSignal,
): Promise<RepositorySnapshot> {
  checkAbort(signal);
  if (!/\.(zip|skill)$/i.test(filename) || !data.length) throw invalid();
  if (data.length > SKILL_ARCHIVE_MAX_BYTES) throw tooLarge();
  let directory: string | undefined;
  try {
    const archive = entries(data);
    const regular = archive.filter(
      (entry) => !entry.directory && !entry.ignored,
    );
    if (!regular.some((entry) => /(^|\/)SKILL\.md$/.test(entry.path)))
      throw invalid();
    directory = await mkdtemp(join(tmpdir(), 'skill-archive-'));
    const files: RepositoryFile[] = [];
    for (const entry of archive) {
      checkAbort(signal);
      const output = join(directory, entry.path);
      // Validate ignored entries as well, but never write them to the snapshot.
      const materialize = !entry.directory && !entry.ignored;
      if (materialize) await mkdir(dirname(output), { recursive: true });
      let size = 0;
      let crc = 0xffffffff;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > entry.size) return callback(invalid());
          for (const value of chunk)
            crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
          callback(null, materialize ? chunk : undefined);
        },
        flush(callback) {
          callback(
            size === entry.size && (crc ^ 0xffffffff) >>> 0 === entry.crc
              ? undefined
              : invalid(),
          );
        },
      });
      const compressed = data.subarray(entry.start, entry.end);
      const inflater = entry.method === 8 ? createInflateRaw() : undefined;
      const sink = materialize
        ? createWriteStream(output, {
            flags: 'wx',
            mode: entry.executable ? 0o755 : 0o644,
          })
        : new Transform({
            transform(_chunk, _encoding, callback) {
              callback();
            },
          });
      await pipeline(
        [
          Readable.from([compressed]),
          ...(inflater ? [inflater] : []),
          verify,
          sink,
        ],
        { signal },
      );
      if (inflater && inflater.bytesWritten !== compressed.length)
        throw invalid();
      if (materialize)
        files.push({
          path: entry.path,
          oid: entry.path,
          size: entry.size,
          mode: entry.executable ? '100755' : '100644',
        });
    }
    checkAbort(signal);
    const root = directory;
    const resources = new Map(
      files.map((file) => [file.oid, join(root, file.path)]),
    );
    const resource = (file: RepositoryFile) => {
      const path = resources.get(file.oid);
      if (!path) throw unsafe();
      return path;
    };
    return {
      commit: createHash('sha256').update(data).digest('hex'),
      files,
      directories: archive
        .filter((entry) => entry.directory && !entry.ignored)
        .map((entry) => entry.path),
      read: (file) => readFile(resource(file)),
      async write(file, output) {
        await copyFile(resource(file), output, constants.COPYFILE_EXCL);
        await chmod(output, file.mode === '100755' ? 0o755 : 0o644);
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    checkAbort(signal);
    if (error instanceof SkillError) throw error;
    throw invalid();
  }
}
