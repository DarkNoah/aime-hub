import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SpeechInputController,
  type SpeechSession,
} from '../apps/web/src/components/audio/speech-input-controller.js';
import type { SpeechCallbacks } from '../apps/web/src/components/audio/moonshine-runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(language: 'zh' | 'en' = 'en') {
  const sessions: {
    callbacks: SpeechCallbacks;
    session: SpeechSession;
    disposed: number;
    started: number;
  }[] = [];
  const text: string[] = [];
  const errors: unknown[] = [];
  const controller = new SpeechInputController(
    language,
    (callbacks) => {
      const item = {
        callbacks,
        disposed: 0,
        started: 0,
        session: {
          load: async () => {},
          start: async () => {
            item.started++;
          },
          stop: async () => {
            item.session.dispose();
          },
          dispose: () => {
            item.disposed++;
          },
        },
      };
      sessions.push(item);
      return item.session;
    },
    (value) => text.push(value),
    (error) => errors.push(error),
  );
  return { controller, sessions, text, errors };
}

test('interim corrections replace the same line and completed lines are not duplicated', async () => {
  const { controller, sessions, text } = setup();
  await controller.start('Existing draft');
  const { callbacks } = sessions[0];
  callbacks.onLine('90071992547409930', 'hello');
  callbacks.onLine('90071992547409930', 'Hello world.');
  callbacks.onLine('90071992547409930', 'Hello world.');
  callbacks.onLine('90071992547409931', 'Next sentence.');
  assert.equal(text.at(-1), 'Existing draft Hello world. Next sentence.');
});

test('Chinese recognition keeps existing whitespace and does not add spaces between phrases', async () => {
  const { controller, sessions, text } = setup('zh');
  await controller.start('原有草稿\n');
  sessions[0].callbacks.onLine('1', '你好，');
  sessions[0].callbacks.onLine('2', '世界。');
  assert.equal(text.at(-1), '原有草稿\n你好，世界。');
});

test('cancelling pending microphone permission ignores stale callbacks', async () => {
  const { controller, sessions, text, errors } = setup();
  const loading = deferred();
  const pending = controller.start('Keep this');
  // start() has already entered load(); hold start() instead to model a pending permission.
  sessions[0].session.start = () => loading.promise;
  await Promise.resolve();
  assert.equal(controller.getSnapshot().status, 'starting');
  controller.cancel();
  sessions[0].callbacks.onProgress({ loaded: 10, total: 100 });
  sessions[0].callbacks.onLine('1', 'late words');
  sessions[0].callbacks.onError(new Error('late error'));
  loading.resolve();
  await pending;
  assert.equal(controller.getSnapshot().status, 'idle');
  assert.equal(sessions[0].disposed, 1);
  assert.deepEqual(text, []);
  assert.deepEqual(errors, []);
});

test('download cancellation is immediate and a retry owns its own callbacks', async () => {
  const { controller, sessions, text } = setup();
  const pending = controller.start('First');
  await controller.stop();
  await pending;
  assert.equal(sessions[0].started, 0);
  await controller.start('Second');
  sessions[0].callbacks.onLine('1', 'obsolete');
  sessions[1].callbacks.onProgress({ loaded: 50, total: 100 });
  assert.deepEqual(controller.getSnapshot().progress, {
    loaded: 50,
    total: 100,
  });
  sessions[1].callbacks.onLine('1', 'current');
  assert.equal(text.at(-1), 'Second current');
});

test('stop flushes the final words once before allowing send', async () => {
  const { controller, sessions, text } = setup();
  await controller.start('Draft');
  const gate = deferred();
  let stops = 0;
  sessions[0].session.stop = async () => {
    stops++;
    await gate.promise;
    sessions[0].callbacks.onLine('1', 'final words');
  };
  const first = controller.stop();
  const second = controller.stop();
  assert.equal(first, second);
  assert.equal(controller.getSnapshot().status, 'stopping');
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(stops, 1);
  assert.equal(text.at(-1), 'Draft final words');
  assert.equal(controller.getSnapshot().status, 'idle');
});

test('switching chat or editing during flush suppresses resubmission and late text', async () => {
  const { controller, sessions, text } = setup();
  await controller.start('Old chat');
  const gate = deferred();
  sessions[0].session.stop = async () => {
    await gate.promise;
    sessions[0].callbacks.onLine('1', 'wrong destination');
  };
  const stopped = controller.stop();
  controller.cancel();
  gate.resolve();
  assert.equal(await stopped, false);
  assert.deepEqual(text, []);
});

test('failure releases resources, keeps the last text, and permits retry', async () => {
  const { controller, sessions, text, errors } = setup();
  await controller.start('Draft');
  sessions[0].callbacks.onLine('1', 'kept');
  const error = new Error('Microphone ended');
  sessions[0].callbacks.onError(error);
  sessions[0].callbacks.onError(error);
  assert.equal(sessions[0].disposed, 1);
  assert.deepEqual(errors, [error]);
  assert.equal(text.at(-1), 'Draft kept');
  await controller.start(text.at(-1)!);
  assert.equal(controller.getSnapshot().status, 'listening');
});
