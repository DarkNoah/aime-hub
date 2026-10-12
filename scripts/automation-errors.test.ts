import assert from 'node:assert/strict';
import test from 'node:test';
import { automationErrorKey } from '../apps/web/src/components/automations/errors.js';

test('automation service and unknown failures never use the chat reply fallback', () => {
  for (const error of ['INTERNAL_ERROR', { code: 'INTERNAL_ERROR' }])
    assert.equal(automationErrorKey(error), 'errors.server');
  for (const error of [
    undefined,
    new Error('Request failed'),
    'UNKNOWN_FAILURE',
    { code: 'NOT_IMPLEMENTED' },
  ])
    assert.equal(automationErrorKey(error), 'errors.generic');
});

test('automation errors preserve actionable authentication, network and configuration messages', () => {
  const cases = {
    UNAUTHORIZED: 'errors.sessionExpired',
    FORBIDDEN: 'errors.forbidden',
    MODEL_NOT_CONFIGURED: 'chat.errors.noModel',
    AGENT_NOT_FOUND: 'agents.selectionUnavailable',
    AUTOMATION_RUN_FAILED: 'automations.runFailed',
    AUTOMATION_CRON_INVALID: 'automations.invalidCron',
  };
  for (const [code, key] of Object.entries(cases)) {
    assert.equal(automationErrorKey(code), key);
    assert.equal(automationErrorKey({ code }), key);
  }
  assert.equal(
    automationErrorKey(new TypeError('fetch failed')),
    'errors.network',
  );
});
