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
  delayMs = 0,
  onCountdown,
}: {
  signal?: AbortSignal;
  maxBytes?: number;
  delayMs?: number;
  onCountdown?: (seconds: number) => void;
} = {}): Promise<File | null> {
  signal?.throwIfAborted();
  if (!Number.isFinite(delayMs) || delayMs < 0)
    throw new Error('Screen capture delay must be a non-negative duration');
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
    if (delayMs > 0) {
      // Start only after the picker resolves. Attach the video afterwards so
      // loadeddata is a fresh frame of the screen after the countdown.
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + delayMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          track.removeEventListener('ended', ended);
          onCountdown?.(0);
          if (error) reject(error);
          else resolve();
        };
        const aborted = () => finish(signal?.reason);
        const ended = () =>
          finish(new Error('Screen capture ended during countdown'));
        const tick = () => {
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            finish();
            return;
          }
          onCountdown?.(Math.ceil(remaining / 1000));
          if (!settled) timer = setTimeout(tick, Math.min(1000, remaining));
        };
        signal?.addEventListener('abort', aborted, { once: true });
        track.addEventListener('ended', ended, { once: true });
        tick();
      });
    }
    signal?.throwIfAborted();
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
