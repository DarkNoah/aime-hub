import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// ffmpeg-static exports a CommonJS value but declares an ESM default export.
// Validate the runtime value so NodeNext also sees the actual string/null type.
const ffmpegBinary: unknown = ffmpegStatic;
export const ffmpegPath =
  typeof ffmpegBinary === 'string' ? ffmpegBinary : null;
export const ffprobePath = ffprobeStatic.path;
