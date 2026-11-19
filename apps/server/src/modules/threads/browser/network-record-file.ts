import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  NetworkRequestDetail,
  NetworkRequestSummary,
} from './network-store.js';

const maxDetailBytes = 512 * 1024;
const maxSummaryBytes = 64 * 1024;
const overhead = 28; // AES-GCM nonce and authentication tag.
const currentName =
  /^(\d+)-([a-f0-9]{64})-([a-f0-9]{32})-([a-f0-9]{32})-([a-f0-9-]{36})$/;
export const legacyRecordName = /^(\d+)-[a-f0-9]{64}-[a-f0-9-]{36}$/;

export function parseNetworkRecordName(name: string) {
  const match = currentName.exec(name);
  if (!match) return;
  return {
    name,
    startedAt: Number(match[1]),
    scopeTag: match[2],
    serviceTag: match[3],
    threadTag: match[4],
    id: match[5],
  };
}
export type NetworkRecordFile = NonNullable<
  ReturnType<typeof parseNetworkRecordName>
>;

export function networkRequestSummary({
  id,
  captureId,
  startedAt,
  url,
  method,
  resourceType,
  state,
  status,
  durationMs,
  redirectedFrom,
}: NetworkRequestDetail): NetworkRequestSummary {
  return {
    id,
    captureId,
    startedAt,
    url,
    method,
    resourceType,
    state,
    status,
    durationMs,
    redirectedFrom,
  };
}

async function readBytes(file: FileHandle, start: number, length: number) {
  const bytes = Buffer.allocUnsafe(length);
  let count = 0;
  while (count < length) {
    const { bytesRead } = await file.read(
      bytes,
      count,
      length - count,
      start + count,
    );
    if (!bytesRead) throw new Error('Incomplete record');
    count += bytesRead;
  }
  return bytes;
}

export class NetworkRecordIntegrityError extends Error {
  constructor() {
    super('Network record failed integrity verification');
  }
}

export class NetworkRecordCodec {
  private readonly encryptionKey: Buffer;
  private readonly tagKey: Buffer;
  readonly serviceTag: string;

  constructor(secret?: string) {
    const keys = Buffer.from(
      hkdfSync(
        'sha256',
        secret ?? randomBytes(32),
        '',
        'browser-network-history-v1',
        64,
      ),
    );
    this.encryptionKey = keys.subarray(0, 32);
    this.tagKey = keys.subarray(32);
    this.serviceTag = this.tag('service', '').slice(0, 32);
  }

  private tag(purpose: string, data: string) {
    return createHmac('sha256', this.tagKey)
      .update(purpose)
      .update('\0')
      .update(data)
      .digest('hex');
  }

  threadTag(id: string) {
    return this.tag('thread', id).slice(0, 32);
  }
  scopeTag(scope: string) {
    return this.tag('scope', scope);
  }

  private encrypt(value: object, aad: string, limit: number) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > limit)
      throw new Error('Network record is too large');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([
      cipher.update(json, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  encode(name: string, record: NetworkRequestDetail) {
    // The authenticated filename binds the scope, request ID and original expiry.
    const head = this.encrypt(
      networkRequestSummary(record),
      'summary:' + name,
      maxSummaryBytes,
    );
    const detail = this.encrypt(record, 'detail:' + name, maxDetailBytes);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(head.length);
    return Buffer.concat([length, head, detail]);
  }

  // Both sections are published by one rename. Listing only decrypts the short summary.
  async read(
    root: string,
    name: string,
    section: 'summary' | 'detail',
  ): Promise<NetworkRequestDetail> {
    const file = await open(
      join(root, name, 'record.bin'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOOP' || error.code === 'ENOTDIR')
        throw new NetworkRecordIntegrityError();
      throw error;
    });
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 4 + maxSummaryBytes + maxDetailBytes + 2 * overhead
      )
        throw new Error('Invalid file');
      const headLength = (await readBytes(file, 0, 4)).readUInt32BE();
      const detailLength = info.size - 4 - headLength;
      if (
        headLength <= overhead ||
        headLength > maxSummaryBytes + overhead ||
        detailLength <= overhead ||
        detailLength > maxDetailBytes + overhead
      )
        throw new Error('Invalid record');
      const data =
        section === 'summary'
          ? await readBytes(file, 4, headLength)
          : await readBytes(file, 4 + headLength, detailLength);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        data.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(section + ':' + name));
      decipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString('utf8'),
      );
    } catch {
      throw new NetworkRecordIntegrityError();
    } finally {
      await file.close();
    }
  }

  dispose() {
    this.encryptionKey.fill(0);
    this.tagKey.fill(0);
  }
}
