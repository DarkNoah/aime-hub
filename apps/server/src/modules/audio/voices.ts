import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { z } from 'zod';
import {
  createVoiceSchema,
  updateVoiceSchema,
  type Voice,
} from '@aime/shared/audio';
import {
  maxReferenceAudioBytes,
  wavMetadata,
} from '../../mastra/providers/audio-data.js';
import { filePath } from '../files/paths.js';
import { ThreadError } from '../threads/errors.js';

const metadataSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  createdBy: z.string(),
});
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

export class VoiceStore {
  private locks = new Map<string, Promise<unknown>>();
  constructor(readonly root: string) {}

  private personal(userId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(userId))
      throw new ThreadError('FORBIDDEN', 403);
    return `users/${userId}/.audios`;
  }

  private scope(userId: string, input: string) {
    const path = isAbsolute(input) ? relative(this.root, input) : input;
    const parent = dirname(path);
    const base = dirname(parent);
    if (
      basename(path) !== 'voice.wav' ||
      !/^[a-zA-Z0-9_-]+$/.test(basename(parent)) ||
      (base !== '.audios' && base !== this.personal(userId))
    )
      throw new ThreadError('FORBIDDEN', 403);
    return { path, shared: base === '.audios' };
  }

  private async ensureDirectory(path: string) {
    // Check each component before mkdir so a pre-existing link cannot redirect writes.
    const canonical = await realpath(this.root);
    if (canonical !== resolve(this.root))
      throw new ThreadError('FILE_SYMLINK', 403);
    let current = canonical;
    for (const part of path.split('/')) {
      current = join(current, part);
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ThreadError('FILE_SYMLINK', 403);
    }
    return current;
  }

  private async readText(path: string, limit: number) {
    const absolute = await filePath(this.root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > limit)
      throw new ThreadError('AUDIO_INVALID');
    return readFile(absolute, 'utf8');
  }

  async get(userId: string, input: string): Promise<Voice> {
    const { path, shared } = this.scope(userId, input);
    const directory = dirname(path);
    const absolute = await filePath(this.root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > maxReferenceAudioBytes)
      throw new ThreadError('AUDIO_INVALID');
    const text = await this.readText(`${directory}/voice.txt`, 128000);
    if (!text.trim()) throw new ThreadError('AUDIO_TEXT_REQUIRED');
    const metadata = await this.readText(`${directory}/voice.json`, 32000)
      .then((value) => metadataSchema.parse(JSON.parse(value)))
      .catch((error) => {
        if (missing(error)) return undefined;
        throw error;
      });
    return {
      id: basename(directory),
      name: metadata?.name ?? basename(directory),
      description: metadata?.description ?? '',
      audioPath: path,
      textPath: `${directory}/voice.txt`,
      text,
      shared,
      canEdit: !shared || metadata?.createdBy === userId,
    };
  }

  async list(userId: string) {
    const groups = await Promise.all(
      [this.personal(userId), '.audios'].map(async (base) => {
        const directory = await filePath(this.root, base).catch((error) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (!directory) return [];
        const entries = await readdir(directory, { withFileTypes: true });
        const voices = await Promise.all(
          entries
            .filter(
              (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
            )
            .map(async (entry) => {
              // Incomplete folders and external symlinks are never offered as voices.
              try {
                return await this.get(
                  userId,
                  `${base}/${entry.name}/voice.wav`,
                );
              } catch {
                return null;
              }
            }),
        );
        return voices.filter((voice): voice is Voice => voice !== null);
      }),
    );
    return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
  }

  async readAudio(userId: string, input: string) {
    const voice = await this.get(userId, input);
    const audio = await readFile(await filePath(this.root, voice.audioPath));
    wavMetadata(audio);
    return { audio, text: voice.text };
  }

  async readAudioById(userId: string, id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new ThreadError('FILE_NOT_FOUND', 404);
    // Personal voices take precedence if manually created folders share an ID.
    for (const base of [this.personal(userId), '.audios']) {
      try {
        await filePath(this.root, `${base}/${id}`);
      } catch (error) {
        if (!missing(error)) throw error;
        continue;
      }
      // An existing but broken voice is an error, not a provider voice preset.
      return this.readAudio(userId, `${base}/${id}/voice.wav`);
    }
    throw new ThreadError('FILE_NOT_FOUND', 404);
  }

  isVoicePath(input: string) {
    return input.split(/[\\/]/).includes('.audios');
  }

  async create(
    userId: string,
    input: z.input<typeof createVoiceSchema>,
    audio: Buffer,
  ) {
    const data = createVoiceSchema.parse(input);
    this.personal(userId);
    wavMetadata(audio);
    if (audio.length > maxReferenceAudioBytes)
      throw new ThreadError('AUDIO_TOO_LARGE', 413);
    const base = data.shared ? '.audios' : this.personal(userId);
    const directory = await this.ensureDirectory(base);
    const id = randomUUID();
    const staging = join(directory, `.pending-${id}`);
    await mkdir(staging);
    try {
      await Promise.all([
        writeFile(join(staging, 'voice.wav'), audio, { flag: 'wx' }),
        writeFile(join(staging, 'voice.txt'), data.text, { flag: 'wx' }),
        writeFile(
          join(staging, 'voice.json'),
          JSON.stringify({
            name: data.name,
            description: data.description,
            createdBy: userId,
          }),
          { flag: 'wx' },
        ),
      ]);
      await rename(staging, join(directory, id));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return this.get(userId, `${base}/${id}/voice.wav`);
  }

  private async serialize<T>(id: string, operation: () => Promise<T>) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  async update(userId: string, input: z.input<typeof updateVoiceSchema>) {
    const data = updateVoiceSchema.parse(input);
    const { path } = this.scope(userId, data.audioPath);
    return this.serialize(basename(dirname(path)), async () => {
      const voice = await this.get(userId, path);
      if (!voice.canEdit) throw new ThreadError('FORBIDDEN', 403);
      if (voice.shared && !data.shared)
        throw new ThreadError('AUDIO_SHARING_PERMANENT', 409);
      const source = await filePath(this.root, dirname(path));
      const base = data.shared ? '.audios' : this.personal(userId);
      const targetBase = await this.ensureDirectory(base);
      const destination = join(targetBase, voice.id);
      if (voice.shared !== data.shared) {
        if (
          await lstat(destination).then(
            () => true,
            (error) => {
              if (missing(error)) return false;
              throw error;
            },
          )
        )
          throw new ThreadError('FILE_EXISTS', 409);
      }
      // Replace files rather than following links inserted into an existing voice folder.
      const suffix = randomUUID();
      const textTemp = join(source, `.text-${suffix}`);
      const metaTemp = join(source, `.meta-${suffix}`);
      try {
        await writeFile(textTemp, data.text, { flag: 'wx' });
        await writeFile(
          metaTemp,
          JSON.stringify({
            name: data.name,
            description: data.description,
            createdBy: userId,
          }),
          { flag: 'wx' },
        );
        await rename(textTemp, join(source, 'voice.txt'));
        await rename(metaTemp, join(source, 'voice.json'));
        if (voice.shared !== data.shared) await rename(source, destination);
      } finally {
        await Promise.all([
          rm(textTemp, { force: true }),
          rm(metaTemp, { force: true }),
        ]);
      }
      return this.get(userId, `${base}/${voice.id}/voice.wav`);
    });
  }

  async remove(userId: string, input: string) {
    const { path } = this.scope(userId, input);
    return this.serialize(basename(dirname(path)), async () => {
      const voice = await this.get(userId, path);
      if (!voice.canEdit) throw new ThreadError('FORBIDDEN', 403);
      await rm(await filePath(this.root, dirname(path)), { recursive: true });
    });
  }
}
