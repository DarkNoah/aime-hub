export async function uploadAvatar(file: File) {
  const body = new FormData();
  body.set('file', file);
  const response = await fetch('/api/profile/avatar', {
    method: 'POST',
    credentials: 'same-origin',
    body,
  });
  const result = await response.json();
  if (!response.ok) throw { status: response.status, code: result.code };
  if (typeof result.url !== 'string') throw new Error('Missing avatar URL');
  return result.url as string;
}
