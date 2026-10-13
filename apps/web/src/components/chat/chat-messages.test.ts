import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { UIMessage } from 'ai';
import { reconcileThreadMessages } from '@aime/shared/thread-messages';
import { overlappingMessages } from '../../../../../scripts/fixtures/thread-message-overlap.js';
import { ChatMessages } from './chat-messages';
import { i18nOptions } from '@/i18n/config';

const i18n = createInstance();
await i18n.init({ ...i18nOptions, lng: 'en' });
const render = (messages: UIMessage[], running: boolean) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ChatMessages, {
        messages,
        running,
        activeMessageId: running ? (messages.at(-1)?.id ?? null) : null,
      }),
    ),
  );

test('real chat rendering groups overlapping snapshots once and reveals interrupted text after cancellation', () => {
  const { persisted, draft } = overlappingMessages();
  const live = render([persisted, draft], true);
  assert.equal(live.split('Intermediate findings').length - 1, 1);
  assert.equal(
    live.split(i18n.t('chat.toolGroup', { count: 9 })).length - 1,
    1,
  );
  assert.ok(!live.includes('Not saved yet'));

  const stopped = reconcileThreadMessages([draft], [persisted], [draft.id]);
  const html = render(stopped, false);
  assert.equal(
    html.split(i18n.t('chat.toolGroup', { count: 9 })).length - 1,
    1,
  );
  assert.equal(html.split('Intermediate findings').length - 1, 1);
  assert.equal(html.split('Not saved yet').length - 1, 1);
  assert.ok(html.includes('src="/unsaved.png"'));
});
