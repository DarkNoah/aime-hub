export function canCaptureScreenshot() {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}

/** Capture one frame, then release the display before encoding the attachment. */
export async function captureScreenshot({
  signal,
  maxBytes = Infinity,
}: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<File | null> {
  signal?.throwIfAborted();
  if (!canCaptureScreenshot())
    throw new Error('Screen capture is unavailable in this browser or context');

  let stream: MediaStream;
  try {
    // Keep this before any await: the picker requires a user gesture.
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: true,
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'NotAllowedError' || error.name === 'AbortError')
    )
      return null;
    throw error;
  }

  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  video.muted = true;
  video.playsInline = true;
  try {
    signal?.throwIfAborted();
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended')
      throw new Error('Screen capture ended before a frame was available');
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timeout);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        track.removeEventListener('ended', failed);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new Error('Could not read the screen frame'));
      const aborted = () => finish(signal?.reason);
      const timeout = setTimeout(failed, 15_000);
      video.addEventListener('loadeddata', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      track.addEventListener('ended', failed, { once: true });
      signal?.addEventListener('abort', aborted, { once: true });
      video.srcObject = stream;
      void video.play().catch(finish);
    });
    signal?.throwIfAborted();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height)
      throw new Error('The screen frame is empty');
    context.drawImage(video, 0, 0);
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.pause();
    video.srcObject = null;
  }

  return imageFileFromCanvas(canvas, {
    signal,
    maxBytes,
    name: `screenshot-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.png`,
  });
}

/** Keep the image within the attachment limit after cropping, at original resolution. */
export async function imageFileFromCanvas(
  canvas: HTMLCanvasElement,
  {
    name,
    signal,
    maxBytes = Infinity,
  }: {
    name: string;
    signal?: AbortSignal;
    maxBytes?: number;
  },
): Promise<File> {
  signal?.throwIfAborted();
  const encode = (source: HTMLCanvasElement, type: string, quality?: number) =>
    new Promise<Blob>((resolve, reject) => {
      source.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error('Could not encode screenshot')),
        type,
        quality,
      );
    });
  let blob = await encode(canvas, 'image/png');
  // Keep normal screenshots lossless. Large displays still need an inline image,
  // rather than silently becoming a path-only attachment in ChatUploadQueue.
  for (let attempt = 0; blob.size > maxBytes && attempt < 8; attempt++) {
    signal?.throwIfAborted();
    const resized = document.createElement('canvas');
    const scale = 0.75 ** attempt;
    resized.width = Math.max(1, Math.round(canvas.width * scale));
    resized.height = Math.max(1, Math.round(canvas.height * scale));
    const context = resized.getContext('2d');
    if (!context) throw new Error('Could not resize screenshot');
    context.drawImage(canvas, 0, 0, resized.width, resized.height);
    blob = await encode(resized, 'image/jpeg', 0.85);
  }
  signal?.throwIfAborted();
  if (blob.size > maxBytes) throw new Error('Screenshot is too large');
  const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
  return new File([blob], `${name.replace(/\.[^.]+$/, '')}.${extension}`, {
    lastModified: Date.now(),
    type: blob.type,
  });
}
