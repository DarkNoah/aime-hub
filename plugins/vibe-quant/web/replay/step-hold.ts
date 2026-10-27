export type ReplayStepDirection = -1 | 1;

/** Share one timer between keyboard and pointer; native key repeat cannot double ticks. */
export function createReplayStepHold(
  step: (direction: ReplayStepDirection) => void,
  intervalMs: number,
) {
  let owner: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function stop(source?: string) {
    if (source !== undefined && source !== owner) return;
    owner = null;
    clearTimeout(timer);
    timer = undefined;
  }
  function start(source: string, direction: ReplayStepDirection) {
    if (source === owner) return;
    stop();
    owner = source;
    step(direction);
    const repeat = () => {
      if (owner !== source) return;
      step(direction);
      if (owner === source) timer = setTimeout(repeat, intervalMs);
    };
    if (owner === source) timer = setTimeout(repeat, Math.max(400, intervalMs));
  }
  return { start, stop };
}
