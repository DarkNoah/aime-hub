import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { requestWebResource, webUrl } from '../../web/request.js';

const policySchema = z.object({
  upload_dir: z.string().min(1),
  upload_host: z.string(),
  oss_access_key_id: z.string().min(1),
  signature: z.string().min(1),
  policy: z.string().min(1),
  x_oss_object_acl: z.string().min(1),
  x_oss_forbid_overwrite: z.string().min(1),
  max_file_size_mb: z.coerce.number().positive(),
});

export async function uploadToAlibabaOss(
  rawPolicy: unknown,
  options: {
    data: Uint8Array;
    fileName: string;
    mimeType: string;
    abortSignal?: AbortSignal;
  },
  request = requestWebResource,
) {
  const signal = options.abortSignal ?? AbortSignal.timeout(120_000);
  signal.throwIfAborted();
  const policy = policySchema.parse(rawPolicy);
  const host = webUrl(policy.upload_host);
  if (host.protocol !== 'https:')
    throw new Error('Invalid Alibaba upload host');
  if (
    !options.data.byteLength ||
    options.data.byteLength > policy.max_file_size_mb * 1024 * 1024
  )
    throw new Error('File exceeds the Alibaba upload policy size limit');
  const name = `${randomUUID()}-${path.basename(options.fileName)}`;
  const key = `${policy.upload_dir.replace(/\/+$/, '')}/${name}`;
  const form = new FormData();
  for (const [field, value] of Object.entries({
    OSSAccessKeyId: policy.oss_access_key_id,
    Signature: policy.signature,
    policy: policy.policy,
    'x-oss-object-acl': policy.x_oss_object_acl,
    'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite,
    key,
    success_action_status: '200',
    'x-oss-content-type': options.mimeType,
  }))
    form.append(field, value);
  // OSS requires the file to be the last multipart field.
  form.append(
    'file',
    new Blob([new Uint8Array(options.data)], { type: options.mimeType }),
    name,
  );
  const encoded = new Request(host, { method: 'POST', body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  signal.throwIfAborted();
  const response = await request(host.href, {
    method: 'POST',
    signal,
    timeoutMs: 120_000,
    maxBytes: 1_000_000,
    headers: { 'content-type': encoded.headers.get('content-type')! },
    body,
  });
  signal.throwIfAborted();
  if (response.status !== 200)
    throw new Error(
      `Alibaba temporary upload failed (HTTP ${response.status})`,
    );
  return `oss://${key}`;
}
