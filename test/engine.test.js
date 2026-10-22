import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffSeconds, createRetryController, formatRemaining, RETRY_STATES } from '../src/engine.js';

test('backoff doubles and caps', () => {
  assert.equal(backoffSeconds(1, 8, 120), 8);
  assert.equal(backoffSeconds(4, 8, 120), 64);
  assert.equal(backoffSeconds(8, 8, 120), 120);
});

test('controller moves to waiting and exhausts after max attempts', () => {
  const c = createRetryController({ maxAttempts: 2, baseDelay: 1, jitter: 0, now: () => 1000 });
  assert.equal(c.fail().state, RETRY_STATES.waiting);
  assert.equal(c.snapshot.attempt, 1);
  assert.equal(c.fail().state, RETRY_STATES.waiting);
  assert.equal(c.fail().state, RETRY_STATES.exhausted);
});

test('formatRemaining is stable', () => assert.equal(formatRemaining(61000), '01:01'));
