export const RETRY_STATES = Object.freeze({
  idle: 'idle', waiting: 'waiting', retrying: 'retrying', continued: 'continued', switched: 'switched', exhausted: 'exhausted'
});

export function backoffSeconds(attempt, base = 8, cap = 120) {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

export function createRetryController({ maxAttempts = 4, baseDelay = 8, jitter = 0.2, now = () => Date.now() } = {}) {
  let attempt = 0;
  let state = RETRY_STATES.idle;
  let nextAt = null;
  let reason = null;

  return {
    get snapshot() { return { attempt, maxAttempts, state, nextAt, reason }; },
    fail(message = 'Selected model is at capacity') {
      reason = message;
      if (attempt >= maxAttempts) { state = RETRY_STATES.exhausted; nextAt = null; return this.snapshot; }
      attempt += 1;
      const seconds = Math.round(backoffSeconds(attempt, baseDelay) * (1 + jitter));
      nextAt = now() + seconds * 1000;
      state = RETRY_STATES.waiting;
      return this.snapshot;
    },
    markRetrying() { state = RETRY_STATES.retrying; return this.snapshot; },
    markContinued() { state = RETRY_STATES.continued; nextAt = null; return this.snapshot; },
    markSwitched() { state = RETRY_STATES.switched; nextAt = null; return this.snapshot; },
    reset() { attempt = 0; state = RETRY_STATES.idle; nextAt = null; reason = null; return this.snapshot; }
  };
}

export function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
