import type { NotificationSound } from '@aime/shared/notifications';

type SoundResult = 'played' | 'blocked' | 'skipped';
type AudioState = {
  context: AudioContext;
  nodes: Set<OscillatorNode>;
  nextTime: number;
};
let audio: AudioState | undefined;
const frequencies: Record<NotificationSound, readonly number[]> = {
  entry: [660, 880, 660, 880, 660, 880],
  exit: [880, 660, 880, 660, 880, 660],
};
const noteSpacing = 0.32;
const noteDuration = 0.28;
const peakGain = 0.24;
const freshFor = 30_000;

function audioConstructor() {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}
export const notificationSoundSupported = () => !!audioConstructor();

function clearNotes(state: AudioState) {
  for (const node of state.nodes) {
    try {
      node.stop();
    } catch {
      /* Already ended. */
    }
  }
  state.nodes.clear();
  state.nextTime = 0;
}

/** Call from a user gesture; browsers may keep resume() pending without one. */
export async function enableNotificationSound(): Promise<boolean> {
  try {
    const Constructor = audioConstructor();
    if (!Constructor) return false;
    if (!audio || audio.context.state === 'closed') {
      const state: AudioState = {
        context: new Constructor(),
        nodes: new Set(),
        nextTime: 0,
      };
      state.context.addEventListener('statechange', () => {
        // Do not replay queued tones after a browser suspends the audio clock.
        if (state.context.state !== 'running') clearNotes(state);
      });
      audio = state;
    }
    const context = audio.context;
    if (context.state === 'running') return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        context.resume().then(() => context.state === 'running'),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 800);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function playTone(sound: NotificationSound): SoundResult {
  const state = audio;
  if (!state || state.context.state !== 'running') return 'blocked';
  const { context } = state;
  // Keep reversal exit/entry tones distinct without building a long alarm backlog.
  if (state.nextTime > context.currentTime + 4) return 'skipped';
  const start = Math.max(context.currentTime + 0.01, state.nextTime);
  try {
    frequencies[sound].forEach((frequency, index) => {
      const at = start + index * noteSpacing;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.02);
      gain.gain.setValueAtTime(peakGain, at + 0.17);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + noteDuration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      state.nodes.add(oscillator);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
        state.nodes.delete(oscillator);
      };
      oscillator.start(at);
      oscillator.stop(at + noteDuration + 0.01);
    });
    state.nextTime = start + frequencies[sound].length * noteSpacing + 0.12;
    return 'played';
  } catch {
    clearNotes(state);
    return 'blocked';
  }
}

export async function previewNotificationSound(
  sound: NotificationSound,
): Promise<boolean> {
  return (await enableNotificationSound()) && playTone(sound) === 'played';
}

/** Use an already unlocked audio context for a local, explicitly requested replay. */
export function playNotificationSound(sound: NotificationSound): SoundResult {
  return playTone(sound);
}

/** One authenticated page listener. Web Locks serialize claims across open tabs. */
export function createNotificationSoundSession(userId: string) {
  let disposed = false;
  const key = `notification-sounds:${userId}`;
  const recent = new Map<string, number>();
  const activate = (event: Event) => {
    if (event.isTrusted) void enableNotificationSound();
  };
  document.addEventListener('pointerdown', activate);
  document.addEventListener('keydown', activate);

  const readRecent = () => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (Array.isArray(saved))
        for (const row of saved) {
          if (
            Array.isArray(row) &&
            typeof row[0] === 'string' &&
            typeof row[1] === 'number'
          )
            recent.set(row[0], row[1]);
        }
    } catch {
      /* In-memory deduplication remains available if storage is disabled. */
    }
    for (const [id, time] of recent)
      if (Date.now() - time > freshFor * 2) recent.delete(id);
    while (recent.size > 100) recent.delete(recent.keys().next().value!);
  };
  return {
    async notify(notification: {
      id: string;
      createdAt: string;
      sound?: NotificationSound;
    }): Promise<SoundResult> {
      const time = Date.parse(notification.createdAt);
      if (
        disposed ||
        !notification.sound ||
        !Number.isFinite(time) ||
        Math.abs(Date.now() - time) > freshFor
      )
        return 'skipped';
      const sound = notification.sound;
      const attempt = (): SoundResult => {
        if (disposed || Date.now() - time > freshFor) return 'skipped';
        readRecent();
        if (recent.has(notification.id)) return 'skipped';
        const result = playTone(sound);
        if (result !== 'blocked') {
          recent.set(notification.id, Date.now());
          try {
            localStorage.setItem(key, JSON.stringify([...recent].slice(-100)));
          } catch {
            /* Storage may be disabled. */
          }
        }
        return result;
      };
      if (navigator.locks) {
        try {
          return await navigator.locks.request(key, attempt);
        } catch {
          /* Restricted environments can deny Web Locks. */
        }
      }
      return attempt();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('pointerdown', activate);
      document.removeEventListener('keydown', activate);
      const state = audio;
      audio = undefined;
      if (state) {
        clearNotes(state);
        void state.context.close().catch(() => {});
      }
    },
  };
}
