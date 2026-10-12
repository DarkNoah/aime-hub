export const maxImageBytes = 20_000_000;

/** Accept raster image bytes, never an upstream HTML/error body or executable SVG. */
export function imageMimeType(
  data: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' {
  const header = Buffer.from(data.subarray(0, 12));
  if (data.length > maxImageBytes) throw new Error('Image is too large');
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255)
    return 'image/jpeg';
  if (
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  throw new Error('Unsupported image format');
}

export function imageBase64(value: string) {
  if (
    !value ||
    value.length > Math.ceil(maxImageBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    value.length % 4 === 1
  )
    throw new Error('Invalid image data');
  const data = Buffer.from(value, 'base64');
  imageMimeType(data);
  return data;
}
