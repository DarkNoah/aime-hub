import type { SpeechCallbacks, SpeechProgress } from './moonshine-runtime';

export type SpeechSession = {
  load: (language: 'zh' | 'en') => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  dispose: () => void;
};
export type SpeechInputState = {
  status: 'idle' | 'loading' | 'starting' | 'listening' | 'stopping';
  progress?: SpeechProgress;
};

export class SpeechInputController {
  private state: SpeechInputState = { status: 'idle' };
  private listeners = new Set<() => void>();
  private session?: SpeechSession;
  private stopping?: Promise<boolean>;

  constructor(
    private readonly language: 'zh' | 'en',
    private readonly createSession: (
      callbacks: SpeechCallbacks,
    ) => SpeechSession,
    private readonly onText: (text: string) => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(state: SpeechInputState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  async start(draft: string) {
    if (this.session) return;
    const lines = new Map<string, string>();
    const session = this.createSession({
      onProgress: (progress) => {
        if (this.session === session)
          this.update({ status: 'loading', progress });
      },
      onLine: (id, text) => {
        if (this.session !== session) return;
        lines.set(id, text.trim());
        const transcript = [...lines.values()]
          .filter(Boolean)
          .join(this.language === 'zh' ? '' : ' ');
        const separator = draft && transcript && !/\s$/.test(draft) ? ' ' : '';
        this.onText(`${draft}${separator}${transcript}`);
      },
      onError: (error) => this.fail(session, error),
    });
    this.session = session;
    this.update({ status: 'loading' });
    try {
      await session.load(this.language);
      if (this.session !== session) return;
      this.update({ status: 'starting' });
      await session.start();
      if (this.session === session) this.update({ status: 'listening' });
    } catch (error) {
      this.fail(session, error);
    }
  }

  private fail(session: SpeechSession, error: unknown) {
    if (this.session !== session) return;
    this.cancel();
    this.onError(error);
  }

  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    const session = this.session;
    if (!session) return Promise.resolve(true);
    if (this.state.status !== 'listening') {
      this.cancel();
      return Promise.resolve(true);
    }
    this.update({ status: 'stopping' });
    const stopping = session
      .stop()
      .then(
        () => {
          if (this.session !== session) return false;
          this.session = undefined;
          this.update({ status: 'idle' });
          return true;
        },
        (error) => {
          this.fail(session, error);
          return false;
        },
      )
      .finally(() => {
        if (this.stopping === stopping) this.stopping = undefined;
      });
    this.stopping = stopping;
    return stopping;
  }

  // Cancellation deliberately ignores late transcript/permission/download events.
  // The text already visible in the composer is retained.
  cancel = () => {
    if (!this.session && this.state.status === 'idle') return;
    const session = this.session;
    this.session = undefined;
    this.stopping = undefined;
    session?.dispose();
    this.update({ status: 'idle' });
  };
}
