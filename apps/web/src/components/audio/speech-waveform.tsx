import { useEffect } from 'react';
import {
  motion,
  type MotionValue,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { cn } from '@/lib/utils';

const BANDS = 15;
const REST = 0.08;
const BAR_INDICES = Array.from({ length: BANDS * 2 - 1 }, (_, index) => index);

function WaveformBar({
  levels,
  index,
}: {
  levels: MotionValue<number[]>;
  index: number;
}) {
  const band = Math.abs(index - (BANDS - 1));
  const taper = 1 - (band / (BANDS - 1)) * 0.45;
  const scaleY = useTransform(levels, (value) =>
    Math.max(REST, value[band] * taper),
  );
  return (
    <motion.span
      className="h-full min-w-0 max-w-[3px] flex-1 rounded-full bg-primary"
      style={{ scaleY, opacity: 0.4 + taper * 0.6 }}
    />
  );
}

/** A decorative view of the existing playback graph; never opens a microphone. */
export function SpeechWaveform({
  playing,
  readSpectrum,
  className,
}: {
  playing: boolean;
  readSpectrum: (levels: Float32Array) => void;
  className?: string;
}) {
  const reducedMotion = useReducedMotion();
  const levels = useMotionValue<number[]>(Array(BANDS).fill(REST));

  useEffect(() => {
    const reset = () => levels.set(Array(BANDS).fill(REST));
    if (!playing || reducedMotion) {
      reset();
      return;
    }
    const spectrum = new Float32Array(BANDS);
    let frame = 0;
    let previousTime = 0;
    const tick = (time: number) => {
      const elapsed = previousTime ? Math.min(time - previousTime, 64) : 16;
      previousTime = time;
      readSpectrum(spectrum);
      const previous = levels.get();
      // Fast attack and gentle release follow syllables without a bouncy spring.
      levels.set(
        Array.from(spectrum, (energy, index) => {
          const target = REST + (1 - REST) * energy;
          const smoothing =
            1 - Math.exp(-elapsed / (target > previous[index] ? 40 : 140));
          return previous[index] + (target - previous[index]) * smoothing;
        }),
      );
      frame = requestAnimationFrame(tick);
    };
    const onVisibilityChange = () => {
      cancelAnimationFrame(frame);
      previousTime = 0;
      reset();
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [levels, playing, readSpectrum, reducedMotion]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex h-7 min-w-0 items-center justify-center gap-0.5',
        className,
      )}
    >
      {BAR_INDICES.map((index) => (
        <WaveformBar key={index} index={index} levels={levels} />
      ))}
    </div>
  );
}
